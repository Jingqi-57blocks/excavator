// BOUNDARY FUNCTIONS — the second source for the read-obligation denominator.
//
// The first source (the fact pack's `logic` complement) enumerates what the prune RETAINED, so it inherits
// the boundary's recall ceiling: measured on a real run, `service.go` was inside the boundary with
// obligations over 19-53 and 276-359, while `Creation` (line 56, the attachment rule) and `Demand` (136)
// sat in the gap between them and carried no obligation at all. The file was in; the functions were not.
//
// This module enumerates every function-shaped symbol the graph knows in the boundary's own files, then
// asks the decision probe which of them branch. Both numbers are measured, not assumed: on that run the
// raw enumeration is 3.1× the current denominator and the decision filter brings it to 2.1×.
//
// CURATION, NOT DROPPING — the same discipline read-obligations.ts follows. Candidates that probe as
// decision-free or unprobeable stay in the artifact with their verdict recorded, so the filter's cost is
// auditable and its known ceilings (a JSX component branching only through `cond && <X/>`; a language with
// no grammar) are countable rather than invisible.
//
// Kinds are an allowlist, not "every multi-line node". A class or struct node spans its members, and
// `markExclusions` keeps the OUTER span and drops the inner ones — admitting container kinds would
// therefore swallow every method obligation inside them and collapse the granularity this slice exists to
// add. `component` is in the list because a frontend component is where form rules and conditional
// rendering live, and the boundary's frontend silence is one of the misses being chased.

import { readFile } from "node:fs/promises";
import type { GraphReader } from "../codegraph/codegraph.ts";
import type { GraphNode } from "../core/types.ts";
import { probeDecision, type ProbeResult } from "../assurance/decision-probe.ts";

export const BOUNDARY_FUNCTIONS_VERSION = "boundary-functions-v1";

/** Graph node kinds that denote a function-shaped symbol — never a container that spans its members. */
export const BOUNDARY_FUNCTION_KINDS: readonly string[] = ["component", "constructor", "function", "method"];

/** A file larger than this is not read for probing: the cost is unbounded and the payoff is one boolean. */
const MAX_PROBE_BYTES = 1_500_000;

/** Enumeration cap. Reaching it truncates by file, which `truncated` records rather than hides. */
const NODE_CAP = 5000;

export interface BoundaryFunction {
  path: string;
  name: string;
  /** The graph's own kind, kept so a reader can see WHICH allowlist entry produced this candidate. */
  graphKind: string;
  startLine: number;
  endLine: number;
  /** `decision` becomes an obligation; the other two stay visible and are counted, never silently dropped. */
  probe: ProbeResult;
}

export interface FeatureBoundaryFunctions {
  featureKey: string;
  /** Boundary files considered — the denominator of this enumeration, so its own scope is auditable. */
  files: number;
  functions: BoundaryFunction[];
  /**
   * Boundary files where the graph knew no function-shaped symbol: the language-blindness surface.
   * Meaningless when `truncated` is set — a file past the query cap is indistinguishable from a file the
   * graph had nothing for, which is exactly why truncation must be recorded rather than inferred.
   */
  filesWithoutCandidates: string[];
  /** The node cap was reached: this enumeration is a prefix, not the full set. */
  truncated: boolean;
  /** Why any candidate could not be probed — kept per feature so the artifact carries its own degradation. */
  warnings: string[];
}

export interface BoundaryFunctionsArtifact {
  version: string;
  snapshotId: string;
  /** False for a source-only run: the second source is then absent, and that absence is recorded. */
  graphAvailable: boolean;
  enumeratedKinds: string[];
  features: FeatureBoundaryFunctions[];
  warnings: string[];
}

export interface BoundaryEnumerationInput {
  featureKey: string;
  /** Boundary files, snapshot-relative. */
  files: string[];
  /** Resolves a snapshot-relative path to an absolute one; missing entries are skipped with a warning. */
  absolutePathFor: (path: string) => string | undefined;
}

/**
 * Enumerate the decision-bearing functions in one feature's boundary files. Never throws: a graph query
 * that fails or a file that cannot be read degrades to a warning, because this is an advisory second
 * source and a run must not die for it.
 */
export async function enumerateBoundaryFunctions(
  graph: GraphReader | null,
  input: BoundaryEnumerationInput,
  warnings: string[],
): Promise<FeatureBoundaryFunctions> {
  const local: string[] = [];
  const note = (message: string): void => { local.push(message); warnings.push(message); };
  const result: FeatureBoundaryFunctions = { featureKey: input.featureKey, files: input.files.length, functions: [], filesWithoutCandidates: [], truncated: false, warnings: local };
  if (!graph || !input.files.length) return result;

  let candidates: GraphNode[];
  try {
    candidates = graph.nodesByKindInFiles([...BOUNDARY_FUNCTION_KINDS], input.files, NODE_CAP);
  } catch (error) {
    note(`Boundary function enumeration for "${input.featureKey}" failed: ${(error as Error).message}`);
    return result;
  }
  // The cap orders by file, so hitting it drops whole files off the end — and those files would then be
  // reported as "the graph knew nothing here", dressing a truncation up as language blindness.
  if (candidates.length >= NODE_CAP) {
    result.truncated = true;
    note(`Boundary function enumeration for "${input.featureKey}" hit the ${NODE_CAP}-node cap; filesWithoutCandidates is not meaningful for this feature`);
  }

  const withCandidates = new Set<string>();
  const sourceCache = new Map<string, string[] | null>();
  for (const node of candidates) {
    const path = String(node.filePath ?? "");
    const name = String(node.name ?? "");
    const startLine = Number(node.startLine ?? 0);
    const endLine = Number(node.endLine ?? 0);
    if (!path || !name || !startLine) continue;
    withCandidates.add(path);
    // A single-line symbol is a declaration; read-obligations excludes those anyway, and probing one line
    // would only ever answer `no-decision`.
    if (endLine <= startLine) continue;
    const lines = await sourceLines(path, input.absolutePathFor, sourceCache, note);
    const probe: ProbeResult = lines === null
      ? "unavailable"
      : probeDecision(lines.slice(startLine - 1, endLine).join("\n"), path);
    result.functions.push({ path, name, graphKind: String(node.kind ?? ""), startLine, endLine, probe });
  }

  result.functions.sort((a, b) => cmp(a.path, b.path) || a.startLine - b.startLine || cmp(a.name, b.name));
  result.filesWithoutCandidates = input.files.filter((file) => !withCandidates.has(file)).sort(cmp);
  return result;
}

async function sourceLines(
  path: string,
  absolutePathFor: (path: string) => string | undefined,
  cache: Map<string, string[] | null>,
  note: (message: string) => void,
): Promise<string[] | null> {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  const absolute = absolutePathFor(path);
  let lines: string[] | null = null;
  if (!absolute) {
    note(`Boundary function probe skipped ${path}: not in the snapshot manifest`);
  } else {
    try {
      const text = await readFile(absolute, "utf8");
      lines = text.length > MAX_PROBE_BYTES ? null : text.split("\n");
      if (lines === null) note(`Boundary function probe skipped ${path}: file exceeds ${MAX_PROBE_BYTES} bytes`);
    } catch (error) {
      note(`Boundary function probe skipped ${path}: ${(error as Error).message}`);
    }
  }
  cache.set(path, lines);
  return lines;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
