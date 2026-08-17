// HANDLER RESOLVE — from the handler argument at a registration line to the function that runs.
//
// A link's backend end is a registration: `leaveGrp.POST("", e.CatchError(leave.Creation))`. That line is
// one line long, so it is worthless as a reading obligation — what a reader must actually read is
// `Creation`'s body. Resolving one to the other is a lookup, and it has exactly one honest answer or none.
//
// The rule is Go's own: `leave.Creation` names a PACKAGE-LEVEL FUNCTION in package `leave`. Both halves are
// load-bearing, measured on the real target:
//   - the qualifier disambiguates — `Creation` alone matches 12 nodes across newsletter/policy/proposal/…;
//   - the kind disambiguates — inside the leave package, `Demand` is BOTH a package function
//     (`router.go:48-55`, the handler) and a method (`service.go:136-274`, the service). `leave.Demand`
//     means the first. Taking the larger span because it "looks more like the real logic" would be a guess.
//
// Anything that does not resolve to exactly one candidate resolves to nothing, and the caller counts it.
// A handler attributed to the wrong function would put a reading obligation — and later a claim — on code
// that has nothing to do with the route.

import type { GraphNode } from "../base/types.ts";

/** Node kinds that can be a package-level handler. Methods are excluded on purpose (see the header). */
const HANDLER_KINDS = new Set(["function"]);

export interface HandlerTarget {
  qualifier: string | null;
  name: string;
}

export interface ResolvedHandler {
  name: string;
  path: string;
  startLine: number;
  endLine: number;
}

/**
 * Parse the handler argument as written. `e.CatchError(leave.Creation)` → `{ qualifier: "leave", name:
 * "Creation" }`; a bare `leave.Creation` parses the same way. Returns null when no identifier chain is
 * present at all (an inline closure, for instance) — which is a real answer, not a failure.
 */
export function parseHandlerTarget(expression: string): HandlerTarget | null {
  // An inline handler has no named function to point at, and its BODY is full of qualified identifiers —
  // measured: 48 express registrations resolved to `res.json` because the last `x.y` in the argument was
  // inside the closure. "This handler is inline" is the true answer; naming something from its body is not.
  if (/=>|\bfunction\b|[{;]/.test(expression)) return null;
  // Otherwise the LAST qualified identifier is the handler: wrappers like `e.CatchError(...)` and
  // `auth.Required(...)` put their own names first.
  const matches = [...expression.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/g)];
  if (matches.length) {
    const last = matches[matches.length - 1];
    return { qualifier: last[1], name: last[2] };
  }
  const bare = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(expression);
  return bare ? { qualifier: null, name: bare[1] } : null;
}

/**
 * Resolve a handler target against a module's nodes. `candidates` is whatever the caller's graph query
 * returned for this name; the filtering below is what makes the answer unique or absent.
 */
export function resolveHandler(target: HandlerTarget, candidates: GraphNode[], aliases?: Map<string, string>): ResolvedHandler | null {
  const named = candidates.filter((node) => node.name === target.name && HANDLER_KINDS.has(String(node.kind)));
  // A Go import may rename the package: `aplyGeneral "…/handlers/application/general"` means the qualifier
  // `aplyGeneral` and the directory `general` are the same package. Measured: 23 registrations resolved to
  // nothing for this reason alone — a miss, not a mistake, but a whole class of them.
  const directory = (target.qualifier && aliases?.get(target.qualifier)) || target.qualifier;
  const scoped = directory
    ? named.filter((node) => pathHasDirectory(String(node.filePath), directory))
    : named;
  if (scoped.length !== 1) return null;
  const node = scoped[0];
  const startLine = Number(node.startLine);
  const endLine = Number(node.endLine);
  if (!startLine || !endLine || endLine <= startLine) return null;
  return { name: node.name, path: String(node.filePath), startLine, endLine };
}

/**
 * Import aliases declared in a Go file: `aplyGeneral "wcp/internal/handlers/application/general"` maps the
 * alias to the package's directory name. Only aliased imports matter; a plain import already uses the
 * directory name as its qualifier.
 */
export function goImportAliases(source: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const match of source.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+"([^"]+)"/gm)) {
    const alias = match[1];
    if (alias === "import" || alias === "package") continue;
    const segments = match[2].split("/").filter(Boolean);
    const directory = segments[segments.length - 1];
    if (directory) aliases.set(alias, directory);
  }
  return aliases;
}

/** True when a path contains this directory as a whole segment — `leave` must not match `leaveDraft`. */
function pathHasDirectory(path: string, directory: string): boolean {
  return path.split("/").slice(0, -1).includes(directory);
}
