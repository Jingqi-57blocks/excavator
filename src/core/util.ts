import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, stat, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  const normalize = (input: unknown, ancestors: object[] = []): unknown => {
    if (input === null || typeof input !== "object") return input;
    if (ancestors.includes(input as object)) throw new TypeError("circular value");
    const nextAncestors = [...ancestors, input as object];
    if (Array.isArray(input)) return input.map((item) => normalize(item, nextAncestors));
    return Object.fromEntries(Object.entries(input as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => [key, normalize(val, nextAncestors)]));
  };
  return JSON.stringify(normalize(value), null, 2);
}


export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function atomicWrite(path: string, content: string | Buffer): Promise<void> {
  await ensureDir(dirname(path));
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, content);
  await rename(temp, path);
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${stableJson(value)}\n`);
}

export function safeRelative(root: string, candidate: string): string {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))) return rel || ".";
  throw new Error(`Path escapes target root: ${candidate}`);
}

export function nowIso(): string { return new Date().toISOString(); }

/**
 * Run-id timestamp in LOCAL time, `YYYY_MM_DD_HH_MM`. Minute resolution is intentional: the run-id
 * appends a random UUID segment, so the timestamp is a human-readable ordinal, not the uniqueness
 * guarantee. Distinct from `nowIso()`, which stays UTC ISO-8601 for machine `createdAt` fields.
 */
export function runIdTimestamp(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate()), pad(date.getHours()), pad(date.getMinutes())].join("_");
}

export class Deadline {
  readonly startedAt = Date.now();
  readonly limitMs: number;
  readonly label: string;
  constructor(limitMs: number, label: string) { this.limitMs = limitMs; this.label = label; }
  check(context = ""): void {
    if (Date.now() - this.startedAt > this.limitMs) {
      const suffix = context ? ` while ${context}` : "";
      const error = new Error(`${this.label} exceeded ${this.limitMs}ms${suffix}`);
      error.name = "ExcavatorTimeoutError";
      throw error;
    }
  }
  elapsed(): number { return Date.now() - this.startedAt; }
}

export async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

export async function listDirectories(path: string): Promise<string[]> {
  return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
}

export function slugify(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "") || "item";
}

/**
 * Resolve the per-target directory that holds one project's runs and caches.
 *
 * The directory is named after the target's basename so a workspace stays readable
 * and one project's state can be removed in a single step. A `.target` marker records
 * the absolute target path; when a different target would claim the same name, the
 * slug is suffixed with a digest of its path instead of colliding.
 */
export async function projectWorkspace(workdir: string, target: string): Promise<string> {
  const absoluteTarget = resolve(target);
  const root = resolve(workdir);
  const base = slugify(basename(absoluteTarget));
  const preferred = join(root, base);
  const owner = await readTargetMarker(preferred);
  if (owner === null || owner === absoluteTarget) return claimWorkspace(preferred, absoluteTarget, owner);
  return claimWorkspace(join(root, `${base}-${sha256(absoluteTarget).slice(0, 6)}`), absoluteTarget, null);
}

async function claimWorkspace(path: string, absoluteTarget: string, owner: string | null): Promise<string> {
  await ensureDir(path);
  if (owner === null && await readTargetMarker(path) === null) await atomicWrite(join(path, ".target"), `${absoluteTarget}\n`);
  return path;
}

async function readTargetMarker(path: string): Promise<string | null> {
  try { return (await readFile(join(path, ".target"), "utf8")).trim(); } catch { return null; }
}

/**
 * Version of the redaction algorithm below. Downstream cache keys (source windows, searches) and
 * the assurance version embed this marker so a change to redaction invalidates stale caches and
 * flags runs prepared under an older redaction. Bump it whenever `redactSecrets` behavior changes.
 */
export const REDACTION_VERSION = "redaction-v7";

const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_.-]*/g;
const STRING_LITERAL_PATTERN = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
const TEMPLATE_LITERAL_PATTERN = /`(?:[^`\\]|\\.)*`/g;
const QUOTED_VALUE_PATTERN = /^"((?:[^"\\]|\\.)*)"$|^'((?:[^'\\]|\\.)*)'$/;
const MEMBER_EXPRESSION_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;
/** A plain shell variable read — `$NAME`, `"$NAME"`, `${NAME}` — as opposed to `$(cmd)` or `$1`. */
const SHELL_VARIABLE_READ = /^"?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?"?$/;

