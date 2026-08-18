import type { ArtifactResult } from "../base/artifact-result.ts";
import type { EvidenceItem } from "../base/types.ts";
import { canonicalJson, REDACTION_VERSION, sha256, stableJson } from "../base/util.ts";
import {
  obligationsContentDigest, requireObligationDeclarations,
  type DecisionObligation, type ObligationDeclarations, type ObligationResidual, type SourceReadingObligation
} from "../obligation/declarations.ts";
import { evidenceFromWindow, MAX_WINDOW_LINES, SourceReader } from "../snapshot/source.ts";
import { readSpecsContentDigest, requireReadSpecs, type ReadSpec, type ReadSpecsArtifact } from "../workset/read-specs.ts";
import { EVIDENCE_BOUND_POLICY_VERSION } from "./evidence-store.ts";

export const READ_EXECUTION_VERSION = "read-execution-v1";

export type ReadExecutionOutcome = "source" | "empty" | "unavailable";

export interface ReadExecutionRecord {
  readonly id: string;
  readonly readSpecId: string;
  readonly declarationId: string;
  readonly path: string;
  readonly requestedSpan: { readonly startLine: number; readonly endLine: number };
  readonly observedSpan: { readonly startLine: number; readonly endLine: number } | null;
  readonly outcome: ReadExecutionOutcome;
  readonly evidenceIds: readonly string[];
  readonly cause?: string;
}

export interface DecisionDisposition {
  readonly declarationId: string;
  readonly readSpecId: string;
  readonly executionId: string;
  readonly status: "fulfilled" | "closed-negative" | "pending";
  readonly positiveKnowledge: boolean;
  readonly evidenceIds: readonly string[];
}

export interface ResidualRetention {
  readonly residualId: string;
  readonly readSpecId: string;
  readonly executionId: string;
  readonly status: "residual";
  readonly evidenceIds: readonly string[];
}

export interface InvestigationResults {
  readonly version: typeof READ_EXECUTION_VERSION;
  readonly identity: {
    readonly snapshotId: string;
    readonly filesContentManifestDigest: string;
    readonly worksetDigest: string;
    readonly obligationsDigest: string;
    readonly judgementsDigest: string;
    readonly evidencePolicy: string;
  };
  /** Reserved, recorded input surface for accepted L7 judgements. Empty means no judgement was consumed. */
  readonly judgements: readonly never[];
  readonly executions: readonly ReadExecutionRecord[];
  readonly dispositions: readonly DecisionDisposition[];
  readonly residuals: readonly ResidualRetention[];
  readonly summary: {
    readonly authorized: number;
    readonly source: number;
    readonly empty: number;
    readonly unavailable: number;
    readonly fulfilled: number;
    readonly closedNegative: number;
    readonly pending: number;
    readonly residuals: number;
  };
}

export interface ExecuteReadSpecsInput {
  readonly target: string;
  readonly snapshotId: string;
  readonly filesContentManifestDigest: string;
  readonly cacheDir: string;
  readonly maxWindows: number;
  readonly maxCharacters: number;
  readonly redact: boolean;
  readonly workset: ReadSpecsArtifact;
  readonly obligations: ObligationDeclarations;
}

export interface ExecuteReadSpecsResult {
  readonly artifact: InvestigationResults;
  readonly evidence: readonly EvidenceItem[];
  readonly stats: { readonly windows: number; readonly characters: number; readonly hits: number };
}

