// Deterministic, read-only extraction of normalized Knowledge from a completed
// (or merely prepared) Excavator run directory. Zero dependencies, zero model
// calls, no writes to the run. Generalizes recall.mjs: instead of reconciling
// against a fixed gold ledger, it produces a neutral Knowledge object that
// diff.ts can compare against a hand-written expected-knowledge.json.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** Claim marker vocabulary, mirrored from Core's EvidenceMarker (kept local so eval stays independent). */
export type Marker = "fact" | "verified" | "inferred" | "unavailable";

/** A resolved source window cited by a claim or trace step. */
export interface EvidenceWindow {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
}

/** A `kind === "search"` receipt cited by a claim, reduced to what the forbidden-pin exemption needs. */
export interface SearchEvidence {
  id: string;
  matchCount: number;
  truncated: boolean;
}

export interface KnowledgeFact {
  /** `${documentId}#${claimId}` — unique across the run. */
  ref: string;
  documentId: string;
  claimId: string;
  statement: string;
  marker: Marker;
  /** S-* source windows this claim cites, resolved against evidence.json. */
  windows: EvidenceWindow[];
  /** How many evidence ids this claim cites, after de-duplication. */
  citedEvidenceCount: number;
  /** Cited ids that resolve to a `kind === "search"` receipt carrying an array `data.matches`. */
  searchEvidence: SearchEvidence[];
}

export interface KnowledgeRelationStep {
  action: string;
  windows: EvidenceWindow[];
}

export interface KnowledgeRelation {
  id: string;
  type: string;
  status: string;
  steps: KnowledgeRelationStep[];
}

export interface KnowledgeCoverage {
  id: string;
  dimension: string;
  status: string;
}

export interface KnowledgeUnknown {
  source: "claim" | "workitem";
  ref: string;
  /** Free text the unknown is matched against: statement, or dimension+hypothesis+reason. */
  text: string;
}

/** Prepare-time horizon used for miss attribution: which files reached the working scope. */
export interface PrepareHorizon {
  /** filePaths enumerated by every feature fact pack. */
  files: string[];
  /** Concatenated feature scope markdown (representative paths, vocabulary, boundaries). */
  scopeText: string;
}

export interface Knowledge {
  runDir: string;
  facts: KnowledgeFact[];
  relations: KnowledgeRelation[];
  coverage: KnowledgeCoverage[];
  unknowns: KnowledgeUnknown[];
  prepareHorizon: PrepareHorizon;
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

interface EvidenceIndex {
  windows: Map<string, EvidenceWindow>;
  searches: Map<string, SearchEvidence>;
}

/**
 * Resolve evidence.json in a single read into two lookup tables:
 *   - windows: every S-* source window (path + line range);
 *   - searches: every `kind === "search"` receipt whose `data.matches` is an array, reduced to
 *     { matchCount, truncated }. A receipt with a missing/non-array `matches` is deliberately dropped
 *     so it cannot satisfy the searched-not-found exemption (conservative — keeps the equality from holding).
 * The judgment is the catalog's `kind`, not the id prefix.
 */
function buildEvidenceIndex(runDir: string): EvidenceIndex {
  const windows = new Map<string, EvidenceWindow>();
  const searches = new Map<string, SearchEvidence>();
  const file = join(runDir, "evidence.json");
  if (!existsSync(file)) return { windows, searches };
  const catalog = readJson(file);
  const list: any[] = Array.isArray(catalog) ? catalog : catalog.evidence ?? [];
  for (const item of list) {
    const id = String(item?.id ?? "");
    if (!id) continue;
    if (item?.kind === "search") {
      const matches = item?.data?.matches;
      if (Array.isArray(matches)) searches.set(id, { id, matchCount: matches.length, truncated: Boolean(item?.data?.truncated) });
      continue;
    }
    if (!id.startsWith("S-") || typeof item.path !== "string") continue;
    windows.set(id, {
      id,
      path: item.path,
      startLine: Number.isFinite(item.startLine) ? item.startLine : 0,
      endLine: Number.isFinite(item.endLine) ? item.endLine : Number.MAX_SAFE_INTEGER
    });
  }
  return { windows, searches };
}

function resolveWindows(evidenceIds: unknown, index: Map<string, EvidenceWindow>): EvidenceWindow[] {
  if (!Array.isArray(evidenceIds)) return [];
  const out: EvidenceWindow[] = [];
  for (const raw of evidenceIds) {
    const window = index.get(String(raw));
    if (window) out.push(window);
  }
  return out;
}

/** Reduce a claim's evidenceIds to its de-duplicated cited count and the subset resolving to search receipts. */
function resolveCited(evidenceIds: unknown, searches: Map<string, SearchEvidence>): { citedEvidenceCount: number; searchEvidence: SearchEvidence[] } {
  if (!Array.isArray(evidenceIds)) return { citedEvidenceCount: 0, searchEvidence: [] };
  const unique = [...new Set(evidenceIds.map((raw) => String(raw)))];
  const searchEvidence: SearchEvidence[] = [];
  for (const id of unique) {
    const receipt = searches.get(id);
    if (receipt) searchEvidence.push(receipt);
  }
  return { citedEvidenceCount: unique.length, searchEvidence };
}

function extractFacts(runDir: string, index: EvidenceIndex): { facts: KnowledgeFact[]; unavailableClaims: KnowledgeUnknown[] } {
  const facts: KnowledgeFact[] = [];
  const unavailableClaims: KnowledgeUnknown[] = [];
  const claimsRoot = join(runDir, "claims");
  if (!existsSync(claimsRoot)) return { facts, unavailableClaims };
  for (const doc of readdirSync(claimsRoot).sort()) {
    const dir = join(claimsRoot, doc);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".json")) continue;
      const parsed = readJson(join(dir, name));
      const documentId = String(parsed?.documentId ?? doc);
      const claims: any[] = Array.isArray(parsed) ? parsed : parsed.claims ?? [];
      for (const claim of claims) {
        const claimId = String(claim?.id ?? "");
        const marker = String(claim?.marker ?? "fact") as Marker;
        const statement = String(claim?.statement ?? "");
        const ref = `${documentId}#${claimId}`;
        facts.push({
          ref, documentId, claimId, statement, marker,
          windows: resolveWindows(claim?.evidenceIds, index.windows),
          ...resolveCited(claim?.evidenceIds, index.searches)
        });
        if (marker === "unavailable") unavailableClaims.push({ source: "claim", ref, text: statement });
      }
    }
  }
  return { facts, unavailableClaims };
}

