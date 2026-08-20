#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Audience, BudgetConfig, ChecklistItem, DetailLevel, DocumentKind, FeatureRequest, InvestigationWorkItem, ReportRequest, SectionClaim, TraceRecord } from "./base/types.ts";
import { addSourceEvidence, assembleRun, auditRun, beginDocument, checkpointSection, freezeRun, prepareRun, readingCheck, resumeRun, runStatus, scaffoldClaims, searchSourceEvidence, updateChecklist, updateTraces, updateWorkItems, type SupplementInput } from "./run/run.ts";
import { collectDrafts, draftSection } from "./report/parallel-authoring.ts";
import { draftUnit, type UnitDraftInput } from "./report/unit-draft.ts";
import { collectUnits } from "./report/unit-collect.ts";
import { checkpointUnit } from "./report/unit-checkpoint.ts";
import { resumeUnits, unitStatus } from "./report/unit-status.ts";
import { renderUnitPacketForRun } from "./report/unit-packet-source.ts";
import { loadRunUnitIdentities } from "./report/unit-cache-identity-source.ts";
import { admitUnits, planUnitAdmission } from "./report/unit-cache-admission-run.ts";
import { summariseAdmission, type CandidateLedgerRow } from "./report/unit-cache-admission.ts";
import { describeAuthorship, describeProvenance, type UnitAuthorship, type UnitProvenance } from "./report/unit-provenance.ts";
import { readUnitGroundingForRun, summariseUnitGroundingReading } from "./report/unit-grounding-reading.ts";
import { planRun, renderPlannerPacketForRun, DEFAULT_PLANNER_PACKET_BYTE_LIMIT, type PlanProposalSource, type PlanRecording } from "./run/stages/plan-stage.ts";
import { appendReportRequest } from "./report/report-requests-append.ts";
import { plannedDocumentId, type LegacyDocumentRequest } from "./report/legacy-request-mapping.ts";
import { PACKET_OVER_BUDGET_MODES, type PacketOverBudgetMode } from "./report/planner-packet.ts";
import { stableJson } from "./base/util.ts";
import { assertNever } from "./base/artifact-result.ts";
import { buildCodeGraph, codeGraphStatus } from "./codegraph/codegraph-command.ts";
import { runDbSchema } from "./schema/db-schema-command.ts";
import { runNativeGraph } from "./nativegraph/native-graph-command.ts";
import { runFramework } from "./framework/framework-command.ts";
import { runCrossRepo } from "./crossrepo/crossrepo-command.ts";
import { deriveDefaultBudgets, plannedDocumentCount } from "./base/budgets.ts";
import { DEFAULT_WORKDIR } from "./base/defaults.ts";

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
          descriptions: args.descriptions
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
      case "plan-packet": {
        // Read-only, both keyings. Without `--unit` it renders the planner view of the whole run; with `--unit <id>`
        // it renders the bounded view ONE authoring unit is written from — obligation rows carrying their own
        // evidence and trace ids, and every bound record in full. The model is called from the skill, never here.
        const args = parseArgs(argv);
        if (unitKeyed(args, "plan-packet")) {
          const { packet, readPaths } = await renderUnitPacketForRun(required(args.run, "--run"), {
            unitId: required(args.unit, "--unit"),
            overBudget: overBudgetMode(required(args.overBudget, "--over-budget")),
            childSummaries: { from: "collected-for-this-plan" },
            ...(args.byteLimit ? { byteLimit: Number(args.byteLimit) } : {})
          });
          if (args.out) {
            await writeFile(resolve(args.out), packet.markdown);
            print({ out: resolve(args.out), unit: packet.unitId, kind: packet.kind, bytes: packet.bytes, byteLimit: packet.byteLimit, obligations: packet.obligationIds.length, evidence: packet.renderedEvidenceIds.length, limitations: packet.limitations, readPaths });
          } else process.stdout.write(packet.markdown);
          break;
        }
        const packet = await renderPlannerPacketForRun(required(args.run, "--run"), {
          overBudget: overBudgetMode(required(args.overBudget, "--over-budget")),
          byteLimit: args.byteLimit ? Number(args.byteLimit) : DEFAULT_PLANNER_PACKET_BYTE_LIMIT
        });
        if (args.out) {
          await writeFile(resolve(args.out), packet.markdown);
          print({ out: resolve(args.out), bytes: packet.bytes, byteLimit: packet.byteLimit, limitations: packet.limitations });
        } else process.stdout.write(packet.markdown);
        break;
      }
      case "unit-cache-identity": {
        // Read-only: the CACHE IDENTITY of every unit of this run's plan — the packet's own bytes with the three
        // plan-global digest lines normalized, digested. It admits nothing and writes nothing; it answers "which
        // units of this plan would a verified draft still be an answer for" one unit at a time.
        const args = parseArgs(argv);
        const identities = await loadRunUnitIdentities(required(args.run, "--run"), authorshipOf(required(args.authorship, "--authorship")));
        print({
          run: identities.runId,
          knowledgeEpoch: identities.knowledgeEpoch,
          planCatalogDigest: identities.planCatalogDigest,
          authorship: describeAuthorship(identities.authorship),
          units: identities.rows.map((row) => row.state === "identified"
            ? {
                unit: row.identity.unitId,
                document: row.identity.documentId,
                kind: row.identity.kind,
                identityDigest: row.identity.digest,
                viewBytes: row.identity.viewBytes,
                sections: row.identity.sections
              }
            : { unit: row.unitId, document: row.documentId, kind: row.kind, identity: "unavailable", reason: row.reason }),
          readPaths: identities.readPaths
        });
        break;
      }
      case "unit-cache-admit": {
        // The one explicit act: re-enter previously verified units through the existing draft and collect doors.
        // `--mode` is required and has no default — one arm writes into the run and the other cannot.
        const args = parseArgs(argv);
        print(await unitAdmissionOutput(
          required(args.run, "--run"),
          authorshipOf(required(args.authorship, "--authorship")),
          admissionMode(required(args.mode, "--mode"))
        ));
        break;
      }
      case "plan": {
        const args = parseArgs(argv);
        const result = await planRun(required(args.run, "--run"), proposalSource(args), planRecording(args));
        print({
          topics: result.topicsPath,
          catalog: result.planCatalogPath,
          dag: result.planDagPath,
          revision: {
            planRevision: result.revision.planRevision,
            previousPlanCatalogDigest: result.revision.previousPlanCatalogDigest,
            reason: result.revision.revisionReason,
            archived: result.revision.archive,
            succession: result.revision.succession
          },
          verdicts: result.verdicts,
          obligations: result.artifacts.planCatalog.obligationAccounting
        });
        break;
      }
      case "request-append": {
        // The one supported way a recorded request set grows: one document, appended, with every field stated.
        const args = parseArgs(argv);
        const result = await appendReportRequest(required(args.run, "--run"), appendedDocument(args));
        print({
          requests: result.path,
          appended: result.appended,
          documents: result.artifact.requests.map((record) => record.documentId),
          next: "The recorded plan no longer covers this request set: run `excavator plan --run <run> --fixture-plan --revise --reason <why>` before drafting."
        });
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
        if (unitKeyed(args, "checkpoint")) {
          const result = await checkpointUnit(required(args.run, "--run"), await unitDraftInput(args));
          print({ checkpointed: unitReceiptLine(result.receipt), collected: result.collected.collected.map(unitReceiptLine) });
          break;
        }
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
        if (unitKeyed(args, "draft")) {
          print({ drafted: unitReceiptLine(await draftUnit(required(args.run, "--run"), await unitDraftInput(args))) });
          break;
        }
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
        if (unitScoped(args, "collect")) {
          const units = await collectUnits(required(args.run, "--run"));
          print({
            collected: units.collected.length,
            units: units.collected.map(unitReceiptLine),
            ...(units.unplanned.length ? { unplanned: units.unplanned.map(unitReceiptLine) } : {})
          });
          break;
        }
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
        if (unitScoped(args, "audit")) {
          // The read-only rerun of the grounding verdict `collect` already applied. Same rules, same denominator.
          const reading = await readUnitGroundingForRun(required(args.run, "--run"));
          print({ ...reading, lines: summariseUnitGroundingReading(reading) });
          if (reading.units.some((row) => row.verdict.conclusion === "violations")) process.exitCode = 1;
          break;
        }
        const result = await auditRun(required(args.run, "--run"), args.document ? { documentId: args.document } : {});
        print(result);
        if (result.findings.some((finding) => finding.level === "error")) process.exitCode = 1;
        break;
      }
      case "resume": {
        const args = parseArgs(argv);
        print(unitScoped(args, "resume")
          ? await resumeUnits(required(args.run, "--run"))
          : await resumeRun(required(args.run, "--run")));
        break;
      }
      case "status": {
        const args = parseArgs(argv);
        print(unitScoped(args, "status")
          ? await unitStatus(required(args.run, "--run"))
          : await runStatus(required(args.run, "--run")));
        break;
      }
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
  // `profile` is passed through UNVALIDATED on purpose: `normalizeFeatureProfile` is the single validator, and a
  // copy of its rules here would be a second one to drift. Spread conditionally so a request without hypotheses
  // does not acquire a `profile: undefined` key and move its own contract digest.
  const features = (raw.features ?? []).map((feature) => ({ subject: feature.subject, aliases: feature.aliases ?? [], audiences: feature.audiences?.flatMap((value) => audiences(String(value))) ?? ["product"], ...(feature.profile === undefined ? {} : { profile: feature.profile }) }));
  return {
    target: resolve(String(raw.target ?? required(args.target, "target"))),
    codegraph: raw.codegraph ? resolve(String(raw.codegraph)) : args.codegraph ? resolve(args.codegraph) : undefined,
    codegraphMode: args.noCodegraph === "true" ? "off" : raw.codegraphMode ?? "auto",
    language: String(raw.language ?? args.language ?? "en-US"),
    detailLevel: raw.detailLevel === "standard" || args.detail === "standard" ? "standard" : "detailed",
    workdir: resolve(String(raw.workdir ?? args.workdir ?? DEFAULT_WORKDIR)),
    // Rebuilt field by field, so a field missing HERE cannot be set at all: `redactSecrets` was absent, and
    // that made the mode the request type documents unreachable from the CLI — the flag existed only for
    // callers using the library directly.
    redactSecrets: args.noRedact === "true" ? false : args.redact === "true" || raw.redactSecrets !== false,
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
    // The same resolution `normalizeRequest` does. It was absent here, so `excavator overview --no-redact`
    // parsed the flag and dropped it — the help text promised a mode two of the three prepare commands could
    // not reach.
    redactSecrets: args.noRedact === "true" ? false : true,
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

/** Exactly one proposal source, stated. Neither flag has a default: a plan nobody chose a source for is not a plan. */
function proposalSource(args: Record<string, string>): PlanProposalSource {
  const fixture = args.fixturePlan === "true";
  if (fixture && args.proposal) throw new Error("Pass either --fixture-plan or --proposal <file>, not both; a plan has exactly one source");
  if (fixture) return { mode: "fixture" };
  if (args.proposal) return { mode: "file", path: args.proposal };
  throw new Error("Missing --fixture-plan or --proposal <file>; a plan proposal comes from the deterministic generator or from a file");
}

/**
 * Whether this plan action records the first revision of the epoch or supersedes the recorded plan.
 *
 * `--revise` and `--reason` are one flag in two halves: a revision with no stated reason is a plan replaced for
 * reasons nobody recorded, and a reason with no `--revise` is a caller who thinks they are superseding a plan and
 * is not. Both halves missing is the default path, which behaves exactly as it always has.
 */
function planRecording(args: Record<string, string>): PlanRecording {
  // The VALUE is tested before the flag is read as a boolean. `parseArgs` hands a flag the next non-`--` token, so
  // `--revise yes` arrives as `revise: "yes"`, and a `=== "true"` test alone would fall through to the recording
  // path — the revise silently dropped, and the refusal the operator then gets telling them to use `--revise`.
  if (args.revise !== undefined && args.revise !== "true") {
    throw new Error(`excavator plan takes --revise as a bare flag; ${JSON.stringify(args.revise)} is not a value it accepts`);
  }
  if (args.revise === undefined) {
    if (args.reason) throw new Error("--reason applies to --revise; a plain `plan` records the first revision of this epoch and supersedes nothing");
    return { kind: "record" };
  }
  return { kind: "revise", reason: required(args.reason, "--reason (a plan revision states why the plan it supersedes was replaced)") };
}

/**
 * The one document a `request-append` adds, with every field stated and its id DERIVED.
 *
 * The id is not a flag: `plannedDocumentId` is the same function prepare names its documents with, and letting a
 * caller invent one would let a document id that no convention produces into the recorded request set — where the
 * feature key is recovered from the id.
 *
 * `--feature-key` is REFUSED rather than ignored. The door appends project-scope documents only (a feature
 * document's boundary is unverifiable here — see `report-requests-append.ts`), and a flag silently dropped is how
 * an operator who meant `--kind feature` gets a project-scope document and a duplicate-id refusal two commands later.
 */
function appendedDocument(args: Record<string, string>): LegacyDocumentRequest {
  if (args.featureKey !== undefined) {
    throw new Error("--feature-key names a knowledge boundary this command cannot verify against what the run investigated; only project-scope documents (--kind overview) may be appended. Re-prepare the run with that feature requested.");
  }
  const kind = documentKind(required(args.kind, "--kind"));
  const audience = singleAudience(required(args.audience, "--audience"));
  return {
    documentId: plannedDocumentId(kind, audience, null),
    kind,
    audience,
    featureKey: null,
    detailLevel: detailLevel(required(args.detail, "--detail")),
    language: required(args.language, "--language")
  };
}

function documentKind(value: string): DocumentKind {
  if (value === "overview") return value;
  if (value === "feature") {
    throw new Error('--kind "feature" is not appendable: a feature document names a knowledge boundary this command cannot check against what the run investigated, and nothing downstream re-checks it either. Re-prepare the run with that feature requested.');
  }
  throw new Error(`--kind ${JSON.stringify(value)} is not one of: overview`);
}

function singleAudience(value: string): Audience {
  const parsed = audiences(value);
  if (parsed.length !== 1) throw new Error(`--audience ${JSON.stringify(value)} names ${parsed.length} audiences; one appended document is written for exactly one reader`);
  return parsed[0]!;
}

function detailLevel(value: string): DetailLevel {
  if (value === "standard" || value === "detailed") return value;
  throw new Error(`--detail ${JSON.stringify(value)} is not one of: standard, detailed`);
}

/**
 * True when this invocation is keyed by authoring unit, false when it is keyed by (document, section).
 *
 * There is no default and no inference: `--unit` selects the unit path, its absence selects the section path, and
 * passing both keyings is a named refusal rather than a precedence rule nobody would remember. The section path
 * behaves exactly as it did — the only invocations that reach the unit machinery are the ones that asked for it.
 */
function unitKeyed(args: Record<string, string>, command: string): boolean {
  if (!args.unit) return false;
  if (args.document || args.section) {
    throw new Error(`excavator ${command} takes either --unit <id> or --document <id> --section <n>, not both; the command is keyed one way`);
  }
  return true;
}

/**
 * True when a run-wide command was asked for the unit view. `--units` takes no id, so a `--unit <id>` here is a
 * REFUSAL rather than a flag nobody reads: silently falling through to the section path would run the wrong
 * command on the strength of one missing letter.
 */
function unitScoped(args: Record<string, string>, command: string): boolean {
  if (args.unit) {
    throw new Error(`excavator ${command} takes --units (no id): it is run-wide over every planned unit, not one unit at a time`);
  }
  if (args.units === undefined) return false;
  // `parseArgs` hands a flag the next non-`--` token as its value, so `--units 1` would leave `args.units === "1"`
  // and a `=== "true"` test would silently run the SECTION barrier instead. The value case is the same silent
  // mode default as the `--unit` slip above, one token further along.
  if (args.units !== "true") {
    throw new Error(`excavator ${command} takes --units as a bare flag; ${JSON.stringify(args.units)} is not a value it accepts`);
  }
  return true;
}

/**
 * The three files a unit draft is made of. All required: the claims sidecar and the summary are part of a unit's
 * output contract, so a unit drafted without them is not a unit that is missing extras — it is a refusal.
 */
/**
 * One hand-written unit draft, from the four files and the one required author.
 *
 * `provenance` is `fresh` and cannot be anything else from here: a draft a person or a model just wrote IS fresh,
 * and the only thing that may mint a `cache-admitted` record is the admission command, which has a verified ledger
 * row to name. A flag for it would be a way to claim a cache hit for bytes nobody verified.
 */
async function unitDraftInput(args: Record<string, string>): Promise<UnitDraftInput> {
  const raw = JSON.parse(await readFile(required(args.claims, "--claims"), "utf8")) as SectionClaim[] | { claims: SectionClaim[] };
  return {
    unitId: required(args.unit, "--unit"),
    content: await readFile(required(args.file, "--file"), "utf8"),
    claims: Array.isArray(raw) ? raw : raw.claims,
    summary: JSON.parse(await readFile(required(args.summary, "--summary"), "utf8")) as unknown,
    authorship: authorshipOf(required(args.authorship, "--authorship")),
    provenance: { kind: "fresh" }
  };
}

/** The two admission modes. Required, closed, no default: one of them writes into the run and one cannot. */
const UNIT_ADMISSION_MODES = ["plan-only", "admit"] as const;
type UnitAdmissionMode = (typeof UNIT_ADMISSION_MODES)[number];

function admissionMode(value: string): UnitAdmissionMode {
  if ((UNIT_ADMISSION_MODES as readonly string[]).includes(value)) return value as UnitAdmissionMode;
  throw new Error(`--mode ${JSON.stringify(value)} is not one of: ${UNIT_ADMISSION_MODES.join(", ")}; admission is an explicit act and there is no default mode`);
}

/**
 * Both admission passes, exhaustive over the modes — a third mode has to say what it does before this compiles.
 *
 * The two vocabularies are deliberately different: `plan-only` reports what it WOULD do (`admit` / `rebuild` /
 * `new`), the executing pass reports what happened (`admitted` / `fell-to-rebuild` / `skipped-new`). One shared
 * vocabulary would let a dry run be read as a record of hits.
 */
async function unitAdmissionOutput(runDir: string, authorship: UnitAuthorship, mode: UnitAdmissionMode): Promise<Record<string, unknown>> {
  switch (mode) {
    case "plan-only": {
      const plan = await planUnitAdmission(runDir, authorship);
      return {
        mode,
        wrote: "nothing: this mode reads the run and decides, and admission itself is --mode admit",
        run: plan.runId,
        knowledgeEpoch: plan.knowledgeEpoch,
        planCatalogDigest: plan.planCatalogDigest,
        authorship: plan.authorship,
        candidates: plan.candidateStatement,
        summary: summariseAdmission(plan.account, ["admissible", "to rebuild", "new"]),
        units: plan.intents.map((intent) => (intent.intent === "admit"
          ? { unit: intent.unit.unitId, kind: intent.unit.kind, intent: intent.intent, identityDigest: intent.identityDigest, why: intent.statement }
          : intent.intent === "rebuild"
            ? { unit: intent.unit.unitId, kind: intent.unit.kind, intent: intent.intent, cause: intent.cause, why: intent.statement }
            : { unit: intent.unit.unitId, kind: intent.unit.kind, intent: intent.intent, why: intent.statement })),
        ledgerRows: plan.ledgerRows.map(admissionLedgerLine),
        retired: plan.retired.map((row) => ({ unit: row.unitId, kind: row.kind })),
        account: plan.account.statements,
        // The invalidation plan the intents above ARE: printed so the two can be read side by side rather than
        // taken on trust.
        invalidationPlan: plan.cachePlan.conservation.statements
      };
    }
    case "admit": {
      const report = await admitUnits(runDir, authorship);
      return {
        mode,
        run: report.runId,
        knowledgeEpoch: report.knowledgeEpoch,
        planCatalogDigest: report.planCatalogDigest,
        authorship: report.authorship,
        candidates: report.candidateStatement,
        summary: summariseAdmission(report.account, ["admitted", "fell to rebuild", "skipped as new"]),
        units: report.outcomes.map((outcome) => (outcome.outcome === "admitted"
          ? { unit: outcome.unit.unitId, kind: outcome.unit.kind, outcome: outcome.outcome, identityDigest: outcome.identityDigest, admittedFrom: outcome.source, why: outcome.statement }
          : outcome.outcome === "fell-to-rebuild"
            ? { unit: outcome.unit.unitId, kind: outcome.unit.kind, outcome: outcome.outcome, cause: outcome.cause, why: outcome.statement }
            : { unit: outcome.unit.unitId, kind: outcome.unit.kind, outcome: outcome.outcome, why: outcome.statement })),
        ledgerRows: report.ledgerRows.map(admissionLedgerLine),
        retired: report.retired.map((row) => ({ unit: row.unitId, kind: row.kind })),
        account: report.account.statements
      };
    }
  }
  return assertNever(mode, "unit admission mode");
}

/**
 * One prior ledger row and what the admission did with it. Every row is printed; nothing is capped.
 *
 * Typed as the row itself and exhaustive over its disposition, so a new arm of `CandidateDisposition` fails the
 * typecheck here instead of printing nothing — which is how a hand-written structural type loses a field in silence.
 */
function admissionLedgerLine(row: CandidateLedgerRow): Record<string, unknown> {
  const shared = { unit: row.unitId, knowledgeEpoch: row.knowledgeEpoch, disposition: row.disposition.state };
  switch (row.disposition.state) {
    case "offered": {
      const verification = row.disposition.verification;
      return {
        ...shared,
        bytes: verification.state,
        ...(verification.state === "drifted" ? { problems: verification.problems } : {})
      };
    }
    case "excluded":
      return { ...shared, cause: row.disposition.cause, why: row.disposition.statement };
  }
  return assertNever(row.disposition, "unit admission candidate disposition");
}

/**
 * One drafted or collected unit, as a line.
 *
 * `provenance` is printed because it is the one thing an operator cannot see any other way: a unit whose bytes were
 * re-entered from a prior verified draft and one a model just wrote are otherwise the same line.
 */
function unitReceiptLine(receipt: { unitId: string; documentId: string; kind: string; revision: boolean; provenance: UnitProvenance }): Record<string, unknown> {
  return { unit: receipt.unitId, document: receipt.documentId, kind: receipt.kind, revision: receipt.revision, provenance: describeProvenance(receipt.provenance) };
}

/** The over-budget mode, named. There is no default: truncation is not one of the options, and neither is guessing. */
function overBudgetMode(value: string): PacketOverBudgetMode {
  if ((PACKET_OVER_BUDGET_MODES as readonly string[]).includes(value)) return value as PacketOverBudgetMode;
  throw new Error(`--over-budget ${JSON.stringify(value)} is not one of: ${PACKET_OVER_BUDGET_MODES.join(", ")}`);
}
/**
 * `--authorship model-family:<name>` or `--authorship model-free:<name>`. Required, closed, and never defaulted.
 *
 * A cache identity says "a verified draft of THIS is still an answer", and a draft written by one model family is
 * not evidence about another. A default here would answer that question on the operator's behalf.
 */
function authorshipOf(value: string): UnitAuthorship {
  const separator = value.indexOf(":");
  const kind = separator < 0 ? value : value.slice(0, separator);
  // Trimmed HERE, at the boundary where a shell quoted the argument: "model-family: opus" and
  // "model-family:opus" name one author, and letting the space through would produce a different digest — a total
  // cache miss that reads as a real change. Core refuses an untrimmed name rather than normalizing it silently.
  const name = separator < 0 ? "" : value.slice(separator + 1).trim();
  if (name !== "") {
    if (kind === "model-family") return { kind: "model-family", family: name };
    if (kind === "model-free") return { kind: "model-free", generator: name };
  }
  throw new Error(`--authorship ${JSON.stringify(value)} must be model-family:<name> or model-free:<name>; an identity has to name who would have written the draft it stands for, and there is no default author`);
}

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
  plan-packet   Render the deterministic, bounded planner view of one frozen run; --unit <id> renders one authoring unit's view instead (read-only, zero model)
  unit-cache-identity Print the cache identity of every authoring unit of one planned run (read-only, zero model)
  unit-cache-admit   Re-enter previously verified units through the existing draft/collect gates (--mode required)
  plan          Validate a plan proposal against the frozen epoch and record plan/catalog.json + plan/dag.json
  request-append Append one requested document to plan/requests.json (recorded rows are immutable)
  begin      Start or restart one document authoring timer
  reading    Show which in-boundary decision code no source window covers yet — run it before freeze, where opening one is free
  freeze     Seal epoch 0, or re-seal justified supplements as epoch N+1; renders epoch-bound authoring packets
  source     Record a bounded source excerpt as evidence
  search     Search source under the run snapshot and record a reusable receipt
  checkpoint Save one completed section and its claims atomically; --unit <id> saves one authoring unit
  draft      Draft one section in parallel-safe isolation; leaves a receipt for collect (--unit <id> for a unit)
  collect    Serially record all pending section drafts into the timeline and manifest (--units for unit drafts)
  claims     Scaffold a claims skeleton from a section's markdown
  checklist  Record compatibility checklist dispositions
  workitem   Update the investigation plan and coverage ledger
  trace      Record call, data, business, state or cross-repository traces
  resume     List incomplete sections and resume a stopped run; --units lists what is left on the unit path
  assemble   Join completed sections into Markdown reports
  audit      Validate snapshot, evidence, claims, checklist and report structure; --document <id> scopes to one document, --units reruns the unit grounding audit
  status     Show progress and timing; --units shows the authoring-unit view of the plan

Examples:
  excavator overview --target ./workspace --audience both
  excavator overview --target ./workspace --no-codegraph --audience both
  excavator codegraph status --target ./workspace
  excavator codegraph build --target ./workspace --quiet
  excavator db-schema --target ./workspace --out ./db --descriptions descriptions.json
  excavator native-graph --target ./workspace --out ./nav
  excavator framework --target ./workspace --out ./fw
  excavator reading --run <run>
  excavator freeze --run <run>
  excavator feature --target ./workspace --subject "Account access" --aliases access,permission,role --audience both --detail detailed
  excavator search --run <run> --query "\\bTODO\\b|@deprecated" --regex --case-sensitive --reason "investigate unfinished behavior"
  excavator claims scaffold --run <run> --document <id> --section 1 --file section.md
  excavator checkpoint --run <run> --document <id> --section 1 --file section.md --claims claims.json
  excavator draft --run <run> --document <id> --section 1 --file section.md --claims claims.json
  excavator draft --run <run> --unit <unit-id> --file content.md --claims claims.json --summary summary.json
  excavator collect --run <run>
  excavator collect --run <run> --units
  excavator workitem --run <run> --file workitem-updates.json
  excavator trace --run <run> --file traces.json
  excavator checklist --run <run> --file checklist-updates.json
  excavator plan-packet --run <run> --unit <unit-id> --over-budget record-limitation --out unit-packet.md
  excavator unit-cache-identity --run <run> --authorship model-family:example
  excavator unit-cache-admit --run <run> --authorship model-free:fixture-plan --mode plan-only
  excavator audit --run <run> --document <id>
  excavator audit --run <run> --units
  excavator report --request request.json

Secret redaction:
  --redact            Blank secret-looking values in recorded source. ON BY DEFAULT; passing it changes nothing.
  --no-redact         Record source verbatim. Redaction costs evidence, but a leaked credential cannot be
                      recalled once the run directory or its HTML export is handed on, so verbatim is asked
                      for rather than defaulted into. \`excavator status\` and each report's front matter
                      state which mode a run used.

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
  "plan-packet": {
    synopsis: "plan-packet --run <dir> [--unit <id>] --over-budget refuse|record-limitation [--byte-limit N] [--out <file>]",
    flags: [
      "--run <dir>          Frozen run directory (required)",
      "--unit <id>          Render the view ONE authoring unit is written from (plan/catalog.json unit id) instead of the planner view",
      "--over-budget <how>  refuse (name it at the entry) or record-limitation (keep the whole packet) — required",
      "--byte-limit <n>     Declared byte bound (default 524288; with --unit, the plan's perUnitInputBytes for that unit's document)",
      "--out <file>         Write the packet here instead of stdout"
    ],
    example: "excavator plan-packet --run <run> --over-budget refuse --out packet.md",
    notes: "Read-only and deterministic: it writes nothing into the run and never truncates. Over the bound it either refuses by name or records the overrun as a limitation. With --unit every obligation gets its own row with its own evidence and trace ids and every bound record is rendered in full — nothing clipped, capped or truncated — and a synthesis unit is rendered from its collected children's summaries with no topic dossier at all."
  },
  "unit-cache-identity": {
    synopsis: "unit-cache-identity --run <dir> --authorship model-family:<name>|model-free:<name>",
    flags: [
      "--run <dir>          Planned run directory (required)",
      "--authorship <who>   model-family:<name> or model-free:<name> — required, no default"
    ],
    example: "excavator unit-cache-identity --run <run> --authorship model-free:fixture-plan",
    notes: "Read-only and deterministic: it writes nothing and calls no model. Each unit's identity is its own packet, composed with the three plan-global digest lines (topics catalog, plan catalog, recorded requests) normalized, then digested — so the epoch, the audience lens, the obligation scope, the ownership stubs and the budget rows are all in it, while a change to one topic does not move every unit of the run. A synthesis whose children are not collected has no identity yet and says so by name."
  },
  "unit-cache-admit": {
    synopsis: "unit-cache-admit --run <dir> --authorship model-family:<name>|model-free:<name> --mode plan-only|admit",
    flags: [
      "--run <dir>          Planned run directory (required)",
      "--authorship <who>   model-family:<name> or model-free:<name> — required, no default",
      "--mode <how>         plan-only (decide and report, write nothing) or admit (re-enter through draft+collect) — required"
    ],
    example: "excavator unit-cache-admit --run <run> --authorship model-free:fixture-plan --mode plan-only",
    notes: "A unit is admitted only when its cache identity equals the one its ledger row recorded AND its content, claims and summary on disk still digest to what that row promised. Admission then re-enters those exact bytes through `draft` and `collect` — the summary agreement check, the output budget, the grounding audit, the synthesis backlink check and the promised-artifact digests all run again, and a new receipt is minted; no stale receipt is ever revived. Every planned unit comes back as admitted, fell-to-rebuild (with the cause: a changed identity, drifted bytes, a collect refusal, or a pass halted by an earlier refusal) or skipped-new, and every prior ledger row is listed with what was done with it. A refusal leaves the receipt in place so a corrected re-draft can be collected."
  },
  plan: {
    synopsis: "plan --run <dir> (--fixture-plan | --proposal <file>) [--revise --reason <why>]",
    flags: [
      "--run <dir>          Frozen run directory (required)",
      "--fixture-plan       Derive the proposal deterministically from the catalog",
      "--proposal <file>    Validate a proposal produced elsewhere (a model, through the skill)",
      "--revise             Supersede the plan this run records by writing its next revision (requires --reason)",
      "--reason <why>       Why the recorded plan is being superseded (required with --revise)"
    ],
    example: "excavator plan --run <run> --proposal proposal.json",
    notes: "Writes plan/topics.json, plan/catalog.json and plan/dag.json. A recorded plan is identified by (knowledge epoch, plan revision) and written once: identical bytes are a no-op, different bytes for a revision already recorded are refused. --revise is the explicit way past that — it records revision N+1, naming revision N's digest, and archives revision N under plan/revisions/ before replacing the current files; a proposed revision that says exactly what the recorded plan says is refused as superseding nothing. A proposal that does not validate is refused by name and writes nothing; correct it and run again."
  },
  "request-append": {
    synopsis: "request-append --run <dir> --kind overview --audience product|engineering --detail standard|detailed --language <tag>",
    flags: [
      "--run <dir>          Run directory whose plan/requests.json is appended to (required)",
      "--kind <what>        overview — the only appendable kind (required)",
      "--audience <who>     One reader: product or engineering (required)",
      "--detail <level>     standard or detailed (required)",
      "--language <tag>     Output language of the appended document (required)"
    ],
    example: "excavator request-append --run <run> --kind overview --audience engineering --detail standard --language zh-CN",
    notes: "APPEND ONLY: the recorded rows are copied byte for byte and one row is added, so a duplicate document id and any change to a row already recorded are named refusals. The document id is derived from kind and audience, the same way prepare derives it. A FEATURE document may not be appended: its request names a knowledge boundary nothing here can check against what the run investigated — re-prepare the run with that feature requested. Appending leaves the recorded plan not covering the request set: authoring refuses by name until `plan --revise --reason <why>` records the next revision."
  },
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
    synopsis: "checkpoint --run <dir> (--document <id> --section <n> | --unit <id> --authorship <who>) --file <md> [--claims <json>] [--summary <json>]",
    flags: [
      "--run <dir>          Run directory (required)",
      "--document <id>      Document being authored (section keying)",
      "--section <n>        Section index (section keying)",
      "--unit <id>          Authoring unit id from plan/catalog.json (unit keying)",
      "--file <md>          Markdown to save (required)",
      "--claims <json>      Claims sidecar (array or {claims:[...]}); required with --unit",
      "--summary <json>     Unit summary (required with --unit)",
      "--authorship <who>   model-family:<name> or model-free:<name> — required with --unit, no default"
    ],
    example: "excavator checkpoint --run <run> --document <id> --section 1 --file section.md --claims claims.json",
    notes: "One keying or the other, never both. With --unit it is exactly `draft --unit` followed by `collect --units`."
  },
  draft: {
    synopsis: "draft --run <dir> (--document <id> --section <n> | --unit <id> --authorship <who>) --file <md> [--claims <json>] [--summary <json>]",
    flags: [
      "--run <dir>          Run directory (required)",
      "--document <id>      Document being authored (section keying)",
      "--section <n>        Section index (section keying)",
      "--unit <id>          Authoring unit id from plan/catalog.json (unit keying)",
      "--file <md>          Markdown to draft (required)",
      "--claims <json>      Claims sidecar (array or {claims:[...]}); required with --unit",
      "--summary <json>     Unit summary: covered topics, key statements, unknowns, terminology and the content/claims digests (required with --unit)",
      "--authorship <who>   model-family:<name> or model-free:<name> — required with --unit: the record says who wrote it, and the cache key is computed for that author"
    ],
    example: "excavator draft --run <run> --unit <unit-id> --file content.md --claims claims.json --summary summary.json",
    notes: "Parallel-safe either way: a draft writes only its own artifacts and a receipt, never the shared timeline or manifest. One keying or the other, never both. A unit draft is refused unless its summary covers exactly the plan's topics for that unit and records the digests of the very bytes being written. Its receipt records the author and the cache identity of the packet it was written from — the identity is computed here, never accepted as an argument — and its provenance is always `fresh`: only `unit-cache-admit` mints a cache-admitted record, and only against a verified ledger row."
  },
  collect: {
    synopsis: "collect --run <dir> [--units]",
    flags: [
      "--run <dir>          Run directory (required)",
      "--units              Collect pending authoring-unit drafts instead of section drafts"
    ],
    example: "excavator collect --run <run> --units",
    notes: "Serial barrier: records every pending draft into the timeline in a deterministic order — section drafts by default, unit drafts with --units. A no-op when nothing is pending, so it is safe to rerun."
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
    synopsis: "audit --run <dir> [--document <id>] [--units]",
    flags: [
      "--run <dir>          Run directory (required)",
      "--document <id>      Scope the audit to one document (advisory run-wide checks)",
      "--units              Rerun the authoring-unit grounding audit (read-only): every material obligation a unit reaches, grounded by that unit's own claims"
    ],
    example: "excavator audit --run <run> --document <id>",
    notes: "With --units it reports the plan's own obligation accounting, one three-state verdict per written unit, the open-origin exemptions by id, and the units nothing has been written for. It writes nothing; collect already applied the same verdict when each unit was recorded."
  },
  resume: {
    synopsis: "resume --run <dir> [--units]",
    flags: [
      "--run <dir>          Run directory (required)",
      "--units              List what is left on the authoring-unit path (read-only)"
    ],
    example: "excavator resume --run <run> --units"
  },
  status: {
    synopsis: "status --run <dir> [--units]",
    flags: [
      "--run <dir>          Run directory (required)",
      "--units              Show the authoring-unit view: every planned unit as collected, drafted or not yet written"
    ],
    example: "excavator status --run <run> --units"
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

/**
 * The summary plus the excerpt as actual lines, so recording a window also shows it.
 *
 * Control characters are stripped (tab kept). The excerpt is target source that has been redacted for
 * secrets but not for terminal control: writing it raw would let a file under investigation drive the
 * operator's terminal through ANSI escapes. The JSON path escapes them; this path has to do it itself.
 */
function renderSourceWindow(result: Record<string, unknown>): string {
  const { evidence } = result as RecordedWindow;
  const start = evidence?.startLine ?? 1;
  const body = (evidence?.content ?? "")
    .split("\n")
    .map((line, index) => `${String(start + index).padStart(5)}  ${stripControl(line)}`)
    .join("\n");
  return `${sourceWindowSummary(result)}\n\n${body}`;
}

/** Drop C0/C1 control characters and DEL, keeping tab — nothing in source needs them to be readable. */
function stripControl(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
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