/** Execute exactly the declared ReadSpec set. Paths and spans come only from L5; L7 never invents a read. */
export async function executeReadSpecs(input: ExecuteReadSpecsInput): Promise<ExecuteReadSpecsResult> {
  requireReadSpecs(input.workset);
  requireObligationDeclarations(input.obligations);
  const reader = new SourceReader({
    target: input.target,
    snapshotId: input.snapshotId,
    cacheDir: input.cacheDir,
    maxWindows: input.maxWindows,
    maxCharacters: input.maxCharacters,
    redact: input.redact
  });
  const declarations = new Map(input.obligations.declarations
    .filter((row): row is SourceReadingObligation => row.kind === "source-reading")
    .map((row) => [row.readSpecId, row]));
  const evidenceById = new Map<string, EvidenceItem>();
  const executions: ReadExecutionRecord[] = [];
  for (const spec of [...input.workset.specs].sort((a, b) => a.id.localeCompare(b.id))) {
    const declaration = declarations.get(spec.id);
    if (!declaration) throw new Error(`ReadSpec ${spec.id} has no layer-6 source-reading declaration`);
    const result = await executeOne(reader, input.snapshotId, spec, declaration);
    for (const item of result.evidence) {
      const prior = evidenceById.get(item.id);
      if (prior && stableJson(prior) !== stableJson(item)) throw new Error(`Read execution produced conflicting evidence id ${item.id}`);
      evidenceById.set(item.id, item);
    }
    executions.push(result.execution);
  }
  const bySpec = new Map(executions.map((row) => [row.readSpecId, row]));
  const dispositions = input.obligations.declarations
    .filter((row): row is DecisionObligation => row.kind === "decision-reading")
    .map((row) => disposeDecision(row, requireExecution(bySpec, row.readSpecId)))
    .sort((a, b) => a.declarationId.localeCompare(b.declarationId));
  const residuals = input.obligations.residuals
    .map((row) => retainResidual(row, requireExecution(bySpec, row.readSpecId)))
    .sort((a, b) => a.residualId.localeCompare(b.residualId));
  const artifact: InvestigationResults = {
    version: READ_EXECUTION_VERSION,
    identity: {
      snapshotId: input.snapshotId,
      filesContentManifestDigest: input.filesContentManifestDigest,
      worksetDigest: readSpecsContentDigest(input.workset),
      obligationsDigest: obligationsContentDigest(input.obligations),
      judgementsDigest: sha256(canonicalJson([])),
      evidencePolicy: `${EVIDENCE_BOUND_POLICY_VERSION}-${REDACTION_VERSION}-${input.redact ? "redacted" : "plain"}`
    },
    judgements: [],
    executions,
    dispositions,
    residuals,
    summary: summarize(executions, dispositions, residuals)
  };
  const evidence = [...evidenceById.values()];
  requireInvestigationResults(artifact, input.workset, input.obligations, evidence);
  return { artifact, evidence, stats: reader.stats };
}