function extractRelations(runDir: string, index: EvidenceIndex): KnowledgeRelation[] {
  const file = join(runDir, "traces.json");
  if (!existsSync(file)) return [];
  const catalog = readJson(file);
  const traces: any[] = Array.isArray(catalog) ? catalog : catalog.traces ?? [];
  return traces.map((trace) => ({
    id: String(trace?.id ?? ""),
    type: String(trace?.type ?? ""),
    status: String(trace?.status ?? ""),
    steps: (Array.isArray(trace?.steps) ? trace.steps : []).map((step: any) => ({
      action: String(step?.action ?? ""),
      windows: resolveWindows(step?.evidenceIds, index.windows)
    }))
  }));
}

function extractCoverage(runDir: string): { coverage: KnowledgeCoverage[]; cannotDetermine: KnowledgeUnknown[] } {
  const coverage: KnowledgeCoverage[] = [];
  const cannotDetermine: KnowledgeUnknown[] = [];
  const file = join(runDir, "workitems.json");
  if (!existsSync(file)) return { coverage, cannotDetermine };
  const catalog = readJson(file);
  const items: any[] = Array.isArray(catalog) ? catalog : catalog.items ?? [];
  for (const item of items) {
    const id = String(item?.id ?? "");
    const dimension = String(item?.dimension ?? "");
    const status = String(item?.status ?? "");
    coverage.push({ id, dimension, status });
    if (status === "cannot-determine") {
      const text = [dimension, item?.hypothesis, item?.reason, item?.settledBy].filter(Boolean).map(String).join(" ");
      cannotDetermine.push({ source: "workitem", ref: id, text });
    }
  }
  return { coverage, cannotDetermine };
}

function extractPrepareHorizon(runDir: string): PrepareHorizon {
  const featuresDir = join(runDir, "context", "features");
  const files = new Set<string>();
  const scopeParts: string[] = [];
  if (existsSync(featuresDir)) {
    for (const name of readdirSync(featuresDir).sort()) {
      const full = join(featuresDir, name);
      if (name.endsWith(".factpack.json")) {
        const pack = readJson(full);
        for (const item of Array.isArray(pack?.items) ? pack.items : []) {
          if (typeof item?.filePath === "string") files.add(item.filePath);
        }
      } else if (name.endsWith(".md")) {
        scopeParts.push(readFileSync(full, "utf8"));
      }
    }
  }
  return { files: [...files].sort(), scopeText: scopeParts.join("\n") };
}

/** Read a run directory and return its normalized Knowledge. Pure read; never writes. */
export function extractKnowledge(runDir: string): Knowledge {
  const index = buildEvidenceIndex(runDir);
  const { facts, unavailableClaims } = extractFacts(runDir, index);
  const relations = extractRelations(runDir, index);
  const { coverage, cannotDetermine } = extractCoverage(runDir);
  return {
    runDir,
    facts,
    relations,
    coverage,
    unknowns: [...unavailableClaims, ...cannotDetermine],
    prepareHorizon: extractPrepareHorizon(runDir)
  };
}
