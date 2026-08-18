// Two-stage feature-graph prune.
//
// Stage 1 keeps the existing intrinsic ranking VERBATIM (seed / directly-connected /
// anchor-in-path-name-signature score). It fills all but a small quota of the seats, so the
// main ranking never churns. Stage 2 spends that quota (R seats) on structural rescues the
// intrinsic score is blind to: a node whose NAME (not its file path) carries the domain
// vocabulary, a node that CALLS such name-matched nodes (a DIRECTIONAL bridge, so a shared
// utility that is merely CALLED BY the domain is not mistaken for domain code), and scheduler
// entry points. The retained set is always <= maxNodes.
//
// Framework-agnostic and target-agnostic: the abbreviation matchers are the consonant skeletons
// of the run's own anchor terms, derived at runtime (leave -> lv), never hardcoded; the scheduler
// signal is a generic word list, not a per-target path check. Zero npm dependency, zero model.

import { WEIGHTS, type RanSelectionTrace, type SelectionChannel, type TraceNode } from "./selection-trace.ts";

/** Field separator for de-dupe keys (SOH escape, never a literal NUL byte, never present in ids/paths). */
const KEY_SEP = "\u0001";

/** Rescue never targets structural noise: import records and file nodes are not feature symbols. */
const RESCUE_EXCLUDED_KINDS = new Set(["import", "file"]);
/** Generic scheduler/background-work path vocabulary (framework-agnostic, mirrors the configuration category). */
const SCHEDULER_PATH = /crons?|tasks?|jobs?|schedules?|workers?/i;

// Every weight below is READ from the frozen `WEIGHTS` table rather than written here, so the channel
// configuration has exactly one owner and one digest. The values are unchanged by that move.
export const NAME_TOKEN_EXACT = WEIGHTS.nameTokenExact; // an anchor term is an exact camel/snake token of the name
const NAME_SUBSTRING = WEIGHTS.nameSubstring; // an anchor term is a substring of the name but not a whole token
const ABBREV_TOKEN_EXACT = WEIGHTS.abbrevTokenExact; // an anchor term's consonant skeleton is an exact token of the name
const NAME_SIGNAL_CAP = WEIGHTS.nameSignalCap; // ceiling on the name-intrinsic part before bridge/scheduler add on
const BRIDGE_PER_NEIGHBOR = WEIGHTS.bridgePerNeighbor; // weight per distinct name-matched neighbor reached by an out-edge
/** Multiplicity per neighbor is capped so one hub cannot dominate. Shared with the fact-pack logic
 *  category's in-degree cap so both agree on how much one caller may weigh. */
export const BRIDGE_MAX_MULTIPLICITY = WEIGHTS.bridgeMaxMultiplicity;
const SCHEDULER_BONUS = WEIGHTS.schedulerBonus;

const RESCUE_QUOTA_MIN = WEIGHTS.rescueQuotaMin;
const RESCUE_QUOTA_MAX = WEIGHTS.rescueQuotaMax;
const RESCUE_QUOTA_FRACTION = WEIGHTS.rescueQuotaFraction;

interface Signal {
  value: number;
  reasons: string[];
}

/** The rescue quota R for a given node budget: 8..24, ~8% of the budget. */
export function rescueQuotaFor(maxNodes: number): number {
  return Math.min(RESCUE_QUOTA_MAX, Math.max(RESCUE_QUOTA_MIN, Math.round(Math.max(0, maxNodes) * RESCUE_QUOTA_FRACTION)));
}

/**
 * Consonant skeleton of a single anchor term, or null when the term is not eligible.
 * Only ASCII terms of length >= 5 derive an abbreviation (so "pto" and non-Latin terms do not),
 * and the skeleton is the first letter plus the remaining consonants ("leave" -> "lv",
 * "holiday" -> "hldy"). Returns null when the skeleton would not actually shorten the term.
 */
