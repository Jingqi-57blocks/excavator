// FRONTEND CALLS — where the browser actually asks a backend for something, and for which path.
//
// Measured on the real target before designing this: of 412 HTTP call sites in the frontend, **zero** pass
// a plain string literal. Every one is a template beginning with a base variable —
// `httpClient.get(`${appRunnerApi}/v2/support/emps`)`. A literal-URL matcher scores 0 here, so template
// awareness is the price of entry rather than a refinement.
//
// THE TRAP THAT DRIVES THIS MODULE'S SHAPE: the base identifier is FILE-LOCAL and the same name means
// different things in different files. Measured forms, all present in the target:
//   1. `const { appRunnerApi, mainApi } = config`            — plain destructure
//   2. `const { clientMainApi: mainApi } = config`           — RENAMED: this file's `mainApi` is clientMainApi
//   3. `const mainApi = config.performanceReviewMainApi`     — alias: same name, different key
//   4. `const mainApiV2 = `${config.performanceReviewMainApi}/v2`` — derived, carries a path segment
// Attributing bases by identifier name globally misplaces or drops **≥70 call sites (17%)**. So binding is
// resolved per file, and a call whose base cannot be resolved is reported unresolved — never guessed.
//
// The client itself is recognised structurally, not by name: an `axios.create()` export, or a class that
// wraps fetch and exposes the HTTP verbs. Hard-coding `httpClient`/`authRequest` would tie the engine to
// one codebase's vocabulary, which the vertical-neutrality guardrail forbids.

import { loadAstGrep, type AstNode } from "../assurance/condition-extract.ts";

export const FRONTEND_CALLS_VERSION = "frontend-calls-v1";

const HTTP_METHODS = ["get", "post", "put", "delete", "patch", "head"];

export interface FrontendCall {
  path: string;
  line: number;
  /** Method as written on the client (`get`), uppercased for matching. */
  method: string;
  /** The base identifier this call's URL starts with, before resolution (`appRunnerApi`). */
  baseIdentifier: string | null;
  /** The config key that identifier resolves to in THIS file (`performanceReviewMainApi`). */
  baseKey: string | null;
  /** Path after the base, with template holes normalised to `:param` (`/v2/leaves/:p1`). */
  routePath: string | null;
  /** The call's first argument verbatim, so a reader can see what was parsed. */
  expression: string;
  /** Why a call could not be turned into a route path — kept so degradation is countable. */
  unresolvedReason?: "no-base" | "unknown-base" | "not-a-template" | "dynamic";
}

export interface BaseBinding {
  identifier: string;
  configKey: string;
  /** A derived base carries a path segment of its own (`${config.x}/v2` → suffix `/v2`). */
  suffix: string;
  form: "destructure" | "renamed" | "alias" | "derived";
}

/**
 * Resolve the file's base bindings. Order matters only in that later declarations of the same identifier
 * win, matching JavaScript scoping closely enough for module-level constants.
 */
