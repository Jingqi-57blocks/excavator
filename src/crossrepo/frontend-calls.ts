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
  /**
   * Why a call could not be turned into a route path — kept so degradation is countable.
   *
   * `unparsed-shape` is the completeness tripwire, not a parse outcome: the call site exists, the structural
   * matcher did not produce it, and it is reported rather than dropped. See `unmatchedCallSites`.
   */
  unresolvedReason?: "no-base" | "unknown-base" | "not-a-template" | "dynamic" | "unparsed-shape";
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
export function extractFrontendCalls(path: string, source: string, clientNames: string[], warnings?: string[]): FrontendCall[] {
  const api = loadAstGrep();
  if (!api) {
    // Without a warning this returns "this file makes no HTTP calls", which is indistinguishable from
    // "this scanner is blind" — the failure mode this whole line of work exists to remove.
    warnings?.push(`frontend call extraction skipped for ${path}: no ast-grep binding`);
    return [];
  }
  let root: AstNode;
  try {
    root = api.parse(path.endsWith(".tsx") ? "Tsx" : "TypeScript", source).root();
  } catch (error) {
    // Same reasoning as the missing-binding branch above: an empty result here would read as "this file
    // makes no HTTP calls", which is the silent form of the loss this module is built to make visible.
    warnings?.push(`frontend call extraction failed to parse ${path}: ${(error as Error).message}`);
    return [];
  }
  const bindings = new Map(resolveBaseBindings(source).map((binding) => [binding.identifier, binding]));
  const calls: FrontendCall[] = [];

  // Every call expression, then a structural test on its callee — NOT a list of textual call shapes.
  //
  // This module used to enumerate patterns (`client.post($URL)`, `client.post($URL, $$$REST)`). That is a
  // losing game and it lost measurably: a call with type arguments is a different AST shape, so
  // `httpClient.post<App.ResponseBase<T>>(url)` matched nothing — and on the real target the calls that
  // vanished were `approve` and `reject`, the two most important in the feature under investigation, with
  // no warning, no `unresolved` entry, nothing. Adding a type-argument pattern then revealed the next hole
  // (`await client.get<T>(url)` matched neither), which is the shape of a game with no end.
  //
  // Walking `call_expression` and asking "is the callee <a client>.<an http verb>" is invariant to all of
  // it: await, type arguments, parentheses, whatever wraps the call next year.
  const clients = new Set(clientNames);
  for (const node of findAllKind(root, "call_expression")) {
    const verb = calleeVerb(node.field?.("function")?.text()?.trim() ?? "", clients);
    if (!verb) continue;
    const raw = firstArgument(node);
    if (!raw) continue;
    calls.push(classify(path, raw, verb.toUpperCase(), lineOf(node), bindings));
  }
  // Whatever the structural matcher did not produce is reported, never dropped. Without this, a call shape
  // nobody anticipated has a FOURTH outcome besides resolved/ambiguous/unresolved: non-existence.
  calls.push(...unmatchedCallSites(path, source, clientNames, calls));

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

/**
 * Client call sites the structural patterns did not produce.
 *
 * Deliberately TEXTUAL. Its whole job is to disagree with the AST matcher, so deriving it from that matcher
 * would make disagreement impossible — the check would confirm the matcher instead of auditing it. A shape
 * nobody anticipated (today: type arguments; tomorrow: something else) then surfaces as a visible
 * `unparsed-shape` entry with its line, instead of not existing.
 *
 * It is allowed to be slightly over-eager. A false entry costs one visible line saying "look here"; a false
 * absence costs a route nobody knows is missing, which is exactly the failure this repairs.
 */
function unmatchedCallSites(path: string, source: string, clientNames: string[], produced: FrontendCall[]): FrontendCall[] {
  if (!clientNames.length) return [];
  // Counted, not set-membership: `httpClient.get(a); httpClient['get'](b);` on one line is TWO call sites,
  // and keying on line+method alone would let the structural hit for the first silence the report of the
  // second. The tripwire reports the surplus it sees over what the structural read produced.
  const structural = new Map<string, number>();
  for (const call of produced) structural.set(`${call.line}:${call.method}`, (structural.get(`${call.line}:${call.method}`) ?? 0) + 1);

  const clients = clientNames.map(escapeForRegExp).join("|");
  const verbs = HTTP_METHODS.join("|");
  // NO ADJACENCY between the client and the verb. Requiring the identifier to be immediately followed by
  // `.` or `[` is the very assumption the structural read makes, so sharing it made both nets blind to the
  // same family — measured: `client?.post(…)`, `client!.post(…)`, `(client).post(…)`,
  // `(client as X).post(…)`, `client.post.call(…)` produced nothing anywhere, with no warning. Textual
  // independence from the AST is not independence from a shared premise.
  //
  // So: the client identifier appears, and an HTTP verb is accessed somewhere after it on the same line. The
  // trailing `(` is not required either — `(0, client.post)(url)` never puts one after the verb. `\b` after
  // the verb keeps `.getBaseUrl()` from reading as `get`.
  const finder = new RegExp(`\\b(?:${clients})\\b[^;]*?(?:\\.\\s*(${verbs})\\b|\\[\\s*['"\`](${verbs})['"\`]\\s*\\])`, "g");
  const out: FrontendCall[] = [];
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    finder.lastIndex = 0;
    const textual = new Map<string, number>();
    let match: RegExpExecArray | null;
    while ((match = finder.exec(line)) !== null) {
      const method = (match[1] ?? match[2]).toUpperCase();
      textual.set(method, (textual.get(method) ?? 0) + 1);
    }
    for (const [method, count] of textual) {
      const surplus = count - (structural.get(`${index + 1}:${method}`) ?? 0);
      for (let extra = 0; extra < surplus; extra += 1) {
        out.push({ path, line: index + 1, method, baseIdentifier: null, baseKey: null, routePath: null, expression: trimmed.slice(0, 200), unresolvedReason: "unparsed-shape" });
      }
    }
  }
  return out;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The HTTP verb the callee ends on, through an optional or non-null access as readily as a plain one. */
const CALLEE_VERB = new RegExp(`[?!]?\\s*\\.\\s*(${HTTP_METHODS.join("|")})\\s*$`);

/**
 * Read a callee as `<receiver>.<verb>` and say whether the receiver is one of this scan's clients.
 *
 * The receiver is UNWRAPPED rather than matched: `httpClient`, `httpClient!`, `(httpClient)` and
 * `(httpClient as HttpClient)` are the same object, and a matcher that only accepts the bare identifier
 * reports the other three as unparsed — or, before the tripwire stopped sharing its adjacency assumption,
 * did not report them at all. Wrappers that change WHICH object is called (a comma expression, `.call`) are
 * deliberately NOT unwrapped: those are not this client's call and must not be resolved as one.
 */
function calleeVerb(calleeText: string, clients: Set<string>): string | null {
  const tail = CALLEE_VERB.exec(calleeText);
  if (!tail) return null;
  let receiver = calleeText.slice(0, tail.index).trim();
  // Peel one layer at a time until stable: non-null assertions, type assertions, redundant parentheses.
  for (let guard = 0; guard < 8; guard += 1) {
    const before = receiver;
    receiver = receiver.replace(/!+$/, "").trim();
    receiver = receiver.replace(/\s+(?:as|satisfies)\s+[A-Za-z0-9_$.<>\[\]|&\s]+$/, "").trim();
    if (receiver.startsWith("(") && receiver.endsWith(")")) receiver = receiver.slice(1, -1).trim();
    if (receiver === before) break;
  }
  const identifier = /([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(receiver);
  return identifier && clients.has(identifier[1]) ? tail[1] : null;
}

/** The call's first argument, read from the argument list rather than a pattern capture. */
function firstArgument(node: AstMatchLike): string {
  const args = node.field?.("arguments");
  if (!args) return "";
  const children = (args.children?.() ?? []).filter((child: AstChildLike) => !["(", ")", ","].includes(child.kind?.() ?? ""));
  return children[0]?.text()?.trim() ?? "";
}

function findAllKind(root: AstNode, kind: string): AstMatchLike[] {
  try {
    return root.findAll({ rule: { kind } } as never) as unknown as AstMatchLike[];
  } catch {
    return [];
  }
}

function findAll(root: AstNode, pattern: string): AstMatchLike[] {
  try {
    return root.findAll(pattern) as unknown as AstMatchLike[];
  } catch {
    return [];
  }
}

/** The slice of ast-grep's node surface this module uses; `field`/`children` are how a call is read structurally. */
interface AstMatchLike {
  getMatch(name: string): { text(): string } | null;
  range(): { start: { line: number } };
  field?(name: string): AstChildLike | null;
}

interface AstChildLike {
  text(): string;
  kind?(): string;
  children?(): AstChildLike[];
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
