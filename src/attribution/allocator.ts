import {
  CONTRIBUTION_CHANNELS, RANK_CONSTANT, WEIGHTS,
  type ChannelWeights, type ContributionChannel, type RanSelectionTrace,
  type SelectionContribution, type SelectionChannel, type TraceNode
} from "./selection-trace.ts";

const KEY_SEP = "\u0001";
const SCHEDULER_PATH = /(^|\/)(crons?|tasks?|jobs?|schedules?|workers?)(\/|$)/i;
const SCHEDULER_NAME = /cron|schedule|sync|task|job|worker|execute|run/i;
const COMMON_PATH = /common\/components|common\/use|vendor|bootstrap|min\.js/i;
const TEST_PATH = /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\./i;
export const BRIDGE_MAX_MULTIPLICITY = 3;

export interface AllocatorOptions {
  readonly weights?: ChannelWeights;
  readonly documentFrequency?: boolean;
  readonly derivedTerms?: boolean;
}

export interface RecordedAllocation {
  readonly nodes: any[];
  readonly edges: any[];
  readonly trace: RanSelectionTrace;
}

interface Evidence {
  readonly strength: number;
  readonly reason: string;
  readonly anchor: string | null;
  readonly propagationPath: readonly string[];
}

interface RankedEvidence extends Evidence { readonly rank: number }