export function resolveBaseBindings(source: string): BaseBinding[] {
  const api = loadAstGrep();
  if (!api) return [];
  let root: AstNode;
  try {
    root = api.parse("TypeScript", source).root();
  } catch {
    return [];
  }
  const bindings = new Map<string, BaseBinding>();

  // Forms 3 and 4: `const x = config.key` and `const x = `${config.key}/v2``.
  for (const match of findAll(root, "const $NAME = config.$KEY")) {
    const identifier = text(match, "NAME");
    const configKey = text(match, "KEY");
    if (identifier && configKey) bindings.set(identifier, { identifier, configKey, suffix: "", form: identifier === configKey ? "destructure" : "alias" });
  }
  for (const match of findAll(root, "const $NAME = $TEMPLATE")) {
    const identifier = text(match, "NAME");
    const template = text(match, "TEMPLATE");
    const derived = /^`\$\{\s*config\.([A-Za-z0-9_$]+)\s*\}([^`$]*)`$/.exec(template);
    if (identifier && derived) bindings.set(identifier, { identifier, configKey: derived[1], suffix: derived[2], form: "derived" });
  }

  // Forms 1 and 2: `const { a, b: c } = config`. ast-grep patterns do not decompose an object pattern's
  // elements, so the destructuring list is read from the matched text — the one place a small parse of
  // the matched span is simpler and safer than a pattern per arity.
  for (const match of findAll(root, "const $PATTERN = config")) {
    const pattern = text(match, "PATTERN");
    if (!pattern.startsWith("{")) continue;
    for (const entry of pattern.replace(/^\{|\}$/g, "").split(",")) {
      const parts = entry.split(":").map((part) => part.trim()).filter(Boolean);
      if (!parts.length) continue;
      if (parts.length === 1) {
        if (/^[A-Za-z0-9_$]+$/.test(parts[0])) bindings.set(parts[0], { identifier: parts[0], configKey: parts[0], suffix: "", form: "destructure" });
      } else if (/^[A-Za-z0-9_$]+$/.test(parts[1])) {
        // `{ clientMainApi: mainApi }` — the LOCAL name is the second half, the config key the first.
        bindings.set(parts[1], { identifier: parts[1], configKey: parts[0], suffix: "", form: "renamed" });
      }
    }
  }

  return [...bindings.values()].sort((a, b) => cmp(a.identifier, b.identifier));
}

/** Extract every HTTP call made through one of `clientNames` in this file. */
export function extractFrontendCalls(path: string, source: string, clientNames: string[]): FrontendCall[] {
  const api = loadAstGrep();
  if (!api) return [];
  let root: AstNode;
  try {
    root = api.parse(path.endsWith(".tsx") ? "Tsx" : "TypeScript", source).root();
  } catch {
    return [];
  }
  const bindings = new Map(resolveBaseBindings(source).map((binding) => [binding.identifier, binding]));
  const calls: FrontendCall[] = [];

  for (const client of clientNames) {
    for (const method of HTTP_METHODS) {
      for (const pattern of [`${client}.${method}($URL, $$$REST)`, `${client}.${method}($URL)`]) {
        for (const match of findAll(root, pattern)) {
          const raw = text(match, "URL");
          if (!raw) continue;
          calls.push(classify(path, raw, method.toUpperCase(), lineOf(match), bindings));
        }
      }
    }
  }

  // A call site can match both the with-rest and without-rest pattern; key on the exact triple.
  const seen = new Set<string>();
  const unique = calls.filter((call) => {
    const key = `${call.line}:${call.method}:${call.expression}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => a.line - b.line || cmp(a.method, b.method) || cmp(a.expression, b.expression));
  return unique;
}

function classify(path: string, raw: string, method: string, line: number, bindings: Map<string, BaseBinding>): FrontendCall {
  const call: FrontendCall = { path, line, method, baseIdentifier: null, baseKey: null, routePath: null, expression: raw };
  // Two head forms, both measured in the target: a locally bound identifier (`${appRunnerApi}/…`) and the
  // config member inlined with no binding at all (`${config.appRunnerApi}/…`). The second was 15 of the
  // first 191 call sites — reading it as "no base" would have discarded real, fully static routes.
  const template = /^`\$\{\s*([A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$]+)?)\s*\}([\s\S]*)`$/.exec(raw.trim());
  if (!template) {
    call.unresolvedReason = raw.trim().startsWith("`") ? "no-base" : "not-a-template";
    return call;
  }
  const head = template[1];
  call.baseIdentifier = head;
  let suffix = "";
  if (head.startsWith("config.")) {
    call.baseKey = head.slice("config.".length);
  } else {
    const binding = bindings.get(head);
    if (!binding) {
      call.unresolvedReason = "unknown-base";
      return call;
    }
    call.baseKey = binding.configKey;
    suffix = binding.suffix;
  }
  const rest = `${suffix}${template[2]}`;
  const normalised = normaliseTemplatePath(rest);
  if (normalised === null) {
    call.unresolvedReason = "dynamic";
    return call;
  }
  call.routePath = normalised;
  return call;
}

/**
 * Turn the path after the base into a matchable shape: template holes become positional `:pN` parameters,
 * and a query string is dropped (it never participates in route matching). A hole INSIDE a segment
 * (`/leave-${type}s`) cannot be matched positionally and is reported dynamic rather than approximated.
 */
export function normaliseTemplatePath(rest: string): string | null {
  const withoutQuery = rest.split("?")[0];
  const segments = withoutQuery.split("/");
  const out: string[] = [];
  let index = 0;
  for (const segment of segments) {
    if (!segment.includes("${")) { out.push(segment); continue; }
    if (!/^\$\{[^}]*\}$/.test(segment)) return null;
    index += 1;
    out.push(`:p${index}`);
  }
  const joined = out.join("/");
  return joined.replace(/\/+$/, "") || "/";
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
  range(): { start: { line: number } };
}

function text(match: AstMatchLike, name: string): string {
  return match.getMatch(name)?.text()?.trim() ?? "";
}

function lineOf(match: AstMatchLike): number {
  return match.range().start.line + 1;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
