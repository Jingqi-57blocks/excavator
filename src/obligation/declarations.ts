import type { CoverageConservation } from "../base/conservation.ts";
import { summarizeCoverage } from "../base/conservation.ts";
import { canonicalJson, sha256, stableJson } from "../base/util.ts";
import type { Requirements, RequirementRow } from "../contract/bound-run-contract.ts";
import { requirementsDigest } from "../contract/bound-run-contract.ts";
import { unitsContentDigest, type UnitsArtifact } from "../facts/units/units-artifact.ts";
import type { MechanismLedger } from "../mechanism/mechanism-ledger.ts";
import { readSpecsContentDigest, requireReadSpecs, type DecisionCandidate, type ReadSpecsArtifact } from "../workset/read-specs.ts";

export const OBLIGATION_DECLARATIONS_VERSION = "obligation-declarations-v1";

export interface KnowledgeRequirementObligation {
  readonly id: string;
  readonly kind: "knowledge-requirement";
  readonly requirementId: string;
  readonly scope: "run" | "feature";
  readonly featureKey: string | null;
  readonly documentId: string | null;
  readonly sectionIndex: number | null;
  readonly statement: string;
}

export interface DecisionObligation {
  readonly id: string;
  readonly kind: "decision-reading";
  readonly candidateId: string;
  readonly featureKey: string;
  readonly name: string;
  readonly path: string;
  readonly span: { readonly startLine: number; readonly endLine: number };
  readonly readSpecId: string;
}

/** One declaration per layer-5 authorization. It is what lets layer 7 execute every ReadSpec without
 * inventing an obligation after source bytes have already been read. */
export interface SourceReadingObligation {
  readonly id: string;
  readonly kind: "source-reading";
  readonly readSpecId: string;
  readonly featureKey: string;
  readonly path: string;
  readonly span: { readonly startLine: number; readonly endLine: number };
  readonly reason: string;
}

export type ObligationDeclaration = KnowledgeRequirementObligation | SourceReadingObligation | DecisionObligation;

export interface ObligationResidual {
  readonly id: string;
  readonly kind: "probe-unavailable";
  readonly candidateId: string;
  readonly featureKey: string;
  readonly name: string;
  readonly path: string;
  readonly span: { readonly startLine: number; readonly endLine: number };
  readonly readSpecId: string;
  readonly mechanism: {
    readonly id: "decision-probe";
    readonly language: string;
    readonly covered: number;
    readonly noMechanism: number;
    readonly mechanismUnavailable: number;
  };
}

export interface ObligationExclusion {
  readonly candidateId: string;
  readonly reason: "no-decision";
}

export interface ObligationDeclarations {
  readonly version: typeof OBLIGATION_DECLARATIONS_VERSION;
  readonly identity: {
    readonly requirementsDigest: string;
    readonly worksetDigest: string;
    readonly mechanismsDigest: string;
    readonly unitsContentDigest: string;
  };
  readonly declarations: readonly ObligationDeclaration[];
  readonly residuals: readonly ObligationResidual[];
  readonly exclusions: readonly ObligationExclusion[];
  /** Candidate-only coverage law: unavailable probes are the named honest residual (`unexplained`). */
  readonly candidateAccounting: CoverageConservation;
  readonly summary: {
    readonly requirements: number;
    readonly sourceReadings: number;
    readonly decisionObligations: number;
    readonly residuals: number;
    readonly excludedNoDecision: number;
  };
}

