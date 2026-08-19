/**
 * The one rule for deciding whether two route-ish paths describe the same endpoint.
 *
 * Extracted from `crossrepo/link-match.ts`, where it decided whether a frontend call reaches a backend route,
 * because a second consumer now needs the same question answered: an entrypoint hypothesis against an indexed
 * route. Two aligners would drift, and the drift would be invisible — each would look right in its own tests
 * while disagreeing about the cases that matter (a hole opposite a literal is the one that was measured wrong
 * every time it was allowed).
 *
 * Behaviour is byte-identical to the original; `crossrepo` consumes this function rather than keeping a copy.
 *
 * ONE ASYMMETRY WORTH KNOWING, deliberately left alone: a hole is recognised as a segment starting with `:p`,
 * which is the shape `link-match` normalises frontend template holes into. A profile hypothesis writes real
 * parameter names (`:leave_id`), so its parameters are read as LITERAL segments here. That still produces the
 * right verdicts — a hypothesis parameter opposite a route parameter lands in the "literal against parameter"
 * branch and yields `parameterised`, and opposite a differing literal it yields `null` — so the two callers agree
 * on every outcome that matters. Widening the hole test to any `:` prefix would change `link-match`'s measured
 * behaviour, and this function's whole reason for existing is that its behaviour does not change per caller.
 */

/** Split a path into non-empty segments. `/a//b/` and `a/b` are the same path. */
export function pathSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/**
 * Align a call or hypothesis path against a route path.
 *   `exact`         — every segment literal-equal;
 *   `parameterised` — literals equal and every hole sits opposite a route parameter;
 *   `weak`          — a hole sits opposite a LITERAL route segment (measured: always wrong);
 *   `null`          — different length, or two literals that differ.
 */
export function alignPaths(call: string[], route: string[]): "exact" | "parameterised" | "weak" | null {
  // A wildcard route (`/*any`) absorbs the remainder, so it matches on its literal prefix.
  const wildcard = route.findIndex((segment) => segment.startsWith("*"));
  if (wildcard >= 0) {
    if (call.length < wildcard) return null;
    for (let index = 0; index < wildcard; index++) if (call[index] !== route[index]) return null;
    return "parameterised";
  }
  if (call.length !== route.length) return null;
  let sawHoleOnParam = false;
  let sawHoleOnLiteral = false;
  for (let index = 0; index < call.length; index++) {
    const left = call[index]!;
    const right = route[index]!;
    const leftIsHole = left.startsWith(":p");
    const rightIsParam = right.startsWith(":");
    if (leftIsHole) {
      if (rightIsParam) sawHoleOnParam = true;
      else sawHoleOnLiteral = true;
      continue;
    }
    if (rightIsParam) {
      // A literal frontend segment against a backend parameter is a legitimate concrete call — but it is
      // NOT a literal match, and calling it one would make `/v2/leaves/me` tie with `/v2/leaves/:id`. The
      // router itself resolves that tie by trying the literal route first, so absorption ranks lower.
      sawHoleOnParam = true;
      continue;
    }
    if (left !== right) return null;
  }
  if (sawHoleOnLiteral) return "weak";
  return sawHoleOnParam ? "parameterised" : "exact";
}

/**
 * Align a PATTERN against a route path — the hypothesis case, which is not the call case.
 *
 * `alignPaths` answers "would this concrete call reach that route", and its most useful rule is that a literal
 * call segment is absorbed by a route parameter: `/leaves/me` really does reach `/leaves/:id`. Applying that rule
 * to a hypothesis is what this function exists to avoid. Measured on the frozen wcp corpus: the single-segment
 * literal hypothesis `GET /remain-fully-paid-sick` matched **22 routes** through absorption — `GET /:id` in four
 * modules, `GET /:projectKey`, `GET /:policy_id`, and `GET /*any` in a module that has nothing to do with leave.
 * A hypothesis is a pattern, not a request: it names a shape the operator believes exists, and a shape does not
 * get to claim every parameterised route of the same arity.
 *
 * So: parameters match parameters, literals must be equal, and neither absorption nor wildcards match. Every
 * difference from `alignPaths` is strictly NARROWING — this function can only return fewer matches, never invent
 * one — which is why the two can disagree without either being unsound for its own caller.
 */
export function alignHypothesis(hypothesis: string[], route: string[]): "exact" | "parameterised" | null {
  // A wildcard route handles everything, so absorbing a hypothesis into one is technically true and useless: it
  // would admit every catch-all in the corpus for every hypothesis. Recall has to be about a specific endpoint.
  if (route.some((segment) => segment.startsWith("*"))) return null;
  if (hypothesis.length !== route.length) return null;

  let sawParameter = false;
  for (let index = 0; index < hypothesis.length; index++) {
    const left = hypothesis[index]!;
    const right = route[index]!;
    const leftIsParam = left.startsWith(":");
    const rightIsParam = right.startsWith(":");
    if (leftIsParam !== rightIsParam) return null;
    if (leftIsParam) { sawParameter = true; continue; }
    if (left !== right) return null;
  }
  return sawParameter ? "parameterised" : "exact";
}