/** Persisted-reader validation. It binds every source/ledger result to L5, L6 and the recorded evidence set. */
export function requireInvestigationResults(
  value: unknown,
  workset: ReadSpecsArtifact,
  obligations: ObligationDeclarations,
  evidence: readonly EvidenceItem[] = []
): asserts value is InvestigationResults {
  requireReadSpecs(workset);
  requireObligationDeclarations(obligations);
  if (!value || typeof value !== "object") throw new Error("investigation results are not an object");
  const artifact = value as Partial<InvestigationResults>;
  if (artifact.version !== READ_EXECUTION_VERSION || !artifact.identity || !Array.isArray(artifact.judgements)
    || !Array.isArray(artifact.executions) || !Array.isArray(artifact.dispositions)
    || !Array.isArray(artifact.residuals) || !artifact.summary) {
    throw new Error(`investigation results are not ${READ_EXECUTION_VERSION}`);
  }
  if (artifact.judgements.length !== 0 || artifact.identity.judgementsDigest !== sha256(canonicalJson(artifact.judgements))) {
    throw new Error("investigation results contain an unvalidated judgement input");
  }
  if (artifact.identity.worksetDigest !== readSpecsContentDigest(workset)
    || artifact.identity.obligationsDigest !== obligationsContentDigest(obligations)) {
    throw new Error("investigation results do not belong to the recorded ReadSpecs and declarations");
  }
  const specs = new Map(workset.specs.map((row) => [row.id, row]));
  const readingDeclarations = new Map(obligations.declarations
    .filter((row): row is SourceReadingObligation => row.kind === "source-reading")
    .map((row) => [row.readSpecId, row]));
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const executions = new Map<string, ReadExecutionRecord>();
  for (const execution of artifact.executions) {
    const spec = specs.get(execution.readSpecId);
    const declaration = readingDeclarations.get(execution.readSpecId);
    if (!spec || !declaration || execution.declarationId !== declaration.id) throw new Error(`execution ${execution.id} has no matching ReadSpec and source-reading declaration`);
    if (execution.id !== `EXEC-${sha256(spec.id).slice(0, 16)}`) throw new Error(`execution ${execution.id} does not have the stable id of ${spec.id}`);
    if (executions.has(execution.readSpecId)) throw new Error(`ReadSpec ${execution.readSpecId} was executed more than once`);
    if (execution.path !== spec.path || stableJson(execution.requestedSpan) !== stableJson(spec.span)) throw new Error(`execution ${execution.id} changed its authorized path or span`);
    if (!execution.evidenceIds.length || new Set(execution.evidenceIds).size !== execution.evidenceIds.length) throw new Error(`execution ${execution.id} has no unique named result evidence`);
    if ((execution.outcome === "source" && execution.cause !== undefined)
      || (execution.outcome !== "source" && !execution.cause?.trim())) throw new Error(`execution ${execution.id} has an invalid outcome cause`);
    validateEvidenceKinds(execution, evidenceById);
    executions.set(execution.readSpecId, execution);
  }
  if (executions.size !== specs.size) throw new Error(`investigation executed ${executions.size} of ${specs.size} ReadSpecs`);

  const decisions = new Map(obligations.declarations
    .filter((row): row is DecisionObligation => row.kind === "decision-reading")
    .map((row) => [row.id, row]));
  const disposed = new Set<string>();
  for (const disposition of artifact.dispositions) {
    const declaration = decisions.get(disposition.declarationId);
    if (!declaration || disposed.has(disposition.declarationId) || disposition.readSpecId !== declaration.readSpecId) throw new Error(`decision disposition ${disposition.declarationId} is missing, duplicate, undeclared or detached from its ReadSpec`);
    const execution = executions.get(disposition.readSpecId);
    if (!execution || execution.id !== disposition.executionId || stableJson(execution.evidenceIds) !== stableJson(disposition.evidenceIds)) throw new Error(`decision disposition ${disposition.declarationId} is not bound to its execution evidence`);
    const expected = dispositionFor(execution.outcome);
    if (disposition.status !== expected.status || disposition.positiveKnowledge !== expected.positiveKnowledge) throw new Error(`decision disposition ${disposition.declarationId} misstates ${execution.outcome}`);
    disposed.add(disposition.declarationId);
  }
  if (disposed.size !== decisions.size) throw new Error(`investigation disposed ${disposed.size} of ${decisions.size} decision-reading declarations`);

  const residualRows = new Map(obligations.residuals.map((row) => [row.id, row]));
  const retained = new Set<string>();
  for (const residual of artifact.residuals) {
    const declared = residualRows.get(residual.residualId);
    const execution = executions.get(residual.readSpecId);
    if (!declared || declared.readSpecId !== residual.readSpecId || retained.has(residual.residualId) || !execution
      || residual.executionId !== execution.id || stableJson(residual.evidenceIds) !== stableJson(execution.evidenceIds)) {
      throw new Error(`probe residual ${residual.residualId} was dropped or detached from its execution`);
    }
    retained.add(residual.residualId);
  }
  if (retained.size !== residualRows.size) throw new Error(`investigation retained ${retained.size} of ${residualRows.size} probe-unavailable residuals`);
  if (stableJson(artifact.summary) !== stableJson(summarize(artifact.executions, artifact.dispositions, artifact.residuals))) {
    throw new Error("investigation result summary does not reconcile with its rows");
  }
}

export function investigationResultsDigest(artifact: InvestigationResults): string { return sha256(canonicalJson(artifact)); }

function requireExecution(bySpec: ReadonlyMap<string, ReadExecutionRecord>, readSpecId: string): ReadExecutionRecord {
  const execution = bySpec.get(readSpecId);
  if (!execution) throw new Error(`Declaration references ReadSpec ${readSpecId}, which was not executed`);
  return execution;
}

