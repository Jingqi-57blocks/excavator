#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Audience, BudgetConfig, ChecklistItem, FeatureRequest, InvestigationWorkItem, ReportRequest, SectionClaim, TraceRecord } from "./core/types.ts";
import { addSourceEvidence, assembleRun, auditRun, beginDocument, checkpointSection, freezeRun, prepareRun, readingCheck, resumeRun, runStatus, scaffoldClaims, searchSourceEvidence, updateChecklist, updateTraces, updateWorkItems, type SupplementInput } from "./core/run.ts";
import { collectDrafts, draftSection } from "./assurance/parallel-authoring.ts";
import { stableJson } from "./core/util.ts";
import { buildCodeGraph, codeGraphStatus } from "./codegraph/codegraph-command.ts";
import { runDbSchema } from "./schema/db-schema-command.ts";
import { runNativeGraph } from "./nativegraph/native-graph-command.ts";
import { runFramework } from "./framework/framework-command.ts";
import { runCrossRepo } from "./crossrepo/crossrepo-command.ts";
import { deriveDefaultBudgets, plannedDocumentCount } from "./core/budgets.ts";
import { DEFAULT_WORKDIR } from "./core/defaults.ts";

async function main(): Promise<void> {
  const [command = "help", ...argv] = process.argv.slice(2);
  // Any command invoked with --help/-h prints that command's own usage and exits without running.
  if (!["help", "--help", "-h"].includes(command) && requestsHelp(argv)) {
    const key = resolveHelpKey(command, argv);
    if (key) { console.log(commandHelp(key)); return; }
  }
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
      case "db-schema": {
        const args = parseArgs(argv);
        const result = await runDbSchema({
          target: required(args.target, "--target"),
          out: args.out,
          manifest: args.manifest,
          descriptions: args.descriptions,
          language: args.language
        });
        print(args.json === "true"
          ? result.extraction
          : { target: result.target, outDir: result.outDir, markdownPath: result.markdownPath, jsonPath: result.jsonPath, tables: result.tables, relationships: result.relationships, perFormat: result.perFormat, warnings: result.warnings, unsupported: result.unsupported });
        break;
      }
      case "native-graph": {
        const args = parseArgs(argv);
        const result = await runNativeGraph({
          target: required(args.target, "--target"),
          out: args.out,
          ...(args.ctags === "false" ? { ctags: false } : {})
        });
        print(result);
        break;
      }
      case "framework": {
        const args = parseArgs(argv);
        const result = await runFramework({
          target: required(args.target, "--target"),
          out: args.out
        });
        print(result);
        break;
      }
      case "crossrepo": {
        const args = parseArgs(argv);
        const result = await runCrossRepo({
          target: required(args.target, "--target"),
          out: args.out
        });
        // The scan itself can be large; print the counts and where the full artifact landed.
        print({ target: result.target, jsonPath: result.jsonPath, summaryPath: result.summaryPath, summary: result.scan.summary, routeRecovery: result.scan.routeRecovery });
        break;
      }
      case "claims": {
        const [subcommand = "scaffold", ...rest] = argv;
        const args = parseArgs(rest);
        if (subcommand === "scaffold") {
          const content = await readFile(required(args.file, "--file"), "utf8");
          print(await scaffoldClaims(required(args.run, "--run"), required(args.document, "--document"), Number(required(args.section, "--section")), content));
        } else throw new Error(`Unknown claims subcommand: ${subcommand}`);
        break;
      }
      case "begin": {
        const args = parseArgs(argv);
        const manifest = await beginDocument(required(args.run, "--run"), required(args.document, "--document"));
        const notice = manifest.frozenAt ? {} : { notice: "This run is not frozen; freeze the investigation before authoring so knowledge is stable: excavator freeze --run <run-dir>." };
        print({ state: manifest.state, document: args.document, startedAt: manifest.documents.find((item) => item.id === args.document)?.startedAt, ...notice });
        break;
      }
      case "freeze": {
        const args = parseArgs(argv);
        const result = await freezeRun(required(args.run, "--run"));
        print(result);
        if (!result.frozen) process.exitCode = 1;
        break;
      }
      case "reading": {
        // Prose, not JSON: this is read by whoever decides what to open next, and a list to act on should
        // not have to be unpacked first. Always exit 0 — a read residual is a cost to weigh, never a failure.
        const args = parseArgs(argv);
        const result = await readingCheck(required(args.run, "--run"));
        process.stdout.write(`${result.report}\n`);
        break;
      }
      case "source": {
        const args = parseArgs(argv);
        const result = await addSourceEvidence(required(args.run, "--run"), required(args.path, "--path"), Number(required(args.start, "--start")), Number(required(args.end, "--end")), required(args.reason, "--reason"), supplementFrom(args));
        // Recording a window and reading it are one act. The default JSON escapes the excerpt into a single
        // `\n`-laden line, which forces that act into two — read the file with one tool, record it blind with
        // this one — and a window opened without being read is how an uncited window gets created.
        if (args.text === "true") process.stdout.write(`${renderSourceWindow(result)}\n`);
        else if (args.quiet === "true") process.stdout.write(`${sourceWindowSummary(result)}\n`);
        else print(result);
        break;
      }
      case "search": {
        const args = parseArgs(argv);
        const terms = args.query ? [args.query] : csv(args.terms);
        print(await searchSourceEvidence(
          required(args.run, "--run"),
          terms,
          required(args.reason, "--reason"),
          { maxResults: args.maxResults ? Number(args.maxResults) : undefined, pathPrefixes: csv(args.pathPrefixes ?? args.pathPrefix), regex: args.regex === "true", caseSensitive: args.caseSensitive === "true" },
          supplementFrom(args)
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
      case "draft": {
        const args = parseArgs(argv);
        const content = await readFile(required(args.file, "--file"), "utf8");
        let claims: SectionClaim[] | undefined;
        if (args.claims) {
          const raw = JSON.parse(await readFile(args.claims, "utf8")) as SectionClaim[] | { claims: SectionClaim[] };
          claims = Array.isArray(raw) ? raw : raw.claims;
        }
        const receipt = await draftSection(required(args.run, "--run"), required(args.document, "--document"), Number(required(args.section, "--section")), content, claims);
        print({ drafted: { document: receipt.documentId, section: receipt.section, revision: receipt.revision, hasClaims: receipt.hasClaims } });
        break;
      }
      case "collect": {
        const args = parseArgs(argv);
        const result = await collectDrafts(required(args.run, "--run"));
        print({ state: result.manifest.state, collected: result.collected.length, sections: result.collected.map((receipt) => ({ document: receipt.documentId, section: receipt.section, revision: receipt.revision })) });
        break;
      }
      case "checklist": {
        const args = parseArgs(argv);
        const raw = JSON.parse(await readFile(required(args.file, "--file"), "utf8")) as Partial<ChecklistItem>[] | { items: Partial<ChecklistItem>[] };
        const checklist = await updateChecklist(required(args.run, "--run"), Array.isArray(raw) ? raw : raw.items, supplementFrom(args));
        print(checklist);
        break;
      }
      case "workitem": {
        const args = parseArgs(argv);
        const raw = JSON.parse(await readFile(required(args.file, "--file"), "utf8")) as Partial<InvestigationWorkItem>[] | { items: Partial<InvestigationWorkItem>[] };
        print(await updateWorkItems(required(args.run, "--run"), Array.isArray(raw) ? raw : raw.items, supplementFrom(args)));
        break;
      }
      case "trace": {
        const args = parseArgs(argv);
        const raw = JSON.parse(await readFile(required(args.file, "--file"), "utf8")) as TraceRecord[] | { traces: TraceRecord[] };
        print(await updateTraces(required(args.run, "--run"), Array.isArray(raw) ? raw : raw.traces, supplementFrom(args)));
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
    workdir: resolve(String(raw.workdir ?? args.workdir ?? DEFAULT_WORKDIR)),
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
    workdir: resolve(args.workdir ?? DEFAULT_WORKDIR),
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
    // `both`/`all` stay product+engineering; prd is a feature-only audience requested explicitly by name.
    if (item === "both" || item === "all") { result.push("product", "engineering"); continue; }
    if (item !== "product" && item !== "engineering" && item !== "prd") throw new Error(`Invalid audience: ${item} (expected product, engineering, prd, both or all)`);
    result.push(item);
  }
  return [...new Set(result.length ? result : ["product"] as Audience[])];
}

/** Build the supplement flag pair from parsed args; undefined when neither flag is present. Mutual-
 *  requirement and work-item resolution are enforced in the Core mutator, not here. */
function supplementFrom(args: Record<string, string>): SupplementInput {
  if (!args.supplementReason && !args.supplementWorkitem) return undefined;
  return { reason: args.supplementReason, workItemId: args.supplementWorkitem };
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
  db-schema  Recover a database design (tables, columns, relationships) from source, deterministically
  crossrepo     Resolve frontend HTTP calls to the backend routes that serve them (deterministic, zero model)
  native-graph  Build a symbol+call navigation graph for CodeGraph-unsupported languages (Perl, Zope templates)
  framework  Recover routes/components from framework conventions (Catalyst, …) — for dynamically-dispatched apps
  begin      Start or restart one document authoring timer
  reading    Show which in-boundary decision code no source window covers yet — run it before freeze, where opening one is free
  freeze     Freeze the completed investigation into knowledge.json before authoring; also renders per-document authoring packets
  source     Record a bounded source excerpt as evidence
  search     Search source under the run snapshot and record a reusable receipt
  checkpoint Save one completed section and its claims atomically
  draft      Draft one section in parallel-safe isolation; leaves a receipt for collect
  collect    Serially record all pending section drafts into the timeline and manifest
  claims     Scaffold a claims skeleton from a section's markdown
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
  excavator db-schema --target ./workspace --out ./db --language en-US
  excavator native-graph --target ./workspace --out ./nav
  excavator framework --target ./workspace --out ./fw
  excavator reading --run <run>
  excavator freeze --run <run>
  excavator feature --target ./workspace --subject "Account access" --aliases access,permission,role --audience both --detail detailed
  excavator search --run <run> --query "\\bTODO\\b|@deprecated" --regex --case-sensitive --reason "investigate unfinished behavior"
  excavator claims scaffold --run <run> --document <id> --section 1 --file section.md
  excavator checkpoint --run <run> --document <id> --section 1 --file section.md --claims claims.json
  excavator draft --run <run> --document <id> --section 1 --file section.md --claims claims.json
  excavator collect --run <run>
  excavator workitem --run <run> --file workitem-updates.json
  excavator trace --run <run> --file traces.json
  excavator checklist --run <run> --file checklist-updates.json
  excavator audit --run <run> --document <id>
  excavator report --request request.json

Report detail:
  --detail detailed   Default. Requires a chapter inventory, fine-grained material work-item coverage and minimum report density.
  --detail standard   Compact mode for smoke tests and intentionally brief reports.

Run any command with --help (or -h) to see its flags and one example, e.g. \`excavator audit --help\`.
`;
}

interface CommandHelp { synopsis: string; flags: string[]; example: string; notes?: string; }

// One entry per command (and per subcommand for the ones that take a subcommand). Keys with a space
// are `<command> <subcommand>`; they take priority over the bare command when the subcommand matches.
const COMMAND_HELP: Record<string, CommandHelp> = {
  overview: {
    synopsis: "overview --target <dir> [--audience product|engineering|both] [--detail standard|detailed] [--no-codegraph]",
    flags: [
      "--target <dir>       Source workspace to analyze (required)",
      "--audience <who>     product, engineering, or both (default product)",
      "--detail <level>     detailed (default) or standard",
      "--no-codegraph       Prepare without a CodeGraph index",
      "--codegraph <db>     Use an existing CodeGraph database",
      "--language <tag>     Output language (default en-US)"
    ],
    example: "excavator overview --target ./workspace --audience both"
  },
  feature: {
    synopsis: "feature --target <dir> --subject <text> [--aliases a,b,c] [--audience product|engineering|both] [--detail standard|detailed]",
    flags: [
      "--target <dir>       Source workspace to analyze (required)",
      "--subject <text>     Feature name to investigate (required)",
      "--aliases a,b,c      Comma-separated alternate names",
      "--audience <who>     product, engineering, or both (default product)",
      "--detail <level>     detailed (default) or standard"
    ],
    example: 'excavator feature --target ./workspace --subject "Account access" --aliases access,role --audience both'
  },
  report: {
    synopsis: "report (--request <json> | --target <dir> --overview <who> --feature <text> ...)",
    flags: [
      "--request <json>     Read a full ReportRequest from a JSON file",
      "--target <dir>       Source workspace to analyze (required without --request)",
      "--overview <who>     Overview audiences, e.g. product,engineering",
      "--feature <text>     Repeatable feature subject; pair with --feature-aliases / --feature-audience"
    ],
    example: "excavator report --request request.json"
  },
  prepare: {
    synopsis: "prepare (--request <json> | --target <dir> --overview <who> --feature <text> ...)",
    flags: [
      "--request <json>     Read a full ReportRequest from a JSON file",
      "--target <dir>       Source workspace to analyze (required without --request)"
    ],
    example: "excavator prepare --request request.json"
  },
  codegraph: {
    synopsis: "codegraph <status|build> --target <dir> [--binary <path>]",
    flags: [
      "status               Report whether a usable CodeGraph index exists",
      "build                Build or refresh the CodeGraph index",
      "--target <dir>       Source workspace (required)",
      "--binary <path>      CodeGraph executable (default codegraph)"
    ],
    example: "excavator codegraph status --target ./workspace"
  },
  "codegraph status": {
    synopsis: "codegraph status --target <dir> [--binary <path>]",
    flags: [
      "--target <dir>       Source workspace (required)",
      "--binary <path>      CodeGraph executable (default codegraph)"
    ],
    example: "excavator codegraph status --target ./workspace"
  },
  "codegraph build": {
    synopsis: "codegraph build --target <dir> [--binary <path>] [--force] [--quiet]",
    flags: [
      "--target <dir>       Source workspace (required)",
      "--binary <path>      CodeGraph executable (default codegraph)",
      "--force              Rebuild even when an index already exists",
      "--quiet              Suppress CodeGraph progress output"
    ],
    example: "excavator codegraph build --target ./workspace --quiet"
  },
  "db-schema": {
    synopsis: "db-schema --target <dir> [--out <dir>] [--manifest <json>] [--descriptions <json>] [--json]",
    flags: [
      "--target <dir>          Source workspace to analyze, read-only (required)",
      "--out <dir>             Output directory (default .work/db-schema)",
      "--manifest <json>       Locate manifest {sources:[{format,include}]}; REPLACES auto-discovery",
      "--descriptions <json>   {\"<table>\": \"one sentence\"} injected verbatim as table descriptions — write these in ANY target language (this is the localization path)",
      "--json                  Print the full extraction JSON instead of a summary"
    ],
    example: "excavator db-schema --target ./workspace --out ./db --descriptions descriptions.json",
    notes: "Deterministic and zero-model: writes a byte-stable database-design.md (neutral English structure — engine, overview, table index, legend, columns) and db-schema.json. The DB engine is detected by weighing dialect/driver signals. Localization is NOT a per-language template: the structure is language-neutral and the per-table descriptions are written by an AI in any target language, then injected. Discovers gorm / Sequelize / SQL-dump by fingerprint and reports Prisma / Django / TypeORM / ActiveRecord as located-but-unsupported."
  },
  "native-graph": {
    synopsis: "native-graph --target <dir> [--out <dir>] [--ctags false]",
    flags: [
      "--target <dir>   Source workspace to analyze, read-only (required)",
      "--out <dir>      Output directory (default .work/native-graph)",
      "--ctags false    Skip the optional universal-ctags census"
    ],
    example: "excavator native-graph --target ./workspace --out ./nav",
    notes: "Deterministic, zero-model navigation aid for languages CodeGraph does not index. tree-sitter recovers Perl packages/subs/calls; universal-ctags (optional) adds a cross-language definition census; Zope .zpt/.dtml templates get a textual reference inventory. Writes native-graph.json + native-graph-summary.md. Dynamic-dispatch calls are marked unresolved, not guessed."
  },
  framework: {
    synopsis: "framework --target <dir> [--out <dir>]",
    flags: [
      "--target <dir>   Source workspace to analyze, read-only (required)",
      "--out <dir>      Output directory (default .work/framework)"
    ],
    example: "excavator framework --target ./workspace --out ./fw",
    notes: "Deterministic, zero-model. Detects a convention-heavy framework (Catalyst today; pluggable) and recovers its route/action inventory and component roles (controller/model/view/schema/…) from attributes, namespaces and config — the entry-point inventory a generic call graph cannot produce for dynamically-dispatched apps. Writes framework-model.json + framework-summary.md. Paths shown only when stated literally; recovered by convention, still grounded to source."
  },
  begin: {
    synopsis: "begin --run <dir> --document <id>",
    flags: [
      "--run <dir>          Run directory (required)",
      "--document <id>      Document to start or restart (required)",
      "Precondition: the run must be frozen first (excavator freeze --run <dir>); begin refuses an unfrozen run."
    ],
    example: "excavator begin --run <run> --document overview-product"
  },
  reading: {
    synopsis: "reading --run <dir>",
    flags: [
      "--run <dir>          Run directory (required)",
      "Read-only: opens no window, changes no artifact, needs no supplement even after freeze."
    ],
    example: "excavator reading --run <run>",
    notes: "Ranked by unread weight, so it aids an investment decision; it is not a checklist and nothing counts how many entries are cleared. Before freeze the denominator is derived live and opening a window is ordinary investigation; after freeze it reads the frozen denominator and any window costs a supplement."
  },
  freeze: {
    synopsis: "freeze --run <dir>",
    flags: ["--run <dir>          Run directory (required)"],
    example: "excavator freeze --run <run>",
    notes: "On success, also renders per-document authoring packets under context/authoring/, including a reading-boundary block naming what the investigation never opened."
  },
  source: {
    synopsis: "source --run <dir> --path <file> --start <n> --end <n> --reason <text> [--supplement-reason <text> --supplement-workitem <id>]",
    flags: [
      "--run <dir>              Run directory (required)",
      "--path <file>            Source file relative to the target (required)",
      "--start <n>              First line of the excerpt (required)",
      "--end <n>                Last line of the excerpt (required)",
      "--reason <text>          Why the excerpt is recorded (required)",
      "--text                   Print the excerpt as lines instead of JSON, so recording and reading are one act",
      "--quiet                  Print only the evidence id, span and any truncation notice",
      "--supplement-reason <text>  Post-freeze only: why the frozen knowledge is insufficient",
      "--supplement-workitem <id>  Post-freeze only: the existing work item this supplement is charged to"
    ],
    example: 'excavator source --run <run> --path src/server.ts --start 3 --end 5 --reason "route handler" --text',
    notes: "A window holds at most 240 lines. A longer request records the first 240 and says so, naming the range still unread — open another window for it. The reading gate requires a window OVERLAPPING a decision function, not covering it, so a tail left unread stays unread without anything failing."
  },
  search: {
    synopsis: "search --run <dir> (--query <expr> | --terms a,b) --reason <text> [--regex] [--case-sensitive] [--max-results <n>] [--path-prefixes a,b] [--supplement-reason <text> --supplement-workitem <id>]",
    flags: [
      "--run <dir>              Run directory (required)",
      "--query <expr>           Single search expression (or use --terms)",
      "--terms a,b              Comma-separated literal terms",
      "--reason <text>          Why the search is recorded (required)",
      "--regex                  Treat the query as a regular expression",
      "--case-sensitive         Match case exactly",
      "--max-results <n>        Cap the receipt (default 50)",
      "--path-prefixes a,b      Restrict the search to these path prefixes",
      "--supplement-reason <text>  Post-freeze only: why the frozen knowledge is insufficient",
      "--supplement-workitem <id>  Post-freeze only: the existing work item this supplement is charged to"
    ],
    example: 'excavator search --run <run> --query "\\bTODO\\b" --regex --reason "find unfinished work"'
  },
  checkpoint: {
    synopsis: "checkpoint --run <dir> --document <id> --section <n> --file <md> [--claims <json>]",
    flags: [
      "--run <dir>          Run directory (required)",
      "--document <id>      Document being authored (required)",
      "--section <n>        Section index (required)",
      "--file <md>          Section markdown to save (required)",
      "--claims <json>      Claims sidecar (array or {claims:[...]})"
    ],
    example: "excavator checkpoint --run <run> --document <id> --section 1 --file section.md --claims claims.json"
  },
  draft: {
    synopsis: "draft --run <dir> --document <id> --section <n> --file <md> [--claims <json>]",
    flags: [
      "--run <dir>          Run directory (required)",
      "--document <id>      Document being authored (required)",
      "--section <n>        Section index (required)",
      "--file <md>          Section markdown to draft (required)",
      "--claims <json>      Claims sidecar (array or {claims:[...]})"
    ],
    example: "excavator draft --run <run> --document <id> --section 1 --file section.md --claims claims.json",
    notes: "Parallel-safe: writes only this section's files and a receipt, never the shared timeline or manifest. Run one draft per section concurrently, then a single `collect`."
  },
  collect: {
    synopsis: "collect --run <dir>",
    flags: ["--run <dir>          Run directory (required)"],
    example: "excavator collect --run <run>",
    notes: "Serial barrier: records every pending section draft into the timeline and manifest in a deterministic order. A no-op when nothing is pending, so it is safe to rerun."
  },
  claims: {
    synopsis: "claims scaffold --run <dir> --document <id> --section <n> --file <md>",
    flags: [
      "scaffold             Emit a claims skeleton, one stub per substantive segment",
      "--run <dir>          Run directory (required)",
      "--document <id>      Document the section belongs to (required)",
      "--section <n>        Section index (required)",
      "--file <md>          Section markdown to segment (required)"
    ],
    example: "excavator claims scaffold --run <run> --document <id> --section 1 --file section.md"
  },
  "claims scaffold": {
    synopsis: "claims scaffold --run <dir> --document <id> --section <n> --file <md>",
    flags: [
      "--run <dir>          Run directory (required)",
      "--document <id>      Document the section belongs to (required)",
      "--section <n>        Section index (required)",
      "--file <md>          Section markdown to segment (required)"
    ],
    example: "excavator claims scaffold --run <run> --document <id> --section 1 --file section.md"
  },
  checklist: {
    synopsis: "checklist --run <dir> --file <json> [--supplement-reason <text> --supplement-workitem <id>]",
    flags: [
      "--run <dir>              Run directory (required)",
      "--file <json>            Checklist dispositions (array or {items:[...]}) (required)",
      "--supplement-reason <text>  Post-freeze only: why the frozen knowledge is insufficient",
      "--supplement-workitem <id>  Post-freeze only: the existing work item this supplement is charged to"
    ],
    example: "excavator checklist --run <run> --file checklist-updates.json"
  },
  workitem: {
    synopsis: "workitem --run <dir> --file <json> [--supplement-reason <text> --supplement-workitem <id>]",
    flags: [
      "--run <dir>              Run directory (required)",
      "--file <json>            Work-item updates (array or {items:[...]}) (required)",
      "--supplement-reason <text>  Post-freeze only: why the frozen knowledge is insufficient",
      "--supplement-workitem <id>  Post-freeze only: the existing work item this supplement is charged to"
    ],
    example: "excavator workitem --run <run> --file workitem-updates.json"
  },
  trace: {
    synopsis: "trace --run <dir> --file <json> [--supplement-reason <text> --supplement-workitem <id>]",
    flags: [
      "--run <dir>              Run directory (required)",
      "--file <json>            Trace records (array or {traces:[...]}) (required)",
      "--supplement-reason <text>  Post-freeze only: why the frozen knowledge is insufficient",
      "--supplement-workitem <id>  Post-freeze only: the existing work item this supplement is charged to"
    ],
    example: "excavator trace --run <run> --file traces.json"
  },
  assemble: {
    synopsis: "assemble --run <dir>",
    flags: ["--run <dir>          Run directory (required)"],
    example: "excavator assemble --run <run>"
  },
  audit: {
    synopsis: "audit --run <dir> [--document <id>]",
    flags: [
      "--run <dir>          Run directory (required)",
      "--document <id>      Scope the audit to one document (advisory run-wide checks)"
    ],
    example: "excavator audit --run <run> --document <id>"
  },
  resume: {
    synopsis: "resume --run <dir>",
    flags: ["--run <dir>          Run directory (required)"],
    example: "excavator resume --run <run>"
  },
  status: {
    synopsis: "status --run <dir>",
    flags: ["--run <dir>          Run directory (required)"],
    example: "excavator status --run <run>"
  }
};

/**
 * True only when `-h`/`--help` appears in flag position. It walks the args with the same
 * value-consumption rule as `parseArgs` (a `--flag` swallows the next non-`--` token as its value),
 * so a value that happens to equal `-h`/`--help` — e.g. `--query -h` — is not misread as a help
 * request and the real command still runs.
 */
function requestsHelp(argv: string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h" || token === "--help") return true;
    if (token.startsWith("--")) {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) index += 1;
    }
  }
  return false;
}

interface RecordedWindow {
  evidence?: { id?: string; path?: string; startLine?: number; endLine?: number; content?: string };
  cacheHit?: boolean;
  notice?: string;
}

/** One line naming what was recorded, plus the truncation notice when there is one. */
function sourceWindowSummary(result: Record<string, unknown>): string {
  const { evidence, cacheHit, notice } = result as RecordedWindow;
  const head = `${evidence?.id ?? "?"}  ${evidence?.path ?? "?"}:${evidence?.startLine ?? "?"}-${evidence?.endLine ?? "?"}${cacheHit ? "  (cache hit)" : ""}`;
  return notice ? `${head}\n${notice}` : head;
}

/** The summary plus the excerpt as actual lines, so recording a window also shows it. */
function renderSourceWindow(result: Record<string, unknown>): string {
  const { evidence } = result as RecordedWindow;
  const start = evidence?.startLine ?? 1;
  const body = (evidence?.content ?? "").split("\n").map((line, index) => `${String(start + index).padStart(5)}  ${line}`).join("\n");
  return `${sourceWindowSummary(result)}\n\n${body}`;
}

/** Resolve which help entry a `<command> [subcommand] --help` invocation should print. */
function resolveHelpKey(command: string, argv: string[]): string | null {
  const first = argv[0];
  if (first && !first.startsWith("-") && COMMAND_HELP[`${command} ${first}`]) return `${command} ${first}`;
  return COMMAND_HELP[command] ? command : null;
}

function commandHelp(key: string): string {
  const help = COMMAND_HELP[key];
  const notes = help.notes ? `\n\nNotes:\n  ${help.notes}` : "";
  return `Excavator ${key}\n\nUsage:\n  excavator ${help.synopsis}\n\nFlags:\n${help.flags.map((flag) => `  ${flag}`).join("\n")}\n\nExample:\n  ${help.example}${notes}\n`;
}

await main();
