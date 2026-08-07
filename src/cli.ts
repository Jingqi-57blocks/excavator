#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Audience, BudgetConfig, ChecklistItem, FeatureRequest, InvestigationWorkItem, ReportRequest, SectionClaim, TraceRecord } from "./types.ts";
import { addSourceEvidence, assembleRun, auditRun, beginDocument, checkpointSection, prepareRun, resumeRun, runStatus, searchSourceEvidence, updateChecklist, updateTraces, updateWorkItems } from "./run.ts";
import { stableJson } from "./util.ts";
import { buildCodeGraph, codeGraphStatus } from "./codegraph-command.ts";
import { deriveDefaultBudgets, plannedDocumentCount } from "./budgets.ts";

async function main(): Promise<void> {
  const [command = "help", ...argv] = process.argv.slice(2);
  try {
    switch (command) {
      case "prepare":
      case "report": {
        const request = await requestFromArgs(argv);
        const result = await prepareRun(request);
        print({ runDir: result.runDir, run: result.manifest });
        break;
      }
      case "overview": {
        const args = parseArgs(argv);
        const audience = audiences(args.audience ?? "product");
        const request = baseRequest(args, { overviewAudiences: audience, features: [] });
        const result = await prepareRun(request);
        print({ runDir: result.runDir, run: result.manifest });
        break;
      }
      case "feature": {
        const args = parseArgs(argv);
        const subject = required(args.subject, "--subject");
        const feature: FeatureRequest = { subject, aliases: csv(args.aliases), audiences: audiences(args.audience ?? "product") };
        const request = baseRequest(args, { overviewAudiences: [], features: [feature] });
        const result = await prepareRun(request);
        print({ runDir: result.runDir, run: result.manifest });
        break;
      }
      case "codegraph": {
        const [subcommand = "status", ...rest] = argv;
        const args = parseArgs(rest);
        const target = required(args.target, "--target");
        if (subcommand === "status") print(await codeGraphStatus(target, args.binary ?? "codegraph"));
        else if (subcommand === "build") print(await buildCodeGraph({ target, binary: args.binary, force: args.force === "true", quiet: args.quiet === "true" }));
        else throw new Error(`Unknown codegraph subcommand: ${subcommand}`);
        break;
      }
      case "begin": {
        const args = parseArgs(argv);
        const manifest = await beginDocument(required(args.run, "--run"), required(args.document, "--document"));
        print({ state: manifest.state, document: args.document, startedAt: manifest.documents.find((item) => item.id === args.document)?.startedAt });
        break;
      }
      case "source": {
        const args = parseArgs(argv);
        print(await addSourceEvidence(required(args.run, "--run"), required(args.path, "--path"), Number(required(args.start, "--start")), Number(required(args.end, "--end")), required(args.reason, "--reason")));
        break;
      }
      case "search": {
        const args = parseArgs(argv);
        const terms = args.query ? [args.query] : csv(args.terms);
        print(await searchSourceEvidence(
          required(args.run, "--run"),
          terms,
          required(args.reason, "--reason"),
          { maxResults: args.maxResults ? Number(args.maxResults) : undefined, pathPrefixes: csv(args.pathPrefixes ?? args.pathPrefix), regex: args.regex === "true", caseSensitive: args.caseSensitive === "true" }
        ));
        break;
      }
      case "checkpoint": {
        const args = parseArgs(argv);
        const content = await readFile(required(args.file, "--file"), "utf8");
        let claims: SectionClaim[] | undefined;
        if (args.claims) {
          const raw = JSON.parse(await readFile(args.claims, "utf8")) as SectionClaim[] | { claims: SectionClaim[] };
          claims = Array.isArray(raw) ? raw : raw.claims;
        }
        const manifest = await checkpointSection(required(args.run, "--run"), required(args.document, "--document"), Number(required(args.section, "--section")), content, claims);
        print({ state: manifest.state, document: args.document, section: Number(args.section) });
        break;
      }
      case "checklist": {
        const args = parseArgs(argv);
        const raw = JSON.parse(await readFile(required(args.file, "--file"), "utf8")) as Partial<ChecklistItem>[] | { items: Partial<ChecklistItem>[] };
        const checklist = await updateChecklist(required(args.run, "--run"), Array.isArray(raw) ? raw : raw.items);
        print(checklist);
        break;
      }
      case "workitem": {
        const args = parseArgs(argv);
        const raw = JSON.parse(await readFile(required(args.file, "--file"), "utf8")) as Partial<InvestigationWorkItem>[] | { items: Partial<InvestigationWorkItem>[] };
        print(await updateWorkItems(required(args.run, "--run"), Array.isArray(raw) ? raw : raw.items));
        break;
      }
      case "trace": {
        const args = parseArgs(argv);
        const raw = JSON.parse(await readFile(required(args.file, "--file"), "utf8")) as TraceRecord[] | { traces: TraceRecord[] };
        print(await updateTraces(required(args.run, "--run"), Array.isArray(raw) ? raw : raw.traces));
        break;
      }
      case "assemble": print(await assembleRun(required(parseArgs(argv).run, "--run"))); break;
      case "audit": {
        const args = parseArgs(argv);
        const result = await auditRun(required(args.run, "--run"), args.document ? { documentId: args.document } : {});
        print(result);
        if (result.findings.some((finding) => finding.level === "error")) process.exitCode = 1;
        break;
      }
      case "resume": print(await resumeRun(required(parseArgs(argv).run, "--run"))); break;
      case "status": print(await runStatus(required(parseArgs(argv).run, "--run"))); break;
      case "help":
      case "--help":
      case "-h": console.log(help()); break;
      default: throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    console.error(stableJson({ error: (error as Error).message, stack: process.env.EXCAVATOR_DEBUG ? (error as Error).stack : undefined }));
    process.exitCode = 1;
  }
}

async function requestFromArgs(argv: string[]): Promise<ReportRequest> {
  const args = parseArgs(argv);
  if (args.request) {
    const raw = JSON.parse(await readFile(args.request, "utf8")) as Partial<ReportRequest>;
    return normalizeRequest(raw, args);
  }
  const overviewAudiences = csv(args.overview).flatMap((item) => audiences(item));
  const featureSubjects = listArgs(argv, "--feature");
  const aliasesList = listArgs(argv, "--feature-aliases");
  const featureAudienceList = listArgs(argv, "--feature-audience");
  const features = featureSubjects.map((subject, index) => ({
    subject,
    aliases: csv(aliasesList[index] ?? ""),
    audiences: audiences(featureAudienceList[index] ?? args.featureAudience ?? "product")
  }));
  return baseRequest(args, { overviewAudiences, features });
}

function normalizeRequest(raw: Partial<ReportRequest>, args: Record<string, string>): ReportRequest {
  const overviewAudiences = (raw.overviewAudiences ?? []).flatMap((value) => audiences(String(value)));
  const features = (raw.features ?? []).map((feature) => ({ subject: feature.subject, aliases: feature.aliases ?? [], audiences: feature.audiences?.flatMap((value) => audiences(String(value))) ?? ["product"] }));
  return {
    target: resolve(String(raw.target ?? required(args.target, "target"))),
    codegraph: raw.codegraph ? resolve(String(raw.codegraph)) : args.codegraph ? resolve(args.codegraph) : undefined,
    codegraphMode: args.noCodegraph === "true" ? "off" : raw.codegraphMode ?? "auto",
    language: String(raw.language ?? args.language ?? "en-US"),
    detailLevel: raw.detailLevel === "standard" || args.detail === "standard" ? "standard" : "detailed",
    workdir: resolve(String(raw.workdir ?? args.workdir ?? ".excavator-work")),
    overviewAudiences,
    features,
    budgets: { ...defaultBudgets({ overviewAudiences, features }), ...(raw.budgets ?? {}), ...budgetOverrides(args) }
  };
}

function baseRequest(args: Record<string, string>, docs: Pick<ReportRequest, "overviewAudiences" | "features">): ReportRequest {
  return {
    target: resolve(required(args.target, "--target")),
    codegraph: args.codegraph ? resolve(args.codegraph) : undefined,
    codegraphMode: args.noCodegraph === "true" ? "off" : "auto",
    language: args.language ?? "en-US",
    detailLevel: args.detail === "standard" ? "standard" : "detailed",
    workdir: resolve(args.workdir ?? ".excavator-work"),
    ...docs,
    budgets: { ...defaultBudgets(docs), ...budgetOverrides(args) }
  };
}

function defaultBudgets(docs: Pick<ReportRequest, "overviewAudiences" | "features">): BudgetConfig {
  return deriveDefaultBudgets(plannedDocumentCount(docs.overviewAudiences, docs.features), docs.features.length);
}

function budgetOverrides(args: Record<string, string>): Partial<BudgetConfig> {
  const mapping: Record<string, keyof BudgetConfig> = {
    prepareMs: "prepareMs", authorMs: "authorMs", maxGraphQueries: "maxGraphQueries", maxSourceWindows: "maxSourceWindows",
    maxSourceCharacters: "maxSourceCharacters", maxFiles: "maxFiles", maxFeatureNodes: "maxFeatureNodes", maxExpansionDepth: "maxExpansionDepth"
  };
  const result: Partial<BudgetConfig> = {};
  for (const [arg, key] of Object.entries(mapping)) if (args[arg] != null) (result as any)[key] = Number(args[arg]);
  return result;
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = camel(token.slice(2));
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) { result[key] = next; index += 1; }
    else result[key] = "true";
  }
  return result;
}

