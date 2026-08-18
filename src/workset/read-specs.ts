import type { FeatureFactPack } from "../base/types.ts";
import { canonicalJson, sha256, stableJson } from "../base/util.ts";
import type { BoundaryFunctionsArtifact } from "../facts/probe/boundary-functions.ts";
import { unitsContentDigest, type UnitsArtifact } from "../facts/units/units-artifact.ts";
import { consumableFactPackItems } from "./factpack-view.ts";

export const READ_SPECS_VERSION = "read-specs-v1";

export interface ReadBudgetAuthorization {
  /** One later layer-7 source-window operation; layer 5 authorises it but never performs it. */
  readonly windows: 1;
  /** The exact requested span cost. System-wide scalar/record ceilings are deliberately left to step 8. */
  readonly requestedLines: number;
}

export interface ReadSpec {
  readonly id: string;
  readonly featureKey: string;
  readonly path: string;
  readonly span: { readonly startLine: number; readonly endLine: number };
  readonly reason: string;
  readonly budget: ReadBudgetAuthorization;
}

export interface DecisionCandidate {
  readonly id: string;
  readonly featureKey: string;
  readonly name: string;
  readonly path: string;
  readonly span: { readonly startLine: number; readonly endLine: number };
  readonly language: string;
  readonly probe: "decision" | "no-decision" | "unavailable";
  /** Decision and unavailable candidates have an independent authorization; no-decision candidates do not. */
  readonly readSpecId: string | null;
}

export interface ReadSpecsArtifact {
  readonly version: typeof READ_SPECS_VERSION;
  readonly identity: {
    readonly factPacksDigest: string;
    readonly boundaryCandidatesDigest: string;
    readonly unitsContentDigest: string;
  };
  readonly specs: readonly ReadSpec[];
  readonly candidates: readonly DecisionCandidate[];
  readonly summary: {
    readonly specs: number;
    readonly requestedLines: number;
    readonly candidates: number;
    readonly decision: number;
    readonly noDecision: number;
    readonly unavailable: number;
  };
}

export interface BuildReadSpecsInput {
  readonly factPacks: ReadonlyMap<string, FeatureFactPack>;
  readonly boundaryFunctions: BoundaryFunctionsArtifact;
  readonly units: UnitsArtifact;
}

interface MutableSpec {
  readonly id: string;
  readonly featureKey: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly reasons: Set<string>;
}

/**
 * Pure layer-5 authorization. Its signature deliberately has no SourceReader, target path, evidence catalog or
 * callback capable of reading bytes. Candidate probing already happened inside a lower producer; this layer
 * transcribes the structured verdict and authorises a later read.
 */
export function buildReadSpecs(input: BuildReadSpecsInput): ReadSpecsArtifact {
  const specs = new Map<string, MutableSpec>();
  const ensure = (featureKey: string, path: string, startLine: number, endLine: number): MutableSpec => {
    const normalized = normalizePath(path);
    const start = Math.max(1, Math.trunc(startLine));
    const end = Math.max(start, Math.trunc(endLine));
    const key = locationKey(featureKey, normalized, start, end);
    const prior = specs.get(key);
    if (prior) return prior;
    const created: MutableSpec = {
      id: `READ-${sha256(key).slice(0, 16)}`,
      featureKey,
      path: normalized,
      startLine: start,
      endLine: end,
      reasons: new Set()
    };
    specs.set(key, created);
    return created;
  };

  for (const [featureKey, pack] of [...input.factPacks.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const item of consumableFactPackItems(pack)) {
      if (!Number.isInteger(item.line) || item.line < 1) continue;
      const endLine = Number.isInteger(item.endLine) && Number(item.endLine) >= item.line ? Number(item.endLine) : item.line;
      const spec = ensure(featureKey, item.filePath, item.line, endLine);
      spec.reasons.add(`inspect retained ${item.category} fact ${item.name}`);
    }
  }

  const candidateDrafts: Array<Omit<DecisionCandidate, "readSpecId"> & { readonly readSpecKey: string | null }> = [];
  for (const feature of [...input.boundaryFunctions.features].sort((a, b) => a.featureKey.localeCompare(b.featureKey))) {
    for (const fn of [...feature.functions].sort((a, b) => normalizePath(a.path).localeCompare(normalizePath(b.path)) || a.startLine - b.startLine || a.name.localeCompare(b.name))) {
      const path = normalizePath(fn.path);
      const startLine = Math.max(1, Math.trunc(fn.startLine));
      const endLine = Math.max(startLine, Math.trunc(fn.endLine));
      const key = locationKey(feature.featureKey, path, startLine, endLine);
      if (fn.probe !== "no-decision") {
        const spec = ensure(feature.featureKey, path, startLine, endLine);
        spec.reasons.add(fn.probe === "decision"
          ? `inspect decision-bearing function ${fn.name}`
          : `inspect unprobed function ${fn.name}; structural decision probe was unavailable`);
      }
      candidateDrafts.push({
        id: `CAND-${sha256(stableJson([feature.featureKey, path, startLine, endLine, fn.name])).slice(0, 16)}`,
        featureKey: feature.featureKey,
        name: fn.name,
        path,
        span: { startLine, endLine },
        language: languageForPath(input.units, path),
        probe: fn.probe,
        readSpecKey: fn.probe === "no-decision" ? null : key
      });
    }
  }

  const rows: ReadSpec[] = [...specs.values()]
    .sort((a, b) => a.featureKey.localeCompare(b.featureKey) || a.path.localeCompare(b.path) || a.startLine - b.startLine || a.endLine - b.endLine)
    .map((row) => ({
      id: row.id,
      featureKey: row.featureKey,
      path: row.path,
      span: { startLine: row.startLine, endLine: row.endLine },
      reason: [...row.reasons].sort().join("; "),
      budget: { windows: 1, requestedLines: row.endLine - row.startLine + 1 }
    }));
  const idByKey = new Map([...specs.entries()].map(([key, row]) => [key, row.id]));
  const candidates: DecisionCandidate[] = candidateDrafts.map(({ readSpecKey, ...candidate }) => ({
    ...candidate,
    readSpecId: readSpecKey === null ? null : idByKey.get(readSpecKey) ?? null
  }));
  const artifact: ReadSpecsArtifact = {
    version: READ_SPECS_VERSION,
    identity: {
      factPacksDigest: sha256(canonicalJson([...input.factPacks.entries()].sort(([a], [b]) => a.localeCompare(b)))),
      boundaryCandidatesDigest: sha256(canonicalJson(input.boundaryFunctions)),
      unitsContentDigest: unitsContentDigest(input.units)
    },
    specs: rows,
    candidates,
    summary: {
      specs: rows.length,
      requestedLines: rows.reduce((sum, row) => sum + row.budget.requestedLines, 0),
      candidates: candidates.length,
      decision: candidates.filter((row) => row.probe === "decision").length,
      noDecision: candidates.filter((row) => row.probe === "no-decision").length,
      unavailable: candidates.filter((row) => row.probe === "unavailable").length
    }
  };
  requireReadSpecs(artifact);
  return artifact;
}

