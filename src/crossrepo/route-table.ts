// ROUTE TABLE — the full HTTP path a backend actually serves, recovered from its registration source.
//
// CodeGraph already has `route` nodes, but their name is the path as WRITTEN at the registration line —
// `GET /:position_id`, not `GET /v2/support/positions/:position_id`. A router group nests: the prefix lives
// in a chain of variables above the call, so a route node ALONE cannot be matched against a frontend URL.
//
// Recovering that chain is deterministic: every prefix is a string literal read from source, composed by
// the framework's own documented rule. It is therefore NOT what `resolution: "framework"` marks on a link —
// that label is reserved for the cases where matching relies on router behaviour the source does not show
// (precedence between two candidates, `ANY`, wildcards). Composition is recorded instead by keeping
// `localPath` next to `path`, so a reader can always see that the full path was assembled.
//
// Two frameworks, measured on the real target:
//   gin      `v2 := engine.Group("/v2")` → `g := v2.Group("/leaves")` → `g.POST("", h)`  ⇒  POST /v2/leaves
//   express  `app.use('/leaves', leaveRouter)` + `router.post('/', h)`                   ⇒  POST /leaves
//
// Every chain observed in the target is FILE-LOCAL (a group variable is assigned and used in the same
// file), so recovery needs no cross-file dataflow; express is the one exception and resolves through a
// single `require` hop, which the caller supplies as a mount table.
//
// Recovery is deliberately stricter than the graph: a registration whose path is not a literal is recorded
// as unrecovered rather than guessed. The caller reconciles the recovered table against the graph's own
// route nodes, so a gap in either direction is visible instead of assumed away.

import { loadAstGrep, type AstNode } from "../facts/probe/condition-extract.ts";

export const ROUTE_TABLE_VERSION = "route-table-v1";

export type RouteFramework = "gin" | "express";

export interface RecoveredRoute {
  /** Uppercase HTTP method, or `ANY` for a catch-all registration. */
  method: string;
  /** Full path including every recovered prefix, as the server would match it. */
  path: string;
  /** Path as written at the registration line, before prefixes — kept so recovery stays auditable. */
  localPath: string;
  /** Source of the handler argument, verbatim (`e.CatchError(leave.Creation)`). */
  handlerExpression: string;
  file: string;
  line: number;
  /**
   * Last line of the whole registration, handler body included. A registration's inline closure IS the
   * handler — 897 lines of v1 leave logic live inside these spans — so without an end line the span cannot
   * become a reading obligation and those lines stay outside the denominator entirely.
   */
  endLine?: number;
  framework: RouteFramework;
}

export interface RouteRecovery {
  routes: RecoveredRoute[];
  /** Registrations found but not recovered — a non-literal path, or a prefix chain that does not resolve. */
  unrecovered: Array<{ file: string; line: number; reason: string; text: string }>;
  warnings: string[];
}

const GIN_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
const EXPRESS_METHODS = ["get", "post", "put", "delete", "patch", "head", "options", "all"];

/**
 * Recover one gin file's routes. `engineNames` are the identifiers that denote the root router (normally
 * `engine`/`r`/`router`), which the caller learns from the function signature rather than guessing.
 */
