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
export const REDACTION_VERSION = "redaction-v6";

const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_.-]*/g;
const STRING_LITERAL_PATTERN = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
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
const CODE_CASED_TARGET = /(?:^|[^A-Za-z0-9_$])[a-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*$/;
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
  const operator = classifyOperator(line);
  if (operator) {
    const head = line.slice(0, operator.index + operator.length);
    const value = line.slice(operator.index + operator.length);
    const identifiers = line.slice(0, operator.index).match(IDENTIFIER_PATTERN) ?? [];
    // A bare identifier is only spared where the operator itself says "quantity", i.e. arithmetic
    // accumulation, or on the right of a comparison where an unquoted operand is a reference. Everywhere
    // else it stays redacted, because `PASSWORD=changeme` and `holiday.PtoToken = hours` are the same text.
    const bareAllowed = operator.arithmetic || operator.kind === "compare";
    if (identifiers.some((identifier) => sensitive(identifier)) && shouldRedactValue(value, bareAllowed, operator.bound)) {
      return `${head}${value.match(/^\s*/)?.[0] ?? " "}<redacted>${trailingPunctuation(value)}`;
    }
    // The FIRST operator does not own the line. `[ "$PASSWORD" == old ] && PASSWORD=news3cr3t99` passes the
    // comparison and then assigns the real secret; judging only the first operator left that assignment
    // unexamined. Re-scan what follows, so a later operator gets the same judgement as a first one.
    if (operator.kind === "compare") {
      const rest = redactSecretLine(value);
      if (rest !== value) return `${head}${rest}`;
    }
  }
  // A `key: value` mapping — but NOT Go's `:=`, where the colon belongs to the assignment operator.
  // Matching it there cut the line at the colon and emitted `apiToken :<redacted>`, losing the `=`; the
  // literal-level fallback covers that form correctly instead.
  const mapping = /^\s*["']?[A-Za-z_][A-Za-z0-9_.-]*["']?\s*:=/.test(line)
    ? null
    : line.match(/^(\s*["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*:\s*)(.*)$/);
  if (mapping && sensitive(mapping[2]) && shouldRedactValue(mapping[3])) return `${mapping[1]}<redacted>${trailingPunctuation(mapping[3])}`;
  return redactSensitiveStringLiterals(line);
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

function classifyOperator(line: string): LineOperator | null {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "=") continue;
    const before = index > 0 ? line[index - 1] : "";
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
  const identifiers = line.match(IDENTIFIER_PATTERN) ?? [];
  if (!identifiers.some((identifier) => isSensitiveIdentifier(identifier))) return line;
  return line.replace(STRING_LITERAL_PATTERN, (literal) => (shouldRedactValue(literal) ? `${literal[0]}<redacted>${literal[0]}` : literal));
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
    if (/^s\//.test(value)) return false;
    return /^\/?\^?[A-Za-z0-9_-]+\$?\/?[a-z]*$/.test(value);
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
  const value = raw.trim().replace(/[,;]$/, "").replace(/\s+(?:\{|\}|\]\s*;?.*|\)\s*\{?.*)$/, "").trim();
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
 */
function isNameLikeLiteral(content: string): boolean {
  return !/[0-9]/.test(content) && isSensitiveIdentifier(content);
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