function listArgs(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) if (argv[index] === flag && argv[index + 1] && !argv[index + 1].startsWith("--")) values.push(argv[index + 1]);
  return values;
}

function audiences(value: string): Audience[] {
  const values = csv(value).map((item) => item.toLowerCase());
  const result: Audience[] = [];
  for (const item of values) {
    if (item === "both" || item === "all") { result.push("product", "engineering"); continue; }
    if (item !== "product" && item !== "engineering") throw new Error(`Invalid audience: ${item}`);
    result.push(item);
  }
  return [...new Set(result.length ? result : ["product"] as Audience[])];
}

function csv(value?: string): string[] { return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean); }
function camel(value: string): string { return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()); }
function required(value: string | undefined, name: string): string { if (!value) throw new Error(`Missing ${name}`); return value; }
function print(value: unknown): void { console.log(stableJson(value)); }

function help(): string {
  return `Excavator

Commands:
  overview   Prepare one or both project overview reports
  feature    Prepare one feature report for one or both audiences
  report     Prepare any combination of overview and feature reports
  prepare    Alias of report; accepts --request request.json
  codegraph  Inspect or build an optional CodeGraph index
  begin      Start or restart one document authoring timer
  source     Record a bounded source excerpt as evidence
  search     Search source under the run snapshot and record a reusable receipt
  checkpoint Save one completed section and its claims atomically
  checklist  Record compatibility checklist dispositions
  workitem   Update the investigation plan and coverage ledger
  trace      Record call, data, business, state or cross-repository traces
  resume     List incomplete sections and resume a stopped run
  assemble   Join completed sections into Markdown reports
  audit      Validate snapshot, evidence, claims, checklist and report structure; --document <id> scopes to one document
  status     Show progress and timing

Examples:
  excavator overview --target ./workspace --audience both
  excavator overview --target ./workspace --no-codegraph --audience both
  excavator codegraph status --target ./workspace
  excavator codegraph build --target ./workspace --quiet
  excavator feature --target ./workspace --subject "Account access" --aliases access,permission,role --audience both --detail detailed
  excavator search --run <run> --query "\\bTODO\\b|@deprecated" --regex --case-sensitive --reason "investigate unfinished behavior"
  excavator checkpoint --run <run> --document <id> --section 1 --file section.md --claims claims.json
  excavator workitem --run <run> --file workitem-updates.json
  excavator trace --run <run> --file traces.json
  excavator checklist --run <run> --file checklist-updates.json
  excavator audit --run <run> --document <id>
  excavator report --request request.json

Report detail:
  --detail detailed   Default. Requires a chapter inventory, fine-grained material work-item coverage and minimum report density.
  --detail standard   Compact mode for smoke tests and intentionally brief reports.
`;
}

await main();