export function recoverGinRoutes(file: string, source: string, engineNames: string[] = ["engine", "r", "router"]): RouteRecovery {
  const recovery: RouteRecovery = { routes: [], unrecovered: [], warnings: [] };
  const api = loadAstGrep();
  if (!api) {
    recovery.warnings.push(`gin route recovery skipped for ${file}: no ast-grep binding`);
    return recovery;
  }
  let root: AstNode;
  try {
    root = api.parse("go", source).root();
  } catch (error) {
    recovery.warnings.push(`gin route recovery failed to parse ${file}: ${(error as Error).message}`);
    return recovery;
  }

  // Prefix chain: `name := parent.Group("/literal", ...middleware)`. Middleware arguments are ignored —
  // they change who may call the route, never what path it is.
  const prefixes = new Map<string, string>();
  for (const name of engineNames) prefixes.set(name, "");
  for (const pattern of [`$NAME := $PARENT.Group($PATH)`, `$NAME := $PARENT.Group($PATH, $$$MW)`]) {
    for (const match of findAll(root, pattern)) {
      const name = text(match, "NAME");
      const parent = text(match, "PARENT");
      const literal = stringLiteral(text(match, "PATH"));
      if (!name || !parent || literal === null) continue;
      const base = prefixes.get(parent);
      if (base === undefined) continue; // resolved below by repetition; an unresolved parent stays unknown
      prefixes.set(name, joinPath(base, literal));
    }
  }
  // A group may be declared after its parent in source order more than one level deep; repeat until the
  // chain stops growing rather than assuming declaration order.
  for (let pass = 0; pass < 4; pass++) {
    let grew = false;
    for (const pattern of [`$NAME := $PARENT.Group($PATH)`, `$NAME := $PARENT.Group($PATH, $$$MW)`]) {
      for (const match of findAll(root, pattern)) {
        const name = text(match, "NAME");
        const parent = text(match, "PARENT");
        const literal = stringLiteral(text(match, "PATH"));
        if (!name || !parent || literal === null || prefixes.has(name)) continue;
        const base = prefixes.get(parent);
        if (base === undefined) continue;
        prefixes.set(name, joinPath(base, literal));
        grew = true;
      }
    }
    if (!grew) break;
  }

  for (const method of [...GIN_METHODS, "Any"]) {
    for (const pattern of [`$RECV.${method}($PATH, $$$HANDLER)`]) {
      for (const match of findAll(root, pattern)) {
        const receiver = text(match, "RECV");
        const rawPath = text(match, "PATH");
        const literal = stringLiteral(rawPath);
        const line = lineOf(match);
        const handlerExpression = handlerArgument(nodeText(match), method);
        if (literal === null) {
          recovery.unrecovered.push({ file, line, reason: "path is not a string literal", text: nodeText(match).slice(0, 120) });
          continue;
        }
        const prefix = prefixes.get(receiver);
        if (prefix === undefined) {
          recovery.unrecovered.push({ file, line, reason: `router variable "${receiver}" has no resolved prefix`, text: nodeText(match).slice(0, 120) });
          continue;
        }
        recovery.routes.push({
          method: method === "Any" ? "ANY" : method,
          path: joinPath(prefix, literal) || "/",
          localPath: literal,
          handlerExpression,
          file,
          line,
          framework: "gin",
        });
      }
    }
  }
  sortRoutes(recovery.routes);
  return recovery;
}

/**
 * Recover one express router file's routes under a known mount prefix. The mount comes from the app's
 * `app.use('/leaves', leaveRouter)` line, which the caller resolves through the `require` that produced
 * `leaveRouter` — a single hop, and the only cross-file step this module needs.
 */
export function recoverExpressRoutes(file: string, source: string, mountPrefix: string): RouteRecovery {
  const recovery: RouteRecovery = { routes: [], unrecovered: [], warnings: [] };
  const api = loadAstGrep();
  if (!api) {
    recovery.warnings.push(`express route recovery skipped for ${file}: no ast-grep binding`);
    return recovery;
  }
  let root: AstNode;
  try {
    root = api.parse("JavaScript", source).root();
  } catch (error) {
    recovery.warnings.push(`express route recovery failed to parse ${file}: ${(error as Error).message}`);
    return recovery;
  }

  // `x.post(url, body)` is a route registration only when `x` IS a router. An HTTP client call reads
  // identically — measured: five `axios.post(responseUrl, …)` in one router file were being counted as
  // registrations. gin is protected by its prefix map; express needs the same discipline explicitly.
  const routers = expressRouterNames(root);
  for (const method of EXPRESS_METHODS) {
    for (const match of findAll(root, `$RECV.${method}($PATH, $$$HANDLER)`)) {
      if (!routers.has(text(match, "RECV"))) continue;
      const rawPath = text(match, "PATH");
      const literal = stringLiteral(rawPath);
      const line = lineOf(match);
      const endLine = endLineOf(match);
      if (literal === null) {
        recovery.unrecovered.push({ file, line, reason: "path is not a string literal", text: nodeText(match).slice(0, 120) });
        continue;
      }
      recovery.routes.push({
        method: method === "all" ? "ANY" : method.toUpperCase(),
        path: joinPath(mountPrefix, literal) || "/",
        localPath: literal,
        handlerExpression: handlerArgument(nodeText(match), method),
        file,
        line,
        endLine,
        framework: "express",
      });
    }
  }
  sortRoutes(recovery.routes);
  return recovery;
}