/** Persisted-reader validation: field-set checks are the executable form of "no source body, no evidence id". */
export function requireReadSpecs(value: unknown, source = "ReadSpec artifact"): asserts value is ReadSpecsArtifact {
  if (!value || typeof value !== "object") throw new Error(`${source} is not an object`);
  const artifact = value as Partial<ReadSpecsArtifact>;
  if (artifact.version !== READ_SPECS_VERSION || !artifact.identity || !Array.isArray(artifact.specs) || !Array.isArray(artifact.candidates) || !artifact.summary) {
    throw new Error(`${source} is not ${READ_SPECS_VERSION}`);
  }
  rejectForbiddenKeys(artifact, source);
  const specIds = new Set<string>();
  for (const [index, spec] of artifact.specs.entries()) {
    const keys = Object.keys(spec as object).sort();
    const expected = ["budget", "featureKey", "id", "path", "reason", "span"];
    if (stableJson(keys) !== stableJson(expected)) throw new Error(`${source} spec ${index} has fields outside the ReadSpec contract: ${keys.join(", ")}`);
    if (!spec.id?.trim() || !spec.featureKey?.trim() || !spec.path?.trim() || !spec.reason?.trim()) throw new Error(`${source} spec ${index} is missing identity, path or reason`);
    if (specIds.has(spec.id)) throw new Error(`${source} repeats ReadSpec id ${spec.id}`);
    specIds.add(spec.id);
    if (!Number.isInteger(spec.span?.startLine) || !Number.isInteger(spec.span?.endLine) || spec.span.startLine < 1 || spec.span.endLine < spec.span.startLine) throw new Error(`${source} spec ${spec.id} has an invalid span`);
    if (spec.budget?.windows !== 1 || spec.budget.requestedLines !== spec.span.endLine - spec.span.startLine + 1) throw new Error(`${source} spec ${spec.id} has a budget that does not authorise exactly its span`);
  }
  for (const candidate of artifact.candidates) {
    if (!candidate.id?.trim() || !candidate.featureKey?.trim() || !candidate.path?.trim() || !candidate.name?.trim()) throw new Error(`${source} contains a candidate without identity`);
    if (candidate.probe === "no-decision" && candidate.readSpecId !== null) throw new Error(`${source} authorises a read for no-decision candidate ${candidate.id}`);
    if (candidate.probe !== "no-decision" && (candidate.readSpecId === null || !specIds.has(candidate.readSpecId))) throw new Error(`${source} candidate ${candidate.id} has no valid ReadSpec authorization`);
  }
  if (artifact.summary.specs !== artifact.specs.length
    || artifact.summary.candidates !== artifact.candidates.length
    || artifact.summary.decision !== artifact.candidates.filter((row) => row.probe === "decision").length
    || artifact.summary.noDecision !== artifact.candidates.filter((row) => row.probe === "no-decision").length
    || artifact.summary.unavailable !== artifact.candidates.filter((row) => row.probe === "unavailable").length) {
    throw new Error(`${source} summary does not reconcile with its rows`);
  }
}

export function readSpecsContentDigest(artifact: ReadSpecsArtifact): string { return sha256(canonicalJson(artifact)); }

function rejectForbiddenKeys(value: unknown, source: string, path = "$"): void {
  if (Array.isArray(value)) { value.forEach((entry, index) => rejectForbiddenKeys(entry, source, `${path}[${index}]`)); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(content|sourceText|excerpt|evidenceId|evidenceIds)$/i.test(key)) throw new Error(`${source} carries forbidden source/evidence field ${path}.${key}`);
    rejectForbiddenKeys(child, source, `${path}.${key}`);
  }
}

function languageForPath(units: UnitsArtifact, path: string): string {
  return units.files.find((row) => normalizePath(row.relativePath) === path)?.language ?? "unregistered";
}

function locationKey(featureKey: string, path: string, startLine: number, endLine: number): string {
  return `${featureKey}\u0000${path}\u0000${startLine}\u0000${endLine}`;
}

function normalizePath(path: string): string { return path.replaceAll("\\", "/").replace(/^\.\/+/, ""); }
