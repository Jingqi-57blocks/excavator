#!/usr/bin/env -S node --experimental-strip-types --no-warnings
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Audience, BudgetConfig, ChecklistItem, DetailLevel, DocumentKind, FeatureRequest, InvestigationWorkItem, ReportRequest, SectionClaim, TraceRecord } from "./base/types.ts";
import { addSourceEvidence, auditRun, freezeRun, prepareRun, readingCheck, runStatus, searchSourceEvidence, updateChecklist, updateTraces, updateWorkItems, type SupplementInput } from "./run/run.ts";
import { draftUnit, type UnitDraftInput } from "./report/unit-draft.ts";
import { collectUnits } from "./report/unit-collect.ts";
import { checkpointUnit } from "./report/unit-checkpoint.ts";
import { resumeUnits, unitStatus } from "./report/unit-status.ts";
import { renderUnitPacketForRun } from "./report/unit-packet-source.ts";
import { loadCoverageStateFacts } from "./report/coverage-companion-source.ts";
import { renderCoverageCompanion } from "./report/coverage-companion.ts";
import { loadRunUnitIdentities } from "./report/unit-cache-identity-source.ts";
import { admitUnits, planUnitAdmission } from "./report/unit-cache-admission-run.ts";
import { summariseAdmission, type CandidateLedgerRow } from "./report/unit-cache-admission.ts";
import { describeAuthorship, describeProvenance, type UnitAuthorship, type UnitProvenance } from "./report/unit-provenance.ts";
import { readUnitGroundingForRun, summariseUnitGroundingReading } from "./report/unit-grounding-reading.ts";
import { readUnitClaimBindingForRun, summariseUnitClaimBindingReading } from "./report/unit-claim-binding-source.ts";
import { checkRunConsistency } from "./report/unit-consistency-source.ts";
import { describeFinding } from "./report/unit-consistency.ts";
import { assembleUnits, UNIT_ASSEMBLE_MODES, type UnitAssembleMode } from "./run/stages/unit-assemble-stage.ts";
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
      case "coverage-companion": {
        // Read-only, same shape as `plan-packet`: this run's coverage state from the four ledgers that own it,
        // every statement naming its own denominator, with no combined figure. It writes nothing.
        const args = parseArgs(argv);
        const { facts, readPaths } = await loadCoverageStateFacts(required(args.run, "--run"));
        const markdown = renderCoverageCompanion(facts);
        if (args.out) {
          await writeFile(resolve(args.out), markdown);
          print({ out: resolve(args.out), run: facts.runId, knowledgeEpoch: facts.knowledgeEpoch, bytes: Buffer.byteLength(markdown, "utf8"), readPaths });
        } else process.stdout.write(markdown);
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
      case "unit-consistency": {
        // Read-only: the five cross-unit content properties no collect gate can see, over the ASSEMBLED unit path,
        // plus the exact set of units a repair would have to redraw. It writes nothing and calls no model. Exit 1
        // when the checker found something, so a pipeline can gate on it without parsing the reading.
        const args = parseArgs(argv);
        const reading = await checkRunConsistency(required(args.run, "--run"));
        print({
          ...reading,
          lines: [
            ...reading.result.readings.map((row) => row.statement),
            ...reading.result.findings.map((finding) => `${finding.kind} [${finding.unitIds.join(", ")}]: ${describeFinding(finding)}`),
            reading.repair.action
          ]
        });
        if (reading.result.findings.length > 0) process.exitCode = 1;
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
            succession: result.revision.succession,
            // What this recording costs in work already done: the drafted-but-uncollected units it stranded, by
            // id, plus the one-line reading. Printed here rather than left to the next `unit-collect`, which would
            // name them one at a time and only when someone tried.
            strandedDrafts: result.revision.strandedDrafts
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
        requireUnitKeyed(args, "checkpoint");
        const result = await checkpointUnit(required(args.run, "--run"), await unitDraftInput(args));
        print({ checkpointed: unitReceiptLine(result.receipt), collected: result.collected.collected.map(unitReceiptLine) });
        break;
      }
      case "draft": {
        const args = parseArgs(argv);
        requireUnitKeyed(args, "draft");
        print({ drafted: unitReceiptLine(await draftUnit(required(args.run, "--run"), await unitDraftInput(args))) });
        break;
      }
      case "collect": {
        const args = parseArgs(argv);
        requireUnitScoped(args, "collect");
        const units = await collectUnits(required(args.run, "--run"));
        print({
          collected: units.collected.length,
          units: units.collected.map(unitReceiptLine),
          ...(units.unplanned.length ? { unplanned: units.unplanned.map(unitReceiptLine) } : {})
        });
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
      case "assemble": {
        const args = parseArgs(argv);
        if (unitScoped(args, "assemble")) {
          // The unit path's deterministic assembly. `--mode` is required and has no default: one arm writes the
          // deliverable into the run and the other only proves it could be written.
          print(await assembleUnits(required(args.run, "--run"), assembleMode(required(args.mode, "--mode"))));
          break;
        }
        // `--units` is absent, and the two refusals are ordered by how much the command line already says.
        // `--mode` belongs to the unit path and to nothing else, so it names the missing token precisely; the
        // general refusal below covers a bare `assemble --run <dir>`.
        if (args.mode !== undefined) {
          throw new Error(`excavator assemble takes --mode only together with --units; the section assemble is retired, so --units is the only assembly there is. Add --units.`);
        }
        throw new Error(`excavator assemble requires --units: the section assemble is retired and the unit path is the only assembly, so there is nothing to fall back to. Add --units --mode plan-only|write.`);
      }
      case "audit": {
        const args = parseArgs(argv);
        if (unitScoped(args, "audit")) {
          // The read-only rerun of the grounding verdict `collect` already applied. Same rules, same denominator.
          const reading = await readUnitGroundingForRun(required(args.run, "--run"));
          // The second per-unit audit on this command: the claim ↔ prose binding contract. It is NOT part of the
          // grounding result because `auditUnitFromDisk` is a collect gate and this is an audit finding — the
          // section path's own split, kept. Both readings load the same run read-only; neither writes.
          //
          // EACH READING ESTABLISHES ITS OWN PREMISES, so the plan view is loaded twice. That is the house form —
          // every `…ForRun` entry point in `src/report/` reads the manifest, checks the knowledge epoch with its
          // own verb and re-checks the plan epoch — and hoisting it here would put a seventh copy of that
          // sequence in the CLI layer. Measured on a real run rather than assumed: the second load is ~6 ms, and
          // it does not close the race it looks like it would, because the window that matters is the per-unit
          // file reads inside each loop, which both readings do either way.
          const binding = await readUnitClaimBindingForRun(required(args.run, "--run"));
          print({
            ...reading,
            binding,
            lines: [...summariseUnitGroundingReading(reading), ...summariseUnitClaimBindingReading(binding)]
          });
          if (reading.units.some((row) => row.verdict.conclusion === "violations")
            || binding.units.some((row) => row.verdict.conclusion === "violations")) process.exitCode = 1;
          break;
        }
        const result = await auditRun(required(args.run, "--run"), args.document ? { documentId: args.document } : {});
        print(result);
        if (result.findings.some((finding) => finding.level === "error")) process.exitCode = 1;
        break;
      }
      case "resume": {
        const args = parseArgs(argv);
        requireUnitScoped(args, "resume");
        print(await resumeUnits(required(args.run, "--run")));
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
  // `--author-ms` is REFUSED, not ignored. `parseArgs` drops unrecognised flags silently, so removing the mapping
  // alone would let a command re-run from shell history keep the flag and lose its value without a word — the same
  // silent drift `requireUnitKeyed` refuses by name for the retired section keying.
  if (args.authorMs != null) {
    throw new Error(`--author-ms is retired (57B-480): its two executors went with the section authoring chain, and the unit path's budget authority is the plan's BYTE budget. Drop the flag; there is no wall-clock authoring budget to set.`);
  }
  const mapping: Record<string, keyof BudgetConfig> = {
    prepareMs: "prepareMs", maxGraphQueries: "maxGraphQueries", maxSourceWindows: "maxSourceWindows",
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
 * `--feature-key` IS EXACTLY AS REQUIRED AS THE KIND IT BELONGS TO, in both directions. A feature document without
 * one has a boundary with no name; an overview document with one has a boundary the project scope does not have.
 * Neither is defaulted and neither is dropped: a flag silently ignored is how an operator who meant `--kind feature`
 * gets a project-scope document and a duplicate-id refusal two commands later. Whether the key names a feature this
 * run actually investigated is NOT decided here — `request-append-boundary.ts` checks it against
 * `contract/run-intent.json`, so the API caller and the CLI caller get the same verdict.
 */
function appendedDocument(args: Record<string, string>): LegacyDocumentRequest {
  const kind = documentKind(required(args.kind, "--kind"));
  const audience = singleAudience(required(args.audience, "--audience"));
  const featureKey = appendedFeatureKey(kind, args.featureKey);
  return {
    documentId: plannedDocumentId(kind, audience, featureKey),
    kind,
    audience,
    featureKey,
    detailLevel: detailLevel(required(args.detail, "--detail")),
    language: required(args.language, "--language")
  };
}

/** Exhaustive over the kinds: a document kind whose boundary flag nobody stated does not compile. */
function appendedFeatureKey(kind: DocumentKind, value: string | undefined): string | null {
  switch (kind) {
    case "overview":
      if (value !== undefined) {
        throw new Error(`--feature-key ${JSON.stringify(value)} was given for --kind overview; the project scope is not addressed by feature. Drop the flag, or pass --kind feature.`);
      }
      return null;
    case "feature":
      return required(value, "--feature-key (a feature document is written against exactly one feature key from contract/run-intent.json)");
  }
  return assertNever(kind, "appended document kind");
}

function documentKind(value: string): DocumentKind {
  if (value === "overview" || value === "feature") return value;
  throw new Error(`--kind ${JSON.stringify(value)} is not one of: overview, feature`);
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
 * True when a two-view read command was keyed to ONE authoring unit rather than to the whole run.
 *
 * `plan-packet` is the only such command: without `--unit` it renders the planner view of the run, with `--unit`
 * the bounded view one unit is written from. There is no default and no inference. `--document`/`--section` are
 * refused rather than ignored — they are the retired section keying, so a caller passing them is asking for a
 * view this command never had, and answering with the run-wide packet would answer a different question.
 */
function unitKeyed(args: Record<string, string>, command: string): boolean {
  if (!args.unit) return false;
  if (args.document || args.section) {
    throw new Error(`excavator ${command} does not take --document <id> --section <n>: the section keying is retired, and this command's two views are the whole run (no --unit) or one authoring unit (--unit <id>)`);
  }
  return true;
}

/**
 * The unit keying is the ONLY keying these commands have: the section arms of `checkpoint` and `draft` are
 * retired (57B-480). An invocation that still carries `--document <id> --section <n>` is refused BY NAME rather
 * than run with those two flags ignored — an operator repeating a command out of shell history would otherwise
 * get a unit-shaped refusal about a missing `--unit` and no word about the keying that went away.
 */
function requireUnitKeyed(args: Record<string, string>, command: string): void {
  // The retired flags are named FIRST, and for both shapes an old command line arrives in: with `--unit` (an
  // operator who added the new flag and left the old ones) and without it. Delegating to `unitKeyed` said
  // "either --unit <id> or --document <id> --section <n>, not both", which advertises the retired keying as a
  // live alternative — so the natural retry was to drop `--unit` and be refused again.
  if (args.document || args.section) {
    throw new Error(`excavator ${command} no longer takes --document <id> --section <n>: the section keying is retired, so this command is keyed by --unit <id> alone`);
  }
  if (!args.unit) {
    throw new Error(`excavator ${command} requires --unit <id>: the section keying is retired, so authoring writes one planned unit of plan/catalog.json and nothing else`);
  }
}

/** The run-wide half of the same retirement: `--units` is required because there is no other arm left. */
function requireUnitScoped(args: Record<string, string>, command: string): void {
  if (unitScoped(args, command)) return;
  throw new Error(`excavator ${command} requires --units: the section arm is retired, so this command is run-wide over the planned units and has nothing to fall back to`);
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

/**
 * The unit-assemble mode. Required at the call site, so an unknown value is a refusal rather than a fallback.
 *
 * Same shape as `admissionMode` and for the same reason: `write` puts the deliverable on disk and `plan-only`
 * cannot, so a default would be a mode somebody gets by forgetting to say which one they wanted.
 */
function assembleMode(value: string): UnitAssembleMode {
  if ((UNIT_ASSEMBLE_MODES as readonly string[]).includes(value)) return value as UnitAssembleMode;
  throw new Error(`--mode ${JSON.stringify(value)} is not one of: ${UNIT_ASSEMBLE_MODES.join(", ")}; assembling the unit path is an explicit act and there is no default mode`);
}

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
  coverage-companion  Render this run's coverage state: four denominators, each naming its own ledger, no combined figure (read-only, zero model)
  unit-cache-identity Print the cache identity of every authoring unit of one planned run (read-only, zero model)
  unit-cache-admit   Re-enter previously verified units through the existing draft/collect gates (--mode required)
  unit-consistency   Check the assembled unit path for the five cross-unit content defects no collect gate sees, and print the exact repair set (read-only, zero model)
  plan          Validate a plan proposal against the frozen epoch and record plan/catalog.json + plan/dag.json
  request-append Append one requested document to plan/requests.json (recorded rows are immutable)
  reading    Show which in-boundary decision code no source window covers yet — run it before freeze, where opening one is free
  freeze     Seal epoch 0, or re-seal justified supplements as epoch N+1 (writes the sealed epoch and nothing else)
  source     Record a bounded source excerpt as evidence
  search     Search source under the run snapshot and record a reusable receipt
  checkpoint Save one authoring unit atomically: draft it and collect it in one command (--unit required)
  draft      Draft one authoring unit in parallel-safe isolation; leaves a receipt for collect (--unit required)
  collect    Serially record all pending unit drafts into the ledger and timeline (--units required)
  checklist  Record compatibility checklist dispositions
  workitem   Update the investigation plan and coverage ledger
  trace      Record call, data, business, state or cross-repository traces
  resume     List what is left to draft and collect on the unit path (--units required)
  assemble   Join collected units into the run's Markdown deliverables (--units and --mode required)
  audit      Validate snapshot, evidence, claims, checklist and report structure; --document <id> scopes to one document, --units reruns the unit grounding and claim-binding audits
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
  excavator checkpoint --run <run> --unit <unit-id> --file content.md --claims claims.json --summary summary.json --authorship model-family:example
  excavator draft --run <run> --unit <unit-id> --file content.md --claims claims.json --summary summary.json --authorship model-family:example
  excavator collect --run <run> --units
  excavator workitem --run <run> --file workitem-updates.json
  excavator trace --run <run> --file traces.json
  excavator checklist --run <run> --file checklist-updates.json
  excavator plan-packet --run <run> --unit <unit-id> --over-budget record-limitation --out unit-packet.md
  excavator assemble --run <run> --units --mode write
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
  "coverage-companion": {
    synopsis: "coverage-companion --run <dir> [--out <file>]",
    flags: [
      "--run <dir>          Planned run directory (required)",
      "--out <file>         Write the companion here instead of stdout"
    ],
    example: "excavator coverage-companion --run <run> --out coverage.md",
    notes: "Read-only, deterministic, zero model. Four families, four ledgers, four denominators: the plan's material obligation accounting, this run's read-obligation ledger, the sealed epoch's completeness closure, and the obligation ledger's determinations. Every statement names the ONE ledger its denominator came from, and there is no combined coverage figure and no percentage anywhere — combining two of these ledgers needs an id join that was measured to lose 665 of 946 rows silently. An empty denominator reads as `vacuous`, never as covered, and `ledger-absent` (nobody can tell) stays a different sentence from `ledger-empty` (this run genuinely recorded none). A closure field an older epoch never sealed is reported NOT MEASURED, never zero."
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
  "unit-consistency": {
    synopsis: "unit-consistency --run <dir>",
    flags: ["--run <dir>          Assembled run directory (required)"],
    example: "excavator unit-consistency --run <run>",
    notes: "Read-only, deterministic, zero model. It checks only what no collect gate can see: one term with two meanings inside a document, a `fact` or `inferred` claim linked to an obligation the ledger records as cannot-determine or searched-not-found, one obligation asserted by one unit and disclaimed by another (and two units disagreeing about which side of a comparison a piece of evidence is on), a `](#…)` or an `<a id>` a model wrote that the assembled document cannot resolve or holds twice, and a lens violation in visible prose. It re-checks no topic coverage, no disposition, no grounding audit and no child digest SEMANTICS — those have denominators one level down, and a second derivation of any of them would be a second denominator. It refuses unless the assembled deliverable on disk is the one this plan and these collected units produce. The repair set is exactly the units the findings name plus the units written from them, each row naming why; the coverage account is ROUTED rather than seeded — every defective coverage kind is owed by the investigation's reading, the obligation ledger's determinations or the plan, so re-drafting a unit cannot pay it. Exit code 1 when there is a finding."
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
    synopsis: "request-append --run <dir> --kind overview|feature [--feature-key <key>] --audience product|engineering|prd --detail standard|detailed --language <tag>",
    flags: [
      "--run <dir>          Run directory whose plan/requests.json is appended to (required)",
      "--kind <what>        overview or feature (required)",
      "--feature-key <key>  Required with --kind feature, refused with --kind overview: a key contract/run-intent.json binds",
      "--audience <who>     One reader: product, engineering, or prd (feature documents only) (required)",
      "--detail <level>     standard or detailed (required)",
      "--language <tag>     Output language of the appended document (required)"
    ],
    example: "excavator request-append --run <run> --kind overview --audience engineering --detail standard --language zh-CN",
    notes: "APPEND ONLY: the recorded rows are copied byte for byte and one row is added, so a duplicate document id and any change to a row already recorded are named refusals. The document id is derived from kind, audience and feature key, the same way prepare derives it. A FEATURE document's key is CHECKED against contract/run-intent.json — a key this run did not investigate is a named refusal listing the keys it did, because that document would have no knowledge to be written from. Appending leaves the recorded plan not covering the request set: authoring refuses by name until `plan --revise --reason <why>` records the next revision."
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
    notes: "The reading boundary — what the investigation never opened — is reported by `excavator reading --run <dir>` before freeze, and by the coverage companion after it. Freeze itself writes only the sealed epoch; it no longer renders a per-document authoring packet (57B-480)."
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
    synopsis: "checkpoint --run <dir> --unit <id> --file <md> --claims <json> --summary <json> --authorship <who>",
    flags: [
      "--run <dir>          Run directory (required)",
      "--unit <id>          Authoring unit id from plan/catalog.json (required)",
      "--file <md>          Markdown to save (required)",
      "--claims <json>      Claims sidecar (array or {claims:[...]}) (required)",
      "--summary <json>     Unit summary (required)",
      "--authorship <who>   model-family:<name> or model-free:<name> — required, no default"
    ],
    example: "excavator checkpoint --run <run> --unit <unit-id> --file content.md --claims claims.json --summary summary.json --authorship model-family:example",
    notes: "Exactly `draft --unit` followed by `collect --units`, in one command. The section keying (--document/--section) is retired and refused by name."
  },
  draft: {
    synopsis: "draft --run <dir> --unit <id> --file <md> --claims <json> --summary <json> --authorship <who>",
    flags: [
      "--run <dir>          Run directory (required)",
      "--unit <id>          Authoring unit id from plan/catalog.json (required)",
      "--file <md>          Markdown to draft (required)",
      "--claims <json>      Claims sidecar (array or {claims:[...]}) (required)",
      "--summary <json>     Unit summary: covered topics, key statements, unknowns, terminology and the content/claims digests (required)",
      "--authorship <who>   model-family:<name> or model-free:<name> — required: the record says who wrote it, and the cache key is computed for that author"
    ],
    example: "excavator draft --run <run> --unit <unit-id> --file content.md --claims claims.json --summary summary.json",
    notes: "Parallel-safe: a draft writes only its own artifacts and a receipt, never the shared ledger or timeline. The section keying (--document/--section) is retired and refused by name. A unit draft is refused unless its summary covers exactly the plan's topics for that unit and records the digests of the very bytes being written. Its receipt records the author and the cache identity of the packet it was written from — the identity is computed here, never accepted as an argument — and its provenance is always `fresh`: only `unit-cache-admit` mints a cache-admitted record, and only against a verified ledger row."
  },
  collect: {
    synopsis: "collect --run <dir> --units",
    flags: [
      "--run <dir>          Run directory (required)",
      "--units              Collect every pending authoring-unit draft (required: the section barrier is retired)"
    ],
    example: "excavator collect --run <run> --units",
    notes: "Serial barrier: records every pending unit draft into the ledger and timeline in the plan's own collection order. A no-op when nothing is pending, so it is safe to rerun."
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
    synopsis: "assemble --run <dir> --units --mode plan-only|write",
    flags: [
      "--run <dir>          Run directory (required)",
      "--units              Assemble the authoring-unit path (required, run-wide: the section assemble is retired)",
      "--mode <how>         plan-only (prove the assembly, write nothing) or write — required, no default"
    ],
    example: "excavator assemble --run <run> --units --mode write",
    notes: "It is all-or-nothing per run: every unit of every planned document must be collected against the recorded plan and this epoch, and every unit's content, claims and summary on disk must still digest to what its ledger row promised, or the run is refused by name with the offending unit ids. What it writes is deterministic and carries no clock reading — front matter (request row, both policy references, epoch and plan digests), a contents table in the plan's one authoring order, per-unit navigation anchors, then each unit's own collected bytes — plus a claims companion keyed by (unit, claim id) so two units may share a claim id, a traces companion selected only by explicit trace-id reference, and this run's coverage companion. It writes no coverage figure of its own and touches no section-path file; a target the section path already names is a refusal, not an overwrite."
  },
  audit: {
    synopsis: "audit --run <dir> [--document <id>] [--units]",
    flags: [
      "--run <dir>          Run directory (required)",
      "--document <id>      Scope the audit to one document (advisory run-wide checks)",
      "--units              Rerun the two per-unit audits (read-only): every material obligation a unit reaches grounded by that unit's own claims, and every claim statement bound to that unit's own prose"
    ],
    example: "excavator audit --run <run> --document <id>",
    notes: "With --units it reports the plan's own obligation accounting, one three-state grounding verdict per written unit, the open-origin exemptions by id, and the units nothing has been written for; then, under `binding`, one three-state verdict per unit for the claim \u2194 prose contract \u2014 an unclaimed substantive statement, a claim statement absent from the unit that declares it, a statement too short to bind, and substantive prose carrying no evidence-level marker. It writes nothing; collect already applied the grounding verdict when each unit was recorded, and the binding contract is checked here rather than at collect so a written unit can be inspected instead of refused."
  },
  resume: {
    synopsis: "resume --run <dir> --units",
    flags: [
      "--run <dir>          Run directory (required)",
      "--units              List what is left on the authoring-unit path (required, read-only)"
    ],
    example: "excavator resume --run <run> --units",
    notes: "Read-only. `collect` is the only writer of the shared unit ledger, so a unit run is resumed by drafting what is unwritten and collecting what is drafted — both named in the output."
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