/** Identifiers bound to an express router or app in this file — the only valid registration receivers. */
function expressRouterNames(root: AstNode): Set<string> {
  const names = new Set<string>();
  for (const pattern of ["const $NAME = express.Router()", "const $NAME = express()", "const $NAME = Router()",
                         "let $NAME = express.Router()", "var $NAME = express.Router()"]) {
    for (const match of findAll(root, pattern)) {
      const name = text(match, "NAME");
      if (name) names.add(name);
    }
  }
  // A router file may receive its router rather than create it; `router` and `app` are the conventional
  // names and are accepted only when nothing else was found, so a file that names its router explicitly
  // never has an unrelated `app` variable treated as one.
  if (!names.size) { names.add("router"); names.add("app"); }
  return names;
}

/** `app.use('/leaves', leaveRouter)` — the mount points a router file inherits its prefix from. */
export function expressMounts(source: string): Array<{ prefix: string; identifier: string; line: number }> {
  const api = loadAstGrep();
  if (!api) return [];
  let root: AstNode;
  try {
    root = api.parse("JavaScript", source).root();
  } catch {
    return [];
  }
  const mounts: Array<{ prefix: string; identifier: string; line: number }> = [];
  for (const match of findAll(root, `$APP.use($PATH, $ROUTER)`)) {
    const literal = stringLiteral(text(match, "PATH"));
    const identifier = text(match, "ROUTER");
    if (literal === null || !identifier) continue;
    // `express.static(...)` and other inline middleware are mounts of behaviour, not of a route file.
    if (identifier.includes("(")) continue;
    mounts.push({ prefix: literal, identifier, line: lineOf(match) });
  }
  return mounts.sort((a, b) => a.line - b.line);
}

/** Join two path fragments the way a router does: exactly one slash, no trailing slash except root. */
export function joinPath(prefix: string, suffix: string): string {
  const left = prefix.replace(/\/+$/, "");
  const right = suffix.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!right) return left;
  return `${left}/${right}`;
}

/** The literal inside a quoted string, or null when the argument is anything else (a variable, a call). */
function stringLiteral(raw: string | null): string | null {
  if (!raw) return null;
  const quoted = /^(["'`])([^"'`]*)\1$/.exec(raw.trim());
  return quoted ? quoted[2] : null;
}

/** The handler argument as written — everything after the path argument, trimmed to the closing paren. */
function handlerArgument(callText: string, method: string): string {
  const open = callText.indexOf(`${method}(`);
  if (open < 0) return "";
  const inner = callText.slice(open + method.length + 1, callText.lastIndexOf(")"));
  const comma = inner.indexOf(",");
  return comma < 0 ? "" : inner.slice(comma + 1).trim();
}

function findAll(root: AstNode, pattern: string): AstMatchLike[] {
  try {
    return root.findAll(pattern) as unknown as AstMatchLike[];
  } catch {
    return [];
  }
}

interface AstMatchLike {
  getMatch(name: string): { text(): string } | null;
  range(): { start: { line: number }; end: { line: number } };
  text(): string;
}

function text(match: AstMatchLike, name: string): string {
  return match.getMatch(name)?.text()?.trim() ?? "";
}

function nodeText(match: AstMatchLike): string {
  return match.text();
}

function lineOf(match: AstMatchLike): number {
  return match.range().start.line + 1;
}

/** Last line of the match, so a registration with an inline handler carries the handler's whole span. */
function endLineOf(match: AstMatchLike): number {
  return match.range().end.line + 1;
}

function sortRoutes(routes: RecoveredRoute[]): void {
  routes.sort((a, b) => cmp(a.path, b.path) || cmp(a.method, b.method) || cmp(a.file, b.file) || a.line - b.line);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