export function buildObligationDeclarations(input: {
  readonly requirements: Requirements;
  readonly workset: ReadSpecsArtifact;
  readonly mechanisms: MechanismLedger;
  readonly units: UnitsArtifact;
}): ObligationDeclarations {
  requireReadSpecs(input.workset);
  const recomputedRequirements = requirementsDigest(input.requirements);
  if (recomputedRequirements !== input.requirements.digest) throw new Error("Obligation declarations received requirements whose digest is invalid");
  const unitsDigest = unitsContentDigest(input.units);
  if (input.workset.identity.unitsContentDigest !== unitsDigest) throw new Error("Obligation declarations received workset and units from different generations");
  if (input.mechanisms.identity.filesContentManifestDigest !== input.units.identity.filesContentManifestDigest) {
    throw new Error("Obligation declarations received mechanisms and units over different file ledgers");
  }

  const declarations: ObligationDeclaration[] = [
    ...input.requirements.rows.map(requirementObligation),
    ...input.workset.specs.map((spec): SourceReadingObligation => ({
      id: `OBL-READ-${spec.id.slice(5)}`,
      kind: "source-reading",
      readSpecId: spec.id,
      featureKey: spec.featureKey,
      path: spec.path,
      span: spec.span,
      reason: spec.reason
    }))
  ];
  const residuals: ObligationResidual[] = [];
  const exclusions: ObligationExclusion[] = [];
  for (const candidate of input.workset.candidates) {
    switch (candidate.probe) {
      case "decision":
        declarations.push(decisionObligation(candidate));
        break;
      case "no-decision":
        exclusions.push({ candidateId: candidate.id, reason: "no-decision" });
        break;
      case "unavailable":
        residuals.push(residual(candidate, input.mechanisms));
        break;
    }
  }
  declarations.sort((a, b) => a.id.localeCompare(b.id));
  residuals.sort((a, b) => a.id.localeCompare(b.id));
  exclusions.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  const candidateAccounting = summarizeCoverage({
    total: input.workset.candidates.length,
    counted: declarations.filter((row) => row.kind === "decision-reading").length,
    excluded: exclusions.length
  });
  if (candidateAccounting.unexplained !== residuals.length) {
    throw new Error(`Obligation candidate accounting lost rows: residual ${candidateAccounting.unexplained}, recorded ${residuals.length}`);
  }
  const artifact: ObligationDeclarations = {
    version: OBLIGATION_DECLARATIONS_VERSION,
    identity: {
      requirementsDigest: input.requirements.digest,
      worksetDigest: readSpecsContentDigest(input.workset),
      mechanismsDigest: sha256(canonicalJson(input.mechanisms)),
      unitsContentDigest: unitsDigest
    },
    declarations,
    residuals,
    exclusions,
    candidateAccounting,
    summary: {
      requirements: declarations.filter((row) => row.kind === "knowledge-requirement").length,
      sourceReadings: declarations.filter((row) => row.kind === "source-reading").length,
      decisionObligations: declarations.filter((row) => row.kind === "decision-reading").length,
      residuals: residuals.length,
      excludedNoDecision: exclusions.length
    }
  };
  requireObligationDeclarations(artifact, input.requirements);
  return artifact;
}

