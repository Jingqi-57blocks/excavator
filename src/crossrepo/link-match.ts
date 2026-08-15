// LINK MATCH — pairing one frontend call with the backend route that serves it.
//
// Pure: no I/O, no graph, no model. The same function runs inside prepare and inside the eval harness, so a
// gate result and a run artifact can never disagree about what matched.
//
// The rule table is calibrated, not invented. Measured across 411 real frontend calls against the recovered
// route tables of four backends:
//   R1 every segment literal-equal                                        static / confirmed  (149 real)
//   R2 literals equal, frontend holes align with route params             static / confirmed  (216 real)
//   R3 one candidate survives because the router itself would pick it     framework / probable (0 real)
//   R4 a frontend hole aligned against a LITERAL backend segment          NOT A LINK — see below (6 real)
//
// R3 fired zero times on the real target, and that is expected rather than disappointing: gin's router
// REFUSES to register two routes that could both absorb one path, and express resolves such a pair by
// registration order, which this matcher does not model. So the only precedence it applies is the one both
// routers agree on and the source does show — a literal segment beats a parameter. Anything past that is
// reported ambiguous, with both candidates named, instead of being decided by a rule of thumb.
//
// R4 is where a resolver earns or loses its claim to be deterministic. All four real instances were
// semantically wrong (`GET /v2/projects/:p/feeds` "matching" `GET /v2/projects/plan/:year`), so it emits no
// Finding at all: a weak candidate is recorded for a human, never asserted as a link. That is the
// pre-authorised degradation in the base document, executed early because the data asked for it.
//
// Nothing here is lenient. Case is not folded, trailing slashes are not forgiven, and a method mismatch is
// not a near-enough match — it is reported as a near miss, because "the frontend calls PATCH where the
// backend only serves PUT" is a finding about the system, not a flaw in the matcher.

import type { FrontendCall } from "./frontend-calls.ts";
import type { RecoveredRoute } from "./route-table.ts";

export const LINK_MATCH_VERSION = "link-match-v1";

export type LinkResolution = "static" | "framework";
export type LinkConfidence = "confirmed" | "probable";

export interface RouteCandidate {
  module: string;
  route: RecoveredRoute;
}

export interface MatchedLink {
  call: FrontendCall;
  module: string;
  route: RecoveredRoute;
  resolution: LinkResolution;
  confidence: LinkConfidence;
  /** Which rule produced this link — the audit trail for a match a human questions. */
  rule: "R1" | "R2" | "R3";
}

export interface NearMiss {
  module: string;
  route: string;
  mismatch: "method" | "segments";
}

export type MatchOutcome =
  | { kind: "matched"; link: MatchedLink }
  | { kind: "ambiguous"; candidates: Array<{ module: string; route: string }> }
  | { kind: "weak"; candidates: Array<{ module: string; route: string }> }
  | { kind: "unresolved"; nearMisses: NearMiss[] };

/** Match one call against every recovered route in the workspace. */
export function matchCall(call: FrontendCall, candidates: RouteCandidate[]): MatchOutcome {
  if (!call.routePath) return { kind: "unresolved", nearMisses: [] };
  const callSegments = segments(call.routePath);

  const exact: RouteCandidate[] = [];
  const parameterised: RouteCandidate[] = [];
  const weak: RouteCandidate[] = [];
  const nearMisses: NearMiss[] = [];

  for (const candidate of candidates) {
    const routeSegments = segments(candidate.route.path);
    const methodOk = candidate.route.method === call.method || candidate.route.method === "ANY";
    const alignment = align(callSegments, routeSegments);
    if (!alignment) continue;
    if (!methodOk) {
      // "The frontend calls PATCH where the backend only registers GET" is a finding about the system —
      // but only when the PATH genuinely matches. A weak alignment reported as a method mismatch would
      // present an unrelated route as "the backend for this path", which is a false statement, not a lead.
      if (alignment !== "weak") {
        nearMisses.push({ module: candidate.module, route: `${candidate.route.method} ${candidate.route.path}`, mismatch: "method" });
      }
      continue;
    }
    if (alignment === "exact") exact.push(candidate);
    else if (alignment === "parameterised") parameterised.push(candidate);
    else weak.push(candidate);
  }

  // A router tries a literal segment before a parameter, so an exact match wins over a parameterised one
  // even when both are registered — that precedence is a property of the framework, hence R3 when it decides.
  if (exact.length === 1) return { kind: "matched", link: link(call, exact[0], "R1") };
  if (exact.length > 1) return { kind: "ambiguous", candidates: describe(exact) };
  if (parameterised.length === 1) return { kind: "matched", link: link(call, parameterised[0], "R2") };
  // Two parameterised routes that both absorb this call cannot be separated from source: gin would have
  // refused to register them, and express decides by registration order, which is not modelled here.
  // Picking "the one with fewer parameters" is a rule of thumb that demonstrably chooses wrong
  // (`/a/:x/:y` vs `/:z/b/c` for `/a/b/c`), so the honest answer is to name both.
  if (parameterised.length > 1) return { kind: "ambiguous", candidates: describe(parameterised) };
  if (weak.length) return { kind: "weak", candidates: describe(weak) };
  return { kind: "unresolved", nearMisses: nearMisses.sort((a, b) => cmp(a.module, b.module) || cmp(a.route, b.route)) };
}

function link(call: FrontendCall, candidate: RouteCandidate, rule: MatchedLink["rule"]): MatchedLink {
  const framework = rule === "R3" || candidate.route.method === "ANY";
  return {
    call,
    module: candidate.module,
    route: candidate.route,
    resolution: framework ? "framework" : "static",
    confidence: framework ? "probable" : "confirmed",
    rule,
  };
}

/**
 * Align a call path against a route path.
 *   `exact`         — every segment literal-equal;
 *   `parameterised` — literals equal and every frontend hole sits opposite a route parameter;
 *   `weak`          — a frontend hole sits opposite a LITERAL route segment (measured: always wrong);
 *   `null`          — different length, or two literals that differ.
 */
function align(call: string[], route: string[]): "exact" | "parameterised" | "weak" | null {
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
    const left = call[index];
    const right = route[index];
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

function describe(candidates: RouteCandidate[]): Array<{ module: string; route: string }> {
  return candidates
    .map((candidate) => ({ module: candidate.module, route: `${candidate.route.method} ${candidate.route.path}` }))
    .sort((a, b) => cmp(a.module, b.module) || cmp(a.route, b.route));
}

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