/**
 * Whether the accumulation target reads as CODE rather than as a configuration slot.
 *
 * The exemption is granted to the target being camelCase or dotted-member — `holiday.PtoToken`, `leftToken`
 * — because that is what the business arithmetic looks like. Everything else, including `SECRET`, `A` and
 * `MY_secret`, keeps the redaction: probing this rule found `MY_secret += changeme` and `A += changeme`
 * leaking when it was written the other way round (as "all-caps means config"), which is the same
 * grant-by-shape mistake in miniature — a shape test says what a name LOOKS like, and only the complement
 * is safe to trust.
 */
const CODE_CASED_TARGET = /(?:^|[^A-Za-z0-9_$])[a-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+\s*$|(?:^|[^A-Za-z0-9_$])[a-z_$][a-z0-9_$]*[A-Z][A-Za-z0-9_$]*\s*$/;
/** An identifier with no digit — a name in the code, not key material (`hours`, `nil`, `consumption`). */
const BARE_REFERENCE_PATTERN = /^[A-Za-z_$][A-Za-z_$]*$/;
/** `fn(...)`, `a.b.fn(...)`, `await fn(...)`, `new Thing(...)` — a call, not a credential. */
const CALL_EXPRESSION_PATTERN = /^(?:await\s+|new\s+)?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\(/;

export function redactSecrets(text: string): string {
  const lines = text.split(/\r?\n/);
  return lines.map((line) => redactSecretLine(line)).join("\n");
}

function redactSecretLine(line: string): string {
  const sensitive = (identifier: string): boolean => isSensitiveIdentifier(identifier);
  // EVERY operator on the line, left to right — the first one does not own it. `A=1 && PASSWORD=changeme`,
  // `DEBUG=1 ADMIN_PASSWORD=changeme ./run.sh` and `[ "$PASSWORD" == old ] && PASSWORD=news3cr3t99` all put
  // the credential after something else, and judging only the first operator left every one of them intact.
  // Iterative rather than recursive: a line of 5000 chained comparisons overflowed the stack, and this
  // function sits on the evidence-recording path where a crafted file must not be able to stop a run.
  //
  // The cursor is an OFFSET, not a re-sliced remainder. Re-slicing made each step rescan the whole tail —
  // O(n²) — which forced a 64-step cap, and a cap on a security scan is a documented bypass: 70 `a=1 &&`
  // segments before `PASSWORD=changeme` walked straight through it. Scanning from the offset is linear in
  // the line, so the cap is gone rather than raised, and no crafted prefix length reaches an unjudged tail.
  let cursor = 0;
  const quoted = stringLiteralSpans(line);
  while (cursor < line.length) {
    const operator = classifyOperator(line, cursor);
    if (!operator) break;
    // An operator INSIDE a quoted string binds nothing: `Where("token = ?", token)` is a SQL fragment and
    // `<input name="password" type="password">` is markup, and reading either as an assignment redacted a
    // query and a form. Secrets written inside strings are not lost by skipping — `redactSensitiveStringLiterals`
    // judges every literal on a line that mentions a sensitive name, which is the path that already covers
    // `const c = "PASSWORD=changeme"`.
    const span = quoted.find((entry) => operator.index >= entry.start && operator.index < entry.end);
    if (span) { cursor = span.end; continue; }
    const upTo = line.slice(cursor, operator.index + operator.length);
    const value = line.slice(operator.index + operator.length);
    // The TARGET of the operator, not any word earlier in the segment. Scanning the whole prefix was
    // measured redacting `where year = ?` inside a SQL template, only because `${type}_token` appeared
    // earlier in the same string — and it is the same rule that made `err != nil` sensitive because
    // `FuneralToken` sat earlier on the line. What a name says about secrecy, it says about the thing it
    // names.
    const targets = operatorTargets(line, cursor, operator.index, quoted);
    // `test $PASSWORD == changeme` is the same context as `[ "$PASSWORD" == changeme ]`, which the value
    // rules already treat as literal-bearing — but that one is recognised by its closing `]`, so the
    // bracket-less spelling kept the comparison's bare-word exemption and leaked. Command position only:
    // `if (test === changeme)` in JavaScript is not a shell test.
    const shellTestCommand = /(?:^|[;&|])\s*(?:test|\[\[?)\s/.test(line.slice(0, operator.index));
    // A comparison spares a bare word because `if apiToken == other` compares two pieces of CODE. Spending
    // it on a config-cased name instead let `PASSWORD==changeme` through.
    //
    // The test is applied to the SENSITIVE name, not to whichever identifier sits closest to the operator:
    // in `if holiday.FuneralToken > 0 && err != nil` the neighbour is `err` and the sensitive name is the
    // dotted business field, and testing the neighbour redacted `nil`.
    const sensitiveTargets = targets.filter((target) => sensitive(target));
    const comparesCode = operator.kind === "compare" && sensitiveTargets.some((target) => CODE_CASED_TARGET.test(target));
    const bareAllowed = (operator.arithmetic || comparesCode) && !shellTestCommand;
    if (sensitiveTargets.length > 0 && shouldRedactValue(value, bareAllowed, operator.bound)) {
      return `${line.slice(0, cursor)}${upTo}${value.match(/^\s*/)?.[0] ?? " "}<redacted>${trailingPunctuation(value)}`;
    }
    // A bound pattern is ONE token. Stepping into it made the `=` inside `s/password=\w+/password=***/`
    // read as an assignment whose target is `password`, redacting a sanitizing substitution — a line a
    // security report exists to quote, and one main leaves readable. Judged as a whole above, skipped whole
    // here; anything after the closing delimiter is still judged, so `=~ /x/ && PASSWORD=changeme` is caught.
    cursor = operator.bound ? patternEnd(line, operator.index + operator.length) : operator.index + operator.length;
  }
  const mapped = redactMapping(line, cursor);
  if (mapped !== null) return mapped;
  return redactSensitiveStringLiterals(line);
}

/**
 * The `[start, end)` spans of every quoted literal on the line, left to right and non-overlapping.
 *
 * Template literals count. A URL built as `` `…/ws/?token=${token}&action=getCartV2` `` was measured losing
 * its action name, because judging the `=` inside it put `token` two identifiers away from `action` — and
 * those URLs are the cross-repo call sites the engine exists to recover. What a template literal may still
 * carry is a written-out credential, so the fallback judges it as a whole; see `redactSensitiveStringLiterals`.
 */
function stringLiteralSpans(line: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const pattern = new RegExp(`${STRING_LITERAL_PATTERN.source}|${TEMPLATE_LITERAL_PATTERN.source}`, "g");
  for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

/** Delimiters that close with a different character than they open with. */
const PATTERN_CLOSERS: Record<string, string> = { "{": "}", "(": ")", "[": "]", "<": ">" };

/**
 * The index just past a delimited pattern at `from`, or `from` when there is no well-formed one.
 *
 * `s`, `tr` and `y` take two parts (pattern and replacement); `m`, `qr` and the bare `/…/` take one.
 * An unterminated delimiter returns `from`, which resumes ordinary judging — the conservative direction,
 * since a skip that overshoots would step past a real assignment.
 */
function patternEnd(line: string, from: number): number {
  const head = /^\s*(?:(s|tr|y)|m|qr)?([/{|#,])/.exec(line.slice(from));
  if (!head) return from;
  const close = PATTERN_CLOSERS[head[2]] ?? head[2];
  let remaining = head[1] ? 2 : 1;
  let index = from + head[0].length;
  while (remaining > 0 && index < line.length) {
    if (line[index] === "\\") index += 2;
    else if (line[index] === close) { remaining -= 1; index += 1; }
    else index += 1;
  }
  return remaining === 0 ? index : from;
}

/**
 * The identifiers an operator applies to: the last two before it.
 *
 * Two, not one, because a declaration puts the type between the name and the operator — `AESKey string =`
 * — and one alone would read `string` as the target. Two, not all, because scanning the whole prefix reaches
 * words that name nothing here: it redacted `where year = ?` inside a SQL template only because
 * `${type}_token` appeared earlier in the same string.
 *
 * The second one is dropped when it sits INSIDE a quoted literal, because a declaration's type never does:
 * in `<input id="password" name="…">` the word before `name` is the previous attribute's VALUE, and taking
 * it redacted the form field. The adjacent target is kept either way, so a quoted key — TOML's
 * `"password" = "changeme"` — still names what it assigns.
 */
function operatorTargets(line: string, from: number, end: number, quoted: Array<{ start: number; end: number }>): string[] {
  const pattern = new RegExp(IDENTIFIER_PATTERN.source, "g");
  pattern.lastIndex = from;
  const found: Array<{ text: string; start: number }> = [];
  for (let match = pattern.exec(line); match !== null && match.index < end; match = pattern.exec(line)) {
    found.push({ text: match[0], start: match.index });
  }
  const last = found[found.length - 1];
  if (!last) return [];
  const second = found[found.length - 2];
  const insideLiteral = second !== undefined && quoted.some((span) => second.start >= span.start && second.start < span.end);
  return second && !insideLiteral ? [second.text, last.text] : [last.text];
}

/**
 * Drop trailing `)` that this value never opened — they close the expression AROUND it.
 *
 * `password.value === confirm.value)` sits inside a `computed(…)`, and carrying the caller's paren made the
 * operand stop reading as a member expression, redacting a Vue comparison. Counted rather than trimmed by
 * whitespace, because `!= abc]` taught that a closer cannot be told from a value by position alone —
 * a paren the value did not open is unambiguous, and stripping it can only shorten a bare word that stays
 * redacted anyway.
 */
function dropUnopenedParens(value: string): string {
  let text = value;
  while (text.endsWith(")") && (text.match(/\)/g) ?? []).length > (text.match(/\(/g) ?? []).length) {
    text = text.slice(0, -1);
  }
  return text;
}

/** The `key: value` shape, or null. Split out so the operator loop above stays one job. */
function redactMapping(line: string, _offset: number): string | null {
  // Not Go's `:=`, where the colon belongs to the assignment operator: matching it there cut the line at the
  // colon and emitted `apiToken :<redacted>`, losing the `=`.
  if (/^\s*["']?[A-Za-z_][A-Za-z0-9_.-]*["']?\s*:=/.test(line)) return null;
  const mapping = line.match(/^(\s*["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*:\s*)(.*)$/);
  if (mapping && isSensitiveIdentifier(mapping[2]) && shouldRedactValue(mapping[3])) {
    return `${mapping[1]}<redacted>${trailingPunctuation(mapping[3])}`;
  }
  return null;
}

/**
 * Classify the operator a line joins on: an assignment, a comparison, or neither.
 *
 * `indexOf("=")` was measured destroying evidence rather than protecting it: it treats `==`, `!=`, `>=` and
 * `=>` as assignments, so where `*Token` names an ordinary business quantity `err != nil` became
 * `err != <redacted>`, and `if x == "…"` was split through its own second character.
 *
 * Both sides are kept because both can carry a credential, and each was measured leaking when dropped:
 * removing compound assignments let `API_TOKEN := sk-live-abc123` through, and removing comparisons let
 * `if [ $PASSWORD != s3cr3tpass99 ]` through. What differs between them is only how much of the operand may
 * be spared — see `bareReferenceAllowed`.
 */
type LineOperator = { index: number; length: number; kind: "assign" | "compare"; arithmetic: boolean; bound?: boolean };

function classifyOperator(line: string, from = 0): LineOperator | null {
  for (let index = from; index < line.length; index += 1) {
    // `!~` is `=~` negated — `unless ($p =~ /x/)` and `if ($p !~ /x/)` check the same literal.
    if (line[index] === "~" && index > from && line[index - 1] === "!") return { index: index - 1, length: 2, kind: "compare", arithmetic: false, bound: true };
    if (line[index] !== "=") continue;
    // Lookbehind stops at `from`: the caller has already consumed everything before it, so a character
    // there is the tail of the previous operator, not context for this one.
    const before = index > from ? line[index - 1] : "";
    const after = line[index + 1] ?? "";
    // `=>` is an arrow: neither side of this split.
    if (after === ">") continue;
    // `=~` binds a pattern. Skipping it entirely was measured leaking `$password =~ /^changeme$/` — a
    // prefix check against a literal password — so it is judged like a comparison and the pattern is the
    // operand. `shouldRedactValue` decides whether that pattern is a word or a real expression.
    if (after === "~") return { index, length: 2, kind: "compare", arithmetic: false, bound: true };
    // `==`, `===`, `!==` — the comparison starts at the FIRST `=`, or one character earlier for `!==`.
    if (after === "=") {
      const start = before === "!" ? index - 1 : index;
      const length = line[index + 2] === "=" ? index + 3 - start : index + 2 - start;
      return { index: start, length, kind: "compare", arithmetic: false };
    }
    if (before === "=") continue; // the tail of a `==` already returned above
    // `>>=` and `<<=` shift-assign; only a single `<`/`>` before `=` is a comparison.
    if ((before === "<" || before === ">") && line[index - 2] === before) {
      return { index: index - 2, length: 3, kind: "assign", arithmetic: true };
    }
    if (before === "!" || before === "<" || before === ">") return { index: index - 1, length: 2, kind: "compare", arithmetic: false };
    // Everything else assigns. `+=`, `-=`, `*=`, `/=`, `%=` are ARITHMETIC: they accumulate into a running
    // quantity, which is what the business arithmetic looks like and what a config file never uses to carry
    // a secret. That distinction is the only place a bare identifier may be spared.
    // `+=` ACCUMULATES a running quantity — but only in code. `SECRET += changeme` is a config file
    // appending to a value. The exemption is therefore spent on the operator AND the target reading as code
    // (camelCase or a dotted member), not on the operator alone: stated as its complement ("all-caps means
    // config") it leaked `MY_secret += changeme` and `A += changeme`.
    const compound = "+-*/%".includes(before);
    const arithmetic = compound && CODE_CASED_TARGET.test(line.slice(0, index - 1));
    return { index: compound ? index - 1 : index, length: compound ? 2 : 1, kind: "assign", arithmetic };
  }
  return null;
}

/**
 * Shape-independent fallback for assignments the two shapes above cannot see:
 * C# comma pairs `{ "client_secret", "…" }`, Python `dict(…)`, Go composite literals.
 * When the line mentions a sensitive identifier anywhere, every quoted literal on it is
 * judged on its own. Name-like literals stay put by the value rules, so what disappears
 * is the value beside the name, not the name itself.
 */
function redactSensitiveStringLiterals(line: string): string {
  // A template literal is judged on the ONE thing that is unambiguous inside it: a sensitive key bound to a
  // written-out value. The "mentions a sensitive word" test that governs quoted strings cannot be used here,
  // because a URL mentions `token` whenever it carries one by reference — and redacting those whole was the
  // measured evidence loss this span exists to stop.
  const withTemplates = line.replace(TEMPLATE_LITERAL_PATTERN, (literal) => redactCredentialPairs(literal));
  const identifiers = line.match(IDENTIFIER_PATTERN) ?? [];
  if (!identifiers.some((identifier) => isSensitiveIdentifier(identifier))) return withTemplates;
  return withTemplates.replace(STRING_LITERAL_PATTERN, (literal) => (shouldRedactValue(literal) ? `${literal[0]}<redacted>${literal[0]}` : literal));
}

function isSensitiveIdentifier(identifier: string): boolean {
  const normalized = identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) return false;
  if (/(^|_)(secret|token|password|passwd|pwd|credential|credentials)($|_)/.test(normalized)) return true;
  return /(^|_)(privatekey|apikey|aeskey|accesskey|clientsecret|private_key|api_key|aes_key|access_key|client_secret)($|_)/.test(normalized);
}

/**
 * Value-side veto: a sensitive name alone never justifies redaction. Structure openers,
 * member expressions and name-like quoted strings are what surrounds a secret, not the
 * secret itself, and redacting them destroys evidence. A bare identifier stays redacted,
 * because `API_KEY=abcd1234` is indistinguishable from a real credential — a KNOWN, recorded cost: in code
 * `holiday.PtoToken = hours` loses `hours` for the same reason, and separating the two needs more than one
 * line of text. A CALL, by contrast, is never key material and is exempted outright.
 *
 * THE ADMISSION RULE FOR ANY FUTURE EXEMPTION, learned the expensive way: grant it by CONTEXT, never by
 * SHAPE. Four rounds of this function granted exemptions by shape — "it is a compound assignment", "it has
 * no digits", "it is a comparison", "it is a bound pattern" — and every one of them leaked, because
 * `changeme` and `hours` are the same shape and only their surroundings tell them apart. The exemptions that
 * survived are the ones that name a context: a call, a shell test's `$`-prefixed operand, arithmetic on a
 * code-cased target, a substitution.
 */
function shouldRedactValue(raw: string, bareReferenceAllowed = false, bound = false): boolean {
  // A pattern bound with `=~`. A bare word between anchors is a literal being checked — `/^changeme$/`
  // verifies a password — while a substitution or a pattern carrying real metacharacters is code a report
  // may need to quote. This applies ONLY here: applied generally it fired on every bare word, which is the
  // same shape-not-context mistake this file has now made four times.
  if (bound) {
    const value = raw.trim().replace(/\s*[)\]].*$/, "").trim();
    if (/^s[\/{|#]/.test(value)) return false;
    // An ALTERNATION of word-form branches is a set of literals, not an expression: `/^(changeme|letmein)$/`
    // checks two passwords exactly the way `/^changeme$/` checks one, and reading the single-word form as
    // literal while reading the two-word form as code is a distinction the attacker chooses. Measured as a
    // leak against main, which redacts it. Metacharacters anywhere else still mean a real pattern.
    if (/^(?:m|qr)?[\/{#]?\^?(?:\((?:\?:)?)?[A-Za-z0-9_-]+(?:\|[A-Za-z0-9_-]+)+\)?\$?[\/}#]?[a-z]*$/.test(value)) return true;
    // `//` is shorthand; `m//`, `m{}`, `qr//` are the same match written out.
    return /^(?:m|qr)?[\/{|#]?\^?[A-Za-z0-9_-]+\$?[\/}|#]?[a-z]*$/.test(value);
  }
  // A shell test — the operand sits before `]` — is the one context where an unquoted word IS the literal
  // rather than a reference: `if [ "$PASSWORD" != letmein ]`. Every value-shaped exemption is therefore
  // withdrawn there, and only a `$`-prefixed variable stays readable.
  //
  // THE RULE THIS FOLLOWS, and the one every later exemption must follow: an exemption is granted by
  // CONTEXT, never by SHAPE. Four rounds of this slice granted them by shape — "it is a compound assignment",
  // "it has no digits", "it is a comparison" — and every one of those leaked, because `changeme` and `hours`
  // are the same shape and only their surroundings differ.
  const shellTest = /\]\s*;?\s*(?:then\b.*)?$/.test(raw.trimEnd()) || /^\s*[^\s]+\s*\]\]/.test(raw);
  if (shellTest) {
    const operand = raw.trim().replace(/\s*\]\]?.*$/, "").trim();
    // Only a plain variable read is a reference. `$(cat /etc/pw)` runs a command and `$1` is a positional
    // argument — both were measured leaking when any `$` prefix was enough, so the exemption names the
    // shape it actually means: `$NAME` or `"${NAME}"`, nothing else.
    return Boolean(operand) && !SHELL_VARIABLE_READ.test(operand);
  }
  // A comparison's right operand carries the syntax that closes the condition — `nil {`, `requested {`,
  // `s3cr3tpass99 ]; then`. That tail is not part of the value, and judging it as one made every comparison
  // look like credential material.
  //
  // The trim requires WHITESPACE before the closer, because without it the closer cannot be told from the
  // value: `!= abc]` would otherwise be read as an empty value and pass through, which is a leak. Attached
  // punctuation therefore stays part of the value and is judged with it — the conservative direction.
  const value = dropUnopenedParens(raw.trim().replace(/[,;]$/, "").replace(/\s+(?:\{|\}|\]\s*;?.*|\)\s*\{?.*)$/, "").trim());
  if (!value || value.startsWith("${") || value === "null" || value === "true" || value === "false" || /^-?\d+(?:\.\d+)?$/.test(value)) return false;
  if (value.startsWith("{") || value.startsWith("[")) return false;

  if (MEMBER_EXPRESSION_PATTERN.test(value)) return false;
  // A call is code, never key material: `require("./tokenService")`, `calcHours(a, b)`, `getSecret()`.
  // Redacting one destroys an import or the arithmetic a report needs, and protects nothing — a literal
  // passed INSIDE the call is still judged on its own by `redactSensitiveStringLiterals`.
  if (CALL_EXPRESSION_PATTERN.test(value)) return false;
  // A digit-free identifier MAY be a reference to other code (`hours`, `consumption`, `nil`) — but only
  // where the operator already says so. "No digits" alone is not enough and was measured leaking: it let
  // `PASSWORD=changeme`, `db.password=letmein` and `API_KEY=deadbeef` through, because a word-form weak
  // password is spelled exactly like an identifier. The existing `isNameLikeLiteral` is safe precisely
  // because it requires no-digits AND the content being a sensitive NAME; dropping that second conjunct
  // here is what opened the hole.
  if (bareReferenceAllowed && BARE_REFERENCE_PATTERN.test(value)) return false;
  // A comparison's right operand carries the closing syntax of the condition (`]; then`, `{`), which is not
  // part of the value; trim it before judging so `!= nil ]` reads as `nil`.
  const quoted = value.match(QUOTED_VALUE_PATTERN);
  if (quoted && isNameLikeLiteral(quoted[1] ?? quoted[2] ?? "")) return false;
  return true;
}

/**
 * A quoted string that reads as a name rather than as key material: it hits the sensitive
 * word list, and carries no digit. Names like `tb_token` or `client_credentials` spell the
 * word out and stop there; credential material almost always mixes digits in, so a digit
 * revokes the exemption and `"my-secret-2024"` stays redacted.
 *
 * A name is also ONE thing. `"user=admin;password=changeme"` hits the word list and carries no digit, so
 * both conditions above passed and a connection string walked out intact — a leak this branch inherited
 * rather than introduced, and the most ordinary way a credential is actually written.
 *
 * What revokes the exemption is a sensitive key BOUND TO A VALUE inside the literal, not compoundness:
 * revoking it for every literal containing `=` also took `"token = ?"`, a SQL fragment whose value side is
 * a placeholder and which this same round exists to keep readable. A placeholder binds nothing.
 */
// A placeholder names something ELSEWHERE. `${VAR}` does; `${VAR:-changeme}` carries the literal with it,
// and `<changeme>` is only a placeholder by convention — both were measured walking out through this list,
// so the brace form is narrowed to a bare variable and the angle form is gone. Redacting a README's
// `<your-password>` costs nothing; keeping a default value readable costs the whole exemption.
// Every dialect's way of saying "the value lives elsewhere": positional, named, bind, interpolation,
// printf, template. A parameterised query is the case that decides the list — `password=@password` is the
// SECURE way to write it, and redacting it eats the evidence that the code is safe. `${VAR:-changeme}` is
// deliberately absent: a default value carries the literal with it.
const PLACEHOLDER_VALUE = /^(?:\?|\$\d+|:[A-Za-z_]\w*|@[A-Za-z_]\w*|%[a-z]|%\([A-Za-z_]\w*\)[a-z]|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\{\{[^{}]*\}\}|#\{[^{}]*\})$/;
// The `=` must be an assignment, not one character of a comparison: `password.value === confirm.value`
// inside a Vue attribute was read as `password.value = "=="` and redacted the whole handler.
const LITERAL_PAIR = /([A-Za-z_][A-Za-z0-9_.-]*)\s*(?<![=!<>])=(?!=)\s*([^;&\s]*)/g;

/**
 * A value that names something ELSEWHERE: a placeholder, or text whose interpolations are bare variables.
 *
 * `${type}_token` names a column; `${DEFAULT:-changeme}` carries the literal inside the braces, so an
 * interpolation holding a fallback operator binds a value like any other literal does.
 */
function bindsNoLiteral(value: string): boolean {
  if (!value || PLACEHOLDER_VALUE.test(value)) return true;
  // An expression is not key material. `@click="showPassword = !showPassword"` is a UI toggle, and it is
  // only reachable here — inside a literal — so `PASSWORD=!s3cret` on a bare line is judged as before.
  if (value.startsWith("!") || MEMBER_EXPRESSION_PATTERN.test(value)) return true;
  return value.includes("${") && !/\$\{[^}]*[-+?=][^}]*\}/.test(value);
}

function carriesCredentialPair(content: string): boolean {
  for (const pair of content.matchAll(LITERAL_PAIR)) {
    if (isSensitiveIdentifier(pair[1]) && !bindsNoLiteral(pair[2])) return true;
  }
  return false;
}

/**
 * Blank only the VALUE of each credential pair, leaving the rest of the text intact.
 *
 * Used for template literals, where redacting the whole literal destroys the URL that the pair sits in —
 * `` `${api}/v2/leaves?token=ghp_…` `` must lose the token and keep `/v2/leaves`, because that path is the
 * cross-repo call site.
 */
function redactCredentialPairs(content: string): string {
  return content.replace(LITERAL_PAIR, (whole, key: string, value: string) =>
    (isSensitiveIdentifier(key) && !bindsNoLiteral(value) ? `${whole.slice(0, whole.length - value.length)}<redacted>` : whole));
}

function isNameLikeLiteral(content: string): boolean {
  return !/[0-9]/.test(content) && !carriesCredentialPair(content) && isSensitiveIdentifier(content);
}

function trailingPunctuation(raw: string): string {
  const trimmed = raw.trimEnd();
  const punctuation = trimmed.endsWith(",") ? "," : trimmed.endsWith(";") ? ";" : "";
  return punctuation;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} characters]`;
}