export function requireObligationDeclarations(value: unknown, requirements?: Requirements, source = "obligation declarations"): asserts value is ObligationDeclarations {
  if (!value || typeof value !== "object") throw new Error(`${source} is not an object`);
  const artifact = value as Partial<ObligationDeclarations>;
  if (artifact.version !== OBLIGATION_DECLARATIONS_VERSION || !artifact.identity || !Array.isArray(artifact.declarations) || !Array.isArray(artifact.residuals) || !Array.isArray(artifact.exclusions) || !artifact.candidateAccounting || !artifact.summary) {
    throw new Error(`${source} is not ${OBLIGATION_DECLARATIONS_VERSION}`);
  }
  rejectEvidenceFields(artifact, source);
  const requirementRows = artifact.declarations.filter((row): row is KnowledgeRequirementObligation => row.kind === "knowledge-requirement");
  if (requirements) {
    const expected = [...requirements.rows].map((row) => row.id).sort();
    const actual = requirementRows.map((row) => row.requirementId).sort();
    if (stableJson(actual) !== stableJson(expected)) throw new Error(`${source} does not declare every requirements.json row exactly once`);
  }
  const candidates = new Set<string>();
  const readingIds = new Set<string>();
  for (const row of artifact.declarations) {
    if (row.kind !== "source-reading") continue;
    if (!row.readSpecId?.trim() || !row.path?.trim() || !row.reason?.trim()) throw new Error(`${source} has a source-reading obligation without authorization, path or reason`);
    if (readingIds.has(row.readSpecId)) throw new Error(`${source} declares ReadSpec ${row.readSpecId} more than once`);
    readingIds.add(row.readSpecId);
  }
  for (const row of artifact.declarations) {
    if (row.kind !== "decision-reading") continue;
    if (!row.readSpecId?.trim() || !row.candidateId?.trim()) throw new Error(`${source} has a decision obligation without candidate or ReadSpec identity`);
    if (candidates.has(row.candidateId)) throw new Error(`${source} puts candidate ${row.candidateId} in more than one bucket`);
    candidates.add(row.candidateId);
  }
  for (const row of artifact.residuals) {
    if (candidates.has(row.candidateId)) throw new Error(`${source} puts candidate ${row.candidateId} in more than one bucket`);
    candidates.add(row.candidateId);
  }
  for (const row of artifact.exclusions) {
    if (candidates.has(row.candidateId)) throw new Error(`${source} puts candidate ${row.candidateId} in more than one bucket`);
    candidates.add(row.candidateId);
  }
  const totals = artifact.candidateAccounting;
  if (totals.total !== totals.counted + totals.excluded + totals.unexplained
    || totals.total !== candidates.size
    || totals.counted !== artifact.summary.decisionObligations
    || totals.excluded !== artifact.summary.excludedNoDecision
    || totals.unexplained !== artifact.summary.residuals) {
    throw new Error(`${source} candidate buckets do not conserve their input rows`);
  }
  if (artifact.summary.requirements !== requirementRows.length
    || artifact.summary.sourceReadings !== readingIds.size
    || artifact.summary.decisionObligations !== artifact.declarations.filter((row) => row.kind === "decision-reading").length) {
    throw new Error(`${source} summary does not reconcile with its declarations`);
  }
}

export function obligationsContentDigest(artifact: ObligationDeclarations): string { return sha256(canonicalJson(artifact)); }

function requirementObligation(row: RequirementRow): KnowledgeRequirementObligation {
  return {
    id: `OBL-${row.id}`,
    kind: "knowledge-requirement",
    requirementId: row.id,
    scope: row.scope,
    featureKey: row.featureKey,
    documentId: row.documentId,
    sectionIndex: row.sectionIndex,
    statement: row.statement
  };
}

function decisionObligation(candidate: DecisionCandidate): DecisionObligation {
  if (candidate.readSpecId === null) throw new Error(`Decision candidate ${candidate.id} has no ReadSpec authorization`);
  return {
    id: `OBL-DEC-${candidate.id.slice(5)}`,
    kind: "decision-reading",
    candidateId: candidate.id,
    featureKey: candidate.featureKey,
    name: candidate.name,
    path: candidate.path,
    span: candidate.span,
    readSpecId: candidate.readSpecId
  };
}

function residual(candidate: DecisionCandidate, mechanisms: MechanismLedger): ObligationResidual {
  if (candidate.readSpecId === null) throw new Error(`Unprobed candidate ${candidate.id} has no ReadSpec authorization`);
  const census = mechanisms.byLanguage.find((row) => row.language === candidate.language && row.mechanismId === "decision-probe");
  return {
    id: `RESIDUAL-${candidate.id.slice(5)}`,
    kind: "probe-unavailable",
    candidateId: candidate.id,
    featureKey: candidate.featureKey,
    name: candidate.name,
    path: candidate.path,
    span: candidate.span,
    readSpecId: candidate.readSpecId,
    mechanism: {
      id: "decision-probe",
      language: candidate.language,
      covered: census?.covered ?? 0,
      noMechanism: census?.noMechanism ?? 0,
      mechanismUnavailable: census?.mechanismUnavailable ?? 0
    }
  };
}

function rejectEvidenceFields(value: unknown, source: string, path = "$"): void {
  if (Array.isArray(value)) { value.forEach((entry, index) => rejectEvidenceFields(entry, source, `${path}[${index}]`)); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/evidence/i.test(key)) throw new Error(`${source} carries forbidden evidence field ${path}.${key}`);
    rejectEvidenceFields(child, source, `${path}.${key}`);
  }
}