async function executeOne(reader: SourceReader, snapshotId: string, spec: ReadSpec, declaration: SourceReadingObligation): Promise<{ execution: ReadExecutionRecord; evidence: EvidenceItem[] }> {
  const id = `EXEC-${sha256(spec.id).slice(0, 16)}`;
  const evidence: EvidenceItem[] = [];
  try {
    const lineCount = await reader.lineCount(spec.path);
    if (spec.span.startLine > lineCount) {
      const ledger = ledgerEvidence(snapshotId, spec, declaration, "empty", "authorized-span-has-no-lines");
      return {
        execution: executionRecord(id, spec, declaration, "empty", [ledger.id], null, "authorized-span-has-no-lines"),
        evidence: [ledger]
      };
    }
    const availableEnd = Math.min(spec.span.endLine, lineCount);
    let cursor = spec.span.startLine;
    while (cursor <= availableEnd) {
      const endLine = Math.min(availableEnd, cursor + MAX_WINDOW_LINES - 1);
      const window = await reader.window(spec.path, cursor, endLine, `${spec.reason}; execute ${spec.id}`);
      if (window.endLine < cursor || window.content.length === 0) break;
      evidence.push(evidenceFromWindow(window));
      cursor = window.endLine + 1;
    }
    if (!evidence.length) {
      const ledger = ledgerEvidence(snapshotId, spec, declaration, "empty", "authorized-span-is-empty");
      return {
        execution: executionRecord(id, spec, declaration, "empty", [ledger.id], null, "authorized-span-is-empty"),
        evidence: [ledger]
      };
    }
    const observedSpan = {
      startLine: Math.min(...evidence.map((item) => item.startLine ?? spec.span.startLine)),
      endLine: Math.max(...evidence.map((item) => item.endLine ?? spec.span.startLine))
    };
    if (availableEnd < spec.span.endLine || observedSpan.endLine < availableEnd) {
      const cause = availableEnd < spec.span.endLine ? "authorized-span-past-end-of-file" : "authorized-span-not-fully-read";
      const ledger = ledgerEvidence(snapshotId, spec, declaration, "unavailable", cause);
      evidence.push(ledger);
      return { execution: executionRecord(id, spec, declaration, "unavailable", evidence.map((item) => item.id), observedSpan, cause), evidence };
    }
    return { execution: executionRecord(id, spec, declaration, "source", evidence.map((item) => item.id), observedSpan), evidence };
  } catch (error) {
    const cause = executionFailureCause(error);
    const ledger = ledgerEvidence(snapshotId, spec, declaration, "unavailable", cause);
    evidence.push(ledger);
    const source = evidence.filter((item) => item.kind === "source");
    const observedSpan = source.length ? {
      startLine: Math.min(...source.map((item) => item.startLine ?? spec.span.startLine)),
      endLine: Math.max(...source.map((item) => item.endLine ?? spec.span.startLine))
    } : null;
    return { execution: executionRecord(id, spec, declaration, "unavailable", evidence.map((item) => item.id), observedSpan, cause), evidence };
  }
}

function executionRecord(
  id: string,
  spec: ReadSpec,
  declaration: SourceReadingObligation,
  outcome: ReadExecutionOutcome,
  evidenceIds: readonly string[],
  observedSpan: ReadExecutionRecord["observedSpan"],
  cause?: string
): ReadExecutionRecord {
  return {
    id,
    readSpecId: spec.id,
    declarationId: declaration.id,
    path: spec.path,
    requestedSpan: spec.span,
    observedSpan,
    outcome,
    evidenceIds,
    ...(cause ? { cause } : {})
  };
}

function ledgerEvidence(snapshotId: string, spec: ReadSpec, declaration: SourceReadingObligation, outcome: "empty" | "unavailable", cause: string): EvidenceItem {
  const data = {
    recordType: "read-execution",
    readSpecId: spec.id,
    declarationId: declaration.id,
    outcome,
    path: spec.path,
    requestedSpan: spec.span,
    cause
  };
  return {
    id: `LEDGER-READ-${sha256(stableJson(data)).slice(0, 16)}`,
    snapshotId,
    kind: "ledger",
    title: outcome === "empty" ? `Empty authorized read: ${spec.path}` : `Unavailable authorized read: ${spec.path}`,
    data,
    reason: outcome === "empty"
      ? `record that ${spec.id} produced no source bytes; empty is a referenceable fact, not a missing record`
      : `record why ${spec.id} could not be fully executed without converting the gap into positive knowledge`,
    digest: sha256(stableJson(data))
  };
}

function disposeDecision(declaration: DecisionObligation, execution: ReadExecutionRecord): DecisionDisposition {
  const disposition = dispositionFor(execution.outcome);
  return {
    declarationId: declaration.id,
    readSpecId: declaration.readSpecId,
    executionId: execution.id,
    ...disposition,
    evidenceIds: execution.evidenceIds
  };
}