function compareStr(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function compareNode(a: any, b: any): number {
  return compareStr(String(a.filePath ?? ""), String(b.filePath ?? ""))
    || compareStr(String(a.name ?? ""), String(b.name ?? ""))
    || compareStr(String(a.id), String(b.id));
}

export function dedupeEdges(edges: any[]): any[] {
  const seen = new Set<string>();
  const result: any[] = [];
  for (const edge of edges) {
    const key = `${String(edge.source)}${KEY_SEP}${String(edge.target)}${KEY_SEP}${String(edge.kind)}${KEY_SEP}${edge.line ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edge);
  }
  return result.sort((a, b) => compareStr(String(a.kind), String(b.kind))
    || compareStr(String(a.source), String(b.source))
    || compareStr(String(a.target), String(b.target))
    || ((a.line ?? -1) - (b.line ?? -1)));
}

export function consonantSkeleton(term: string): string | null {
  const value = String(term).toLowerCase();
  if (value.length < 5 || !/^[a-z][a-z0-9]+$/.test(value)) return null;
  const skeleton = value[0] + value.slice(1).replace(/[aeiou]/g, "");
  return skeleton.length >= 2 && skeleton.length < value.length ? skeleton : null;
}

function abbreviationAnchors(anchorTerms: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const term of anchorTerms) {
    const skeleton = consonantSkeleton(term);
    if (skeleton && !result.has(skeleton)) result.set(skeleton, String(term).toLowerCase());
  }
  return result;
}

export function deriveAbbreviations(anchorTerms: string[]): Set<string> {
  return new Set(abbreviationAnchors(anchorTerms).keys());
}

export function nameTokens(name: string): Set<string> {
  const spaced = String(name).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return new Set(spaced.split(/[^A-Za-z]+/).filter((word) => word.length >= 2).map((word) => word.toLowerCase()));
}

function tokenSet(value: string): Set<string> {
  return new Set(String(value).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

function best(current: Evidence | undefined, candidate: Evidence): Evidence {
  if (!current || candidate.strength > current.strength) return candidate;
  if (candidate.strength < current.strength) return current;
  const a = `${candidate.reason}\0${candidate.anchor ?? ""}\0${candidate.propagationPath.join("\0")}`;
  const b = `${current.reason}\0${current.anchor ?? ""}\0${current.propagationPath.join("\0")}`;
  return a < b ? candidate : current;
}

function documentFrequency(terms: readonly string[], nodes: readonly any[]): Map<string, number> {
  const filesByTerm = new Map<string, Set<string>>();
  for (const term of terms) filesByTerm.set(term, new Set());
  for (const node of nodes) {
    const text = `${String(node.filePath ?? "")} ${String(node.name ?? "")} ${String(node.signature ?? "")}`.toLowerCase();
    for (const term of terms) if (text.includes(term)) filesByTerm.get(term)!.add(String(node.filePath ?? ""));
  }
  return new Map([...filesByTerm].map(([term, files]) => [term, files.size]));
}

function lexicalEvidence(node: any, terms: readonly string[], frequency: ReadonlyMap<string, number>, useDf: boolean): Evidence | undefined {
  const name = String(node.name ?? "");
  const lowerName = name.toLowerCase();
  const path = String(node.filePath ?? "").toLowerCase();
  const signature = String(node.signature ?? "").toLowerCase();
  const names = nameTokens(name);
  const paths = tokenSet(path);
  let result: Evidence | undefined;
  for (const term of terms) {
    let field = "";
    let base = 0;
    if (names.has(term)) { field = "name-token"; base = 5; }
    else if (lowerName.includes(term)) { field = "name-substring"; base = 4; }
    else if (paths.has(term)) { field = "path-token"; base = 3; }
    else if (path.includes(term)) { field = "path-substring"; base = 2; }
    else if (signature.includes(term)) { field = "signature"; base = 1; }
    if (!base) continue;
    const df = useDf ? (frequency.get(term) ?? 0) : 0;
    const strength = base + (useDf ? 1 / (1 + df) : 0);
    result = best(result, { strength, reason: `${field} ${term}`, anchor: term, propagationPath: [] });
  }
  return result;
}

function derivedEvidence(node: any, abbreviations: ReadonlyMap<string, string>): Evidence | undefined {
  const tokens = nameTokens(String(node.name ?? ""));
  let result: Evidence | undefined;
  for (const [abbreviation, anchor] of abbreviations) if (tokens.has(abbreviation)) {
    result = best(result, { strength: 1, reason: `derived-token ${abbreviation}`, anchor, propagationPath: [`${anchor}->${abbreviation}`] });
  }
  return result;
}

function rankChannel(nodes: readonly any[], evidence: ReadonlyMap<string, Evidence>): Map<string, RankedEvidence> {
  const ranked = nodes.filter((node) => evidence.has(String(node.id))).sort((a, b) => {
    const left = evidence.get(String(a.id))!;
    const right = evidence.get(String(b.id))!;
    return right.strength - left.strength || compareNode(a, b);
  });
  return new Map(ranked.map((node, index) => [String(node.id), { ...evidence.get(String(node.id))!, rank: index + 1 }]));
}

/**
 * Allocate at most maxNodes from the complete expanded pool. Every node is eligible through fallback; positive
 * channel signals affect rank, never admission. Producers rank locally and only ordinal RRF values are fused.
 */
export function allocateFeatureGraphRecorded(
  nodes: any[], edges: any[], seeds: any[], anchorTerms: string[], maxNodes: number, options: AllocatorOptions = {}
): RecordedAllocation {
  const weights = options.weights ?? WEIGHTS;
  const useDf = options.documentFrequency !== false;
  const useDerived = options.derivedTerms !== false;
  const terms = [...new Set(anchorTerms.map((term) => String(term).toLowerCase()).filter(Boolean))];
  const frequency = documentFrequency(terms, nodes);
  const abbreviations = useDerived ? abbreviationAnchors(terms) : new Map<string, string>();
  const nodeById = new Map(nodes.map((node) => [String(node.id), node]));
  const dedupedEdges = dedupeEdges(edges);

  const evidenceByChannel = new Map<ContributionChannel, Map<string, Evidence>>();
  for (const channel of CONTRIBUTION_CHANNELS) evidenceByChannel.set(channel, new Map());
  const put = (channel: ContributionChannel, id: string, evidence: Evidence): void => {
    const map = evidenceByChannel.get(channel)!;
    map.set(id, best(map.get(id), evidence));
  };

  const seedIds = new Set(seeds.map((node) => String(node.id)));
  for (const id of seedIds) if (nodeById.has(id)) put("seed", id, { strength: 2, reason: "query seed", anchor: id, propagationPath: [] });

  for (const node of nodes) {
    const id = String(node.id);
    const lexical = lexicalEvidence(node, terms, frequency, useDf);
    if (lexical) put("lexical", id, lexical);
    const derived = derivedEvidence(node, abbreviations);
    if (derived) put("derived", id, derived);
    const path = String(node.filePath ?? "");
    const penalty = COMMON_PATH.test(path) ? -2 : TEST_PATH.test(path) ? -1 : 0;
    put("fallback", id, { strength: penalty, reason: "stable budget fill", anchor: null, propagationPath: [] });
  }

  const semanticMatched = new Map<string, Evidence>();
  for (const channel of ["lexical", "derived"] as const) for (const [id, evidence] of evidenceByChannel.get(channel)!) {
    // Propagation requires vocabulary in the target SYMBOL. A path-only match would turn every utility called
    // from a feature directory into a bridge (for example `moment` in leaveService.js), recreating a co-location
    // channel under a graph-shaped name.
    if (channel === "lexical" && !evidence.reason.startsWith("name-")) continue;
    semanticMatched.set(id, best(semanticMatched.get(id), evidence));
  }
  for (const node of nodes) {
    const id = String(node.id);
    const featureEvidence = evidenceByChannel.get("lexical")!.get(id) ?? evidenceByChannel.get("derived")!.get(id);
    if (!featureEvidence) continue;
    if (SCHEDULER_PATH.test(String(node.filePath ?? "")) && SCHEDULER_NAME.test(String(node.name ?? ""))) {
      put("convention", id, {
        strength: 1,
        reason: "feature-matched scheduler-path convention",
        anchor: featureEvidence.anchor,
        propagationPath: ["feature-evidence->scheduler-convention"]
      });
    }
  }

  const relationCounts = new Map<string, Map<string, { count: number; kind: string }>>();
  for (const edge of dedupedEdges) {
    const source = String(edge.source);
    const target = String(edge.target);
    if (seedIds.has(source) || seedIds.has(target)) {
      const candidate = seedIds.has(source) ? target : source;
      const anchor = seedIds.has(source) ? source : target;
      if (nodeById.has(candidate)) put("seed", candidate, {
        strength: 1, reason: `seed-neighbor ${String(edge.kind)}`, anchor,
        propagationPath: [`${source}->${target}:${String(edge.kind)}`]
      });
    }
    if (!semanticMatched.has(target) || source === target || !nodeById.has(source)) continue;
    let targets = relationCounts.get(source);
    if (!targets) { targets = new Map(); relationCounts.set(source, targets); }
    const previous = targets.get(target);
    if (previous) previous.count += 1;
    else targets.set(target, { count: 1, kind: String(edge.kind) });
  }
  for (const [source, targets] of relationCounts) {
    const ordered = [...targets].sort(([a], [b]) => compareStr(a, b));
    const [target, relation] = [...ordered].sort((a, b) => b[1].count - a[1].count || compareStr(a[0], b[0]))[0]!;
    const semantic = semanticMatched.get(target)!;
    put("relation", source, {
      strength: ordered.reduce((sum, [, row]) => sum + Math.min(row.count, BRIDGE_MAX_MULTIPLICITY), 0),
      reason: `outgoing ${relation.kind} to ${String(nodeById.get(target)?.name ?? target)}`,
      anchor: semantic.anchor,
      propagationPath: [`${source}->${target}:${relation.kind}`]
    });
  }

  const ranked = new Map<ContributionChannel, Map<string, RankedEvidence>>();
  for (const channel of CONTRIBUTION_CHANNELS) ranked.set(channel, rankChannel(nodes, evidenceByChannel.get(channel)!));

  const fused = nodes.map((node) => {
    const id = String(node.id);
    const contributions: SelectionContribution[] = [];
    for (const channel of CONTRIBUTION_CHANNELS) {
      const item = ranked.get(channel)!.get(id);
      if (!item) continue;
      contributions.push({
        sourceChannel: channel, reason: item.reason, anchor: item.anchor, propagationPath: [...item.propagationPath],
        rank: item.rank, normalizedContribution: weights[channel] / (RANK_CONSTANT + item.rank)
      });
    }
    const score = contributions.reduce((sum, item) => sum + item.normalizedContribution, 0);
    const decisive = [...contributions].sort((a, b) => b.normalizedContribution - a.normalizedContribution
      || CONTRIBUTION_CHANNELS.indexOf(a.sourceChannel) - CONTRIBUTION_CHANNELS.indexOf(b.sourceChannel))[0]!;
    return { node, score, decisive, contributions };
  }).sort((a, b) => b.score - a.score || compareNode(a.node, b.node));

  const cap = Math.max(0, maxNodes);
  const selected = fused.slice(0, cap);
  const retained = new Set(selected.map((row) => String(row.node.id)));
  const fusedById = new Map(fused.map((row) => [String(row.node.id), row]));
  const outputNodes = selected.map((row) => ["derived", "relation", "convention"].includes(row.decisive.sourceChannel)
    ? { ...row.node, rescued: `${row.decisive.sourceChannel}: ${row.decisive.reason}` }
    : row.node);
  const tracePool: TraceNode[] = nodes.map((node) => {
    const row = fusedById.get(String(node.id))!;
    const seated = retained.has(String(node.id));
    const outcome: SelectionChannel = seated ? row.decisive.sourceChannel : "displaced";
    return {
      nodeId: String(node.id), nodeKind: String(node.kind ?? ""), name: String(node.name ?? ""),
      relativePath: String(node.filePath ?? ""),
      startLine: Number.isInteger(node.startLine) ? Number(node.startLine) : null,
      endLine: Number.isInteger(node.endLine) ? Number(node.endLine) : null,
      outcome, score: row.score, reason: row.decisive.reason,
      contributions: row.contributions, displacedBy: seated ? null : "seat-cap"
    };
  });
  const cutoffScore = selected.length ? selected[selected.length - 1]!.score : null;
  const ids = new Set(outputNodes.map((node) => String(node.id)));
  return {
    nodes: outputNodes,
    edges: dedupedEdges.filter((edge) => ids.has(String(edge.source)) && ids.has(String(edge.target))),
    trace: {
      status: "ran", pool: tracePool, seedCount: seedIds.size, budgets: { maxNodes: cap },
      fusion: {
        method: "weighted-reciprocal-rank", rankConstant: RANK_CONSTANT,
        rawScoresSummedAcrossChannels: false, tieBreak: ["relativePath", "name", "nodeId"], cutoffScore
      }
    }
  };
}

export function allocateFeatureGraph(
  nodes: any[], edges: any[], seeds: any[], anchorTerms: string[], maxNodes: number, options: AllocatorOptions = {}
): { nodes: any[]; edges: any[] } {
  const result = allocateFeatureGraphRecorded(nodes, edges, seeds, anchorTerms, maxNodes, options);
  return { nodes: result.nodes, edges: result.edges };
}