export function consonantSkeleton(term: string): string | null {
  const t = String(term).toLowerCase();
  if (t.length < 5) return null;
  if (!/^[a-z][a-z0-9]+$/.test(t)) return null;
  const body = t[0] + t.slice(1).replace(/[aeiou]/g, "");
  return body.length >= 2 && body.length < t.length ? body : null;
}

/** The de-duplicated set of consonant-skeleton abbreviations for a run's anchor terms. */
export function deriveAbbreviations(anchorTerms: string[]): Set<string> {
  const abbrevs = new Set<string>();
  for (const term of anchorTerms) {
    const skeleton = consonantSkeleton(term);
    if (skeleton) abbrevs.add(skeleton);
  }
  return abbrevs;
}

/** camelCase / snake_case / delimiter split of a name into lowercase tokens of length >= 2. */
export function nameTokens(name: string): Set<string> {
  const spaced = String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const tokens = new Set<string>();
  for (const word of spaced.split(/[^A-Za-z]+/)) {
    if (word.length >= 2) tokens.add(word.toLowerCase());
  }
  return tokens;
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable de-dupe of an edge list by (source,target,kind,line), sorted deterministically. */
export function dedupeEdges(edges: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const edge of edges) {
    const line = edge.line == null ? "" : String(edge.line);
    const key = `${String(edge.source)}${KEY_SEP}${String(edge.target)}${KEY_SEP}${String(edge.kind)}${KEY_SEP}${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  out.sort((a, b) =>
    compareStr(String(a.kind), String(b.kind))
    || compareStr(String(a.source), String(b.source))
    || compareStr(String(a.target), String(b.target))
    || ((a.line ?? -1) - (b.line ?? -1)));
  return out;
}

/** Name-intrinsic rescue signal: anchor tokens/substrings and anchor-skeleton tokens, capped. */
function nameSignal(node: any, lowerAnchors: string[], abbrevs: Set<string>): Signal {
  const rawName = String(node.name ?? "");
  const lowerName = rawName.toLowerCase();
  const tokens = nameTokens(rawName);
  let value = 0;
  const reasons: string[] = [];
  for (const term of lowerAnchors) {
    if (tokens.has(term)) { value += NAME_TOKEN_EXACT; reasons.push(`anchor-token ${term}`); }
    else if (lowerName.includes(term)) { value += NAME_SUBSTRING; reasons.push(`anchor-substring ${term}`); }
  }
  for (const abbr of abbrevs) {
    if (tokens.has(abbr)) { value += ABBREV_TOKEN_EXACT; reasons.push(`abbrev-token ${abbr}`); }
  }
  return { value: Math.min(value, NAME_SIGNAL_CAP), reasons };
}

/** Directional bridge signal: out-edges from this node to name-matched neighbors (a hub that is
 *  merely called BY the domain scores zero because those are in-edges). */
function bridgeSignal(
  node: any,
  adjacency: Map<string, Map<string, { count: number; kind: string }>>,
  matched: Set<string>,
  nodeName: Map<string, string>
): Signal {
  const out = adjacency.get(String(node.id));
  if (!out) return { value: 0, reasons: [] };
  const self = String(node.id);
  const hits: Array<{ target: string; name: string; count: number; kind: string }> = [];
  for (const [target, info] of out) {
    if (target === self || !matched.has(target)) continue;
    hits.push({ target, name: nodeName.get(target) ?? target, count: info.count, kind: info.kind });
  }
  if (!hits.length) return { value: 0, reasons: [] };
  hits.sort((a, b) => b.count - a.count || compareStr(a.name, b.name) || compareStr(a.target, b.target));
  let value = 0;
  for (const hit of hits) value += Math.min(hit.count, BRIDGE_MAX_MULTIPLICITY) * BRIDGE_PER_NEIGHBOR;
  const reasons = hits.slice(0, 4).map((hit) => `${hit.kind} ${hit.name}(x${hit.count})`);
  return { value, reasons };
}

function schedulingSignal(node: any): Signal {
  return SCHEDULER_PATH.test(String(node.filePath ?? "")) ? { value: SCHEDULER_BONUS, reasons: ["scheduler-path"] } : { value: 0, reasons: [] };
}

/** The per-id rescue-signal breakdown: the name-intrinsic value, the summed total across name +
 *  bridge + scheduler, and the joined human-readable reason. The `total` is exactly the Stage-2
 *  candidate score; `name` and `total` are what the module-floor gate (57B-377) tests. */
export interface RescueSignal { name: number; total: number; reason: string; }

/**
 * Compute the Stage-2 rescue signal (name / directional-bridge / scheduler) for EVERY node in the
 * pool, keyed by id. This is the exact scoring `rescueNodes` uses to rank rescue candidates, lifted
 * into a pure, reusable function so the module-floor logic (57B-377) can re-derive a node's own
 * (name, total) without duplicating the weights. Pure: a deterministic function of its inputs.
 */
export function rescueSignalsFor(nodes: any[], edges: any[], anchorTerms: string[]): Map<string, RescueSignal> {
  const lowerAnchors = [...new Set(anchorTerms.map((term) => String(term).toLowerCase()).filter(Boolean))];
  const abbrevs = deriveAbbreviations(anchorTerms);

  const nodeName = new Map<string, string>();
  const nameSig = new Map<string, Signal>();
  const matched = new Set<string>();
  for (const node of nodes) {
    const id = String(node.id);
    nodeName.set(id, String(node.name ?? ""));
    const sig = nameSignal(node, lowerAnchors, abbrevs);
    nameSig.set(id, sig);
    if (sig.value > 0) matched.add(id);
  }

  // Directed adjacency source -> target with call-site multiplicity (edges pre-deduped by line).
  const adjacency = new Map<string, Map<string, { count: number; kind: string }>>();
  for (const edge of edges) {
    const source = String(edge.source);
    const target = String(edge.target);
    let inner = adjacency.get(source);
    if (!inner) { inner = new Map(); adjacency.set(source, inner); }
    const existing = inner.get(target);
    if (existing) existing.count += 1;
    else inner.set(target, { count: 1, kind: String(edge.kind) });
  }

  const signals = new Map<string, RescueSignal>();
  for (const node of nodes) {
    const id = String(node.id);
    const name = nameSig.get(id) ?? { value: 0, reasons: [] };
    const bridge = bridgeSignal(node, adjacency, matched, nodeName);
    const scheduler = schedulingSignal(node);
    const total = name.value + bridge.value + scheduler.value;
    signals.set(id, { name: name.value, total, reason: [...name.reasons, ...bridge.reasons, ...scheduler.reasons].join(", ") });
  }
  return signals;
}

/**
 * Pick up to `quota` rescue nodes from the pool (excluding seeds and Stage-1 survivors, and import/file kinds).
 *
 * Returns the ELIGIBLE CANDIDATE SET beside the chosen nodes, because that set is what makes a displacement
 * nameable: a node the quota rejected lost the rescue quota, and a node that was never a candidate lost the
 * Stage-1 cap. Without the distinction every non-retained node would carry the same nameless "budget", which is
 * the P15 shape — a mechanism whose losses are recorded as one undifferentiated number.
 *
 * Chosen nodes are shallow copies carrying a deterministic `rescued` explanation string; the pool's own node
 * objects are never mutated.
 */
function rescueNodes(nodes: any[], signals: Map<string, RescueSignal>, seedIds: Set<string>, stage1Ids: Set<string>, quota: number): {
  chosen: any[];
  candidateIds: Set<string>;
} {
  const candidateIds = new Set<string>();
  if (quota <= 0) return { chosen: [], candidateIds };

  const candidates: Array<{ node: any; score: number; reason: string }> = [];
  for (const node of nodes) {
    const id = String(node.id);
    if (seedIds.has(id) || stage1Ids.has(id)) continue;
    if (RESCUE_EXCLUDED_KINDS.has(String(node.kind))) continue;
    const sig = signals.get(id);
    if (!sig || sig.total <= 0) continue;
    candidateIds.add(id);
    candidates.push({ node, score: sig.total, reason: sig.reason });
  }
  candidates.sort((a, b) => b.score - a.score
    || compareStr(String(a.node.filePath ?? ""), String(b.node.filePath ?? ""))
    || compareStr(String(a.node.name ?? ""), String(b.node.name ?? ""))
    || compareStr(String(a.node.id), String(b.node.id)));
  return { chosen: candidates.slice(0, quota).map((candidate) => ({ ...candidate.node, rescued: candidate.reason })), candidateIds };
}

/** A prune and the record of how it decided. The `{ nodes, edges }` half is byte-identical to the shell's. */
export interface RecordedPrune {
  nodes: any[];
  edges: any[];
  trace: RanSelectionTrace;
}

/**
 * Reduce an expanded feature graph to at most `maxNodes` nodes, AND record how every candidate fared.
 *
 * Stage 1 (verbatim intrinsic ranking) fills `maxNodes - R` seats; Stage 2 spends the R-seat quota on
 * structural rescues; any unfilled seats backfill from the intrinsic ranking so the set fills to the cap when
 * the pool is large enough. The returned node set is ALWAYS <= maxNodes, and edges are de-duplicated and
 * restricted to the retained nodes.
 *
 * This is the KERNEL: `pruneFeatureGraph` is a shell over it that drops the trace. The selection arithmetic is
 * unchanged in every respect — the rescue signals are computed once here and handed down rather than computed
 * inside `rescueNodes`, which is the same pure function of the same deduped edges (the quota is >= 8 for every
 * budget, so the old early return could never skip that call).
 */
export function pruneFeatureGraphRecorded(nodes: any[], edges: any[], seeds: any[], anchorTerms: string[], maxNodes: number): RecordedPrune {
  const seedIds = new Set(seeds.map((node) => String(node.id)));
  const directlyConnected = new Set<string>();
  for (const edge of edges) if (seedIds.has(String(edge.source)) || seedIds.has(String(edge.target))) {
    directlyConnected.add(String(edge.source));
    directlyConnected.add(String(edge.target));
  }
  const score = (node: any): number => {
    const path = String(node.filePath ?? "").toLowerCase();
    const name = String(node.name ?? "").toLowerCase();
    const signature = String(node.signature ?? "").toLowerCase();
    let value = seedIds.has(String(node.id)) ? WEIGHTS.stage1Seed : directlyConnected.has(String(node.id)) ? WEIGHTS.stage1DirectlyConnected : 0;
    for (const term of anchorTerms) {
      const lower = term.toLowerCase();
      if (path.includes(lower)) value += WEIGHTS.stage1PathTerm;
      if (name.includes(lower)) value += WEIGHTS.stage1NameTerm;
      if (signature.includes(lower)) value += WEIGHTS.stage1SignatureTerm;
    }
    if (/common\/components|common\/use|vendor|bootstrap|min\.js/i.test(path)) value += WEIGHTS.stage1CommonPenalty;
    if (/(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\./i.test(path)) value += WEIGHTS.stage1TestBonus;
    return value;
  };
  // --- end Stage 1 scoring (moved verbatim from the original context.ts pruneFeatureGraph) ---

  const cap = Math.max(0, maxNodes);
  const quota = rescueQuotaFor(cap);
  const ranked = [...nodes].sort((a, b) => score(b) - score(a) || String(a.filePath).localeCompare(String(b.filePath)));
  const stage1 = ranked.slice(0, Math.max(0, cap - quota));
  const stage1Ids = new Set(stage1.map((node) => String(node.id)));

  const dedupedEdges = dedupeEdges(edges);
  const signals = rescueSignalsFor(nodes, dedupedEdges, anchorTerms);
  const rescue = rescueNodes(nodes, signals, seedIds, stage1Ids, quota);
  const rescuedIds = new Set(rescue.chosen.map((node) => String(node.id)));

  const chosen = new Set<string>(stage1Ids);
  const retained: any[] = [...stage1];
  for (const node of rescue.chosen) { chosen.add(String(node.id)); retained.push(node); }
  // Backfill from the intrinsic ranking when rescue found fewer than its quota, so the node set
  // reaches the cap exactly whenever the pool allows (matching the pre-change count) — never over.
  if (retained.length < cap) {
    for (const node of ranked) {
      if (retained.length >= cap) break;
      const id = String(node.id);
      if (chosen.has(id)) continue;
      chosen.add(id);
      retained.push(node);
    }
  }
  const finalNodes = retained.slice(0, cap); // hard upper bound: retained is ALWAYS <= maxNodes
  const ids = new Set(finalNodes.map((node) => String(node.id)));
  return {
    nodes: finalNodes,
    edges: dedupedEdges.filter((edge) => ids.has(String(edge.source)) && ids.has(String(edge.target))),
    trace: {
      status: "ran",
      // The pool is the INPUT set, not the retained one: a channel census whose denominator is the seats it
      // awarded cannot state a displacement, which is the whole record P15 asks for.
      pool: nodes.map((node) => traceNode(node, ids, stage1Ids, rescuedIds, rescue.candidateIds, signals)),
      seedCount: seedIds.size,
      budgets: { maxNodes: cap, rescueQuota: quota },
      stage1CutScore: stage1.length ? score(stage1[stage1.length - 1]) : null,
      // The floor is a different mechanism and records its own decisions; a kernel run alone made none.
      floorDecisions: []
    }
  };
}

/** One pool node's outcome, derived from the id sets the prune already built. Total: every node lands. */
function traceNode(
  node: any,
  retainedIds: Set<string>,
  stage1Ids: Set<string>,
  rescuedIds: Set<string>,
  rescueCandidateIds: Set<string>,
  signals: Map<string, RescueSignal>
): TraceNode {
  const id = String(node.id);
  const signal = signals.get(id);
  const outcome: SelectionChannel = !retainedIds.has(id) ? "displaced"
    : stage1Ids.has(id) ? "stage1"
    : rescuedIds.has(id) ? "rescue"
    : "backfill";
  return {
    nodeId: id,
    nodeKind: String(node.kind ?? ""),
    name: String(node.name ?? ""),
    relativePath: String(node.filePath ?? ""),
    startLine: Number.isInteger(node.startLine) ? Number(node.startLine) : null,
    endLine: Number.isInteger(node.endLine) ? Number(node.endLine) : null,
    outcome,
    score: signal?.total ?? 0,
    // A rescue states the signal that saved it and a displaced candidate states the signal that was not
    // enough; the two intrinsic channels have nothing of their own to say and say nothing.
    reason: outcome === "rescue" || (outcome === "displaced" && rescueCandidateIds.has(id)) ? (signal?.reason ?? "") : "",
    displacedBy: outcome !== "displaced" ? null : rescueCandidateIds.has(id) ? "rescue-quota" : "stage1-cut"
  };
}

/**
 * The trace-free prune: `pruneFeatureGraphRecorded` with the record dropped.
 *
 * A shell with no logic of its own, which is what makes the byte-equality claim checkable rather than argued —
 * the frozen real-pool gates in `tests/feature-prune.test.ts` and `eval/tests/module-floor.test.ts` call this
 * and therefore exercise the recorded kernel directly.
 */
export function pruneFeatureGraph(nodes: any[], edges: any[], seeds: any[], anchorTerms: string[], maxNodes: number): { nodes: any[]; edges: any[] } {
  const { nodes: retained, edges: retainedEdges } = pruneFeatureGraphRecorded(nodes, edges, seeds, anchorTerms, maxNodes);
  return { nodes: retained, edges: retainedEdges };
}