function dispositionFor(outcome: ReadExecutionOutcome): Pick<DecisionDisposition, "status" | "positiveKnowledge"> {
  if (outcome === "source") return { status: "fulfilled", positiveKnowledge: true };
  if (outcome === "empty") return { status: "closed-negative", positiveKnowledge: false };
  return { status: "pending", positiveKnowledge: false };
}

function retainResidual(residual: ObligationResidual, execution: ReadExecutionRecord): ResidualRetention {
  return { residualId: residual.id, readSpecId: residual.readSpecId, executionId: execution.id, status: "residual", evidenceIds: execution.evidenceIds };
}

function summarize(executions: readonly ReadExecutionRecord[], dispositions: readonly DecisionDisposition[], residuals: readonly ResidualRetention[]): InvestigationResults["summary"] {
  return {
    authorized: executions.length,
    source: executions.filter((row) => row.outcome === "source").length,
    empty: executions.filter((row) => row.outcome === "empty").length,
    unavailable: executions.filter((row) => row.outcome === "unavailable").length,
    fulfilled: dispositions.filter((row) => row.status === "fulfilled").length,
    closedNegative: dispositions.filter((row) => row.status === "closed-negative").length,
    pending: dispositions.filter((row) => row.status === "pending").length,
    residuals: residuals.length
  };
}

function validateEvidenceKinds(execution: ReadExecutionRecord, evidenceById: ReadonlyMap<string, EvidenceItem>): void {
  if (!evidenceById.size) return;
  const items = execution.evidenceIds.map((id) => {
    const item = evidenceById.get(id);
    if (!item) throw new Error(`execution ${execution.id} cites missing evidence ${id}`);
    return item;
  });
  if (execution.outcome === "source" && items.some((item) => item.kind !== "source")) {
    throw new Error(`execution ${execution.id} uses non-source evidence as a successful source read`);
  }
  if (execution.outcome === "empty" && items.some((item) => item.kind !== "ledger")) {
    throw new Error(`execution ${execution.id} does not record its empty result as ledger evidence`);
  }
  if (execution.outcome === "unavailable" && !items.some((item) => item.kind === "ledger")) {
    throw new Error(`execution ${execution.id} hides an unavailable read without ledger evidence`);
  }
  const sources = items.filter((item) => item.kind === "source").sort((a, b) => Number(a.startLine) - Number(b.startLine));
  let nextLine = execution.requestedSpan.startLine;
  for (const item of sources) {
    if (item.path !== execution.path || !Number.isInteger(item.startLine) || !Number.isInteger(item.endLine)
      || item.startLine !== nextLine || item.endLine! < item.startLine! || item.endLine! > execution.requestedSpan.endLine) {
      throw new Error(`execution ${execution.id} cites a source window outside its authorized path or contiguous span`);
    }
    nextLine = item.endLine! + 1;
  }
  const observed = sources.length ? { startLine: execution.requestedSpan.startLine, endLine: nextLine - 1 } : null;
  if (stableJson(observed) !== stableJson(execution.observedSpan)) throw new Error(`execution ${execution.id} observed span does not match its source evidence`);
  if (execution.outcome === "source" && nextLine - 1 !== execution.requestedSpan.endLine) {
    throw new Error(`execution ${execution.id} claims success without covering its full authorized span`);
  }
  for (const item of items.filter((entry) => entry.kind === "ledger")) {
    const data = item.data as Record<string, unknown> | undefined;
    if (data?.recordType !== "read-execution" || data.readSpecId !== execution.readSpecId
      || data.declarationId !== execution.declarationId || data.outcome !== execution.outcome
      || data.path !== execution.path || stableJson(data.requestedSpan) !== stableJson(execution.requestedSpan)) {
      throw new Error(`execution ${execution.id} ledger evidence is not bound to its authorization and outcome`);
    }
  }
}

function executionFailureCause(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (code) return `source-read-${code.toLowerCase()}`;
  const message = error instanceof Error ? error.message : String(error);
  if (/window budget exceeded/i.test(message)) return "source-window-budget-exceeded";
  if (/character budget exceeded/i.test(message)) return "source-character-budget-exceeded";
  if (/escapes target/i.test(message)) return "source-path-rejected";
  return "source-read-failed";
}

/** Narrow helper for orchestrators that need to preserve the shared ArtifactResult failure envelope. */
export type InvestigationResultsArtifact = ArtifactResult<InvestigationResults>;
