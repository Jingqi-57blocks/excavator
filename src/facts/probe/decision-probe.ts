// DECISION PROBE — does this span of source contain a branch at all?
//
// The read-obligation denominator is currently the fact pack's `logic` complement, which inherits the
// boundary's recall ceiling: a function the prune never retained carries no obligation even when its file
// is inside the boundary. Measured on a real run, `service.go` had obligations over 19-53 and 276-359 but
// nothing between — and `Creation` (line 56, the attachment rule) and `Demand` (line 136) live in that gap.
//
// Enumerating every function in the boundary files closes the gap but inflates the denominator 3.1×
// (486 multi-line functions against 155 counted obligations, measured). Curation is therefore not optional:
// a getter with no branch is not a reading obligation, and counting it buys coverage with free passes. This
// module answers the one mechanical question that separates the two: does the span branch?
//
// Structural, not textual. A `switch` inside a comment or a string is not a branch, and only an AST knows
// the difference — the same reason condition-extract.ts stopped using a regex.
//
// KNOWN CEILING, deliberately not treated here: a JSX component that branches only through `cond && <X/>`
// has no if/ternary/switch node and probes as decision-free. The caller keeps decision-free candidates in
// its artifact rather than dropping them, so this ceiling stays measurable instead of invisible.

import { AST_LANGUAGE_BY_EXTENSION, loadAstGrep, type AstNode } from "./condition-extract.ts";

/**
 * Node kinds that mean "control flow forks here", across the grammars we can parse. The list spans two
 * naming conventions on purpose: Go emits `expression_switch_statement` / `expression_case` where
 * TypeScript emits `switch_statement` / `switch_case`, and a kind absent from a grammar simply never
 * matches. Loops count: an iteration boundary is a path a reader must follow.
 */
export const DECISION_NODE_KINDS: readonly string[] = [
  "case_clause",
  "conditional_expression",
  "default_case",
  "expression_case",
  "expression_switch_statement",
  "for_statement",
  "if_statement",
  "select_statement",
  "switch_case",
  "switch_statement",
  "ternary_expression",
  "type_switch_statement",
  "while_statement",
];

export type ProbeResult = "decision" | "no-decision" | "unavailable";

/**
 * Probe one span of source. `unavailable` is a first-class answer — a language with no grammar here cannot
 * be judged, and guessing either way would be dishonest: guessing `decision` inflates the denominator with
 * unjudged spans, guessing `no-decision` silently drops real rules.
 */
export function probeDecision(text: string, path: string): ProbeResult {
  const language = AST_LANGUAGE_BY_EXTENSION[extensionOf(path)];
  if (!language) return "unavailable";
  const api = loadAstGrep();
  if (!api) return "unavailable";
  let root: AstNode;
  try {
    root = api.parse(language, text).root();
  } catch {
    return "unavailable";
  }
  for (const kind of DECISION_NODE_KINDS) {
    try {
      if (root.findAll({ rule: { kind } }).length > 0) return "decision";
    } catch {
      // A kind this grammar does not define is not an error, just a miss.
    }
  }
  return "no-decision";
}

function extensionOf(path: unknown): string {
  const value = String(path ?? "");
  const dot = value.lastIndexOf(".");
  return dot < 0 ? "" : value.slice(dot).toLowerCase();
}
