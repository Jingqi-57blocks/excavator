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
export const REDACTION_VERSION = "redaction-v4";

const IDENTIFIER_PATTERN = /[A-Za-z_][A-Za-z0-9_.-]*/g;
const STRING_LITERAL_PATTERN = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
const QUOTED_VALUE_PATTERN = /^"((?:[^"\\]|\\.)*)"$|^'((?:[^'\\]|\\.)*)'$/;
const MEMBER_EXPRESSION_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;

export function redactSecrets(text: string): string {
  const lines = text.split(/\r?\n/);
  return lines.map((line) => redactSecretLine(line)).join("\n");
}

function redactSecretLine(line: string): string {
  const sensitive = (identifier: string): boolean => isSensitiveIdentifier(identifier);
  const equals = line.indexOf("=");
  if (equals >= 0) {
    const prefix = line.slice(0, equals);
    const value = line.slice(equals + 1);
    const identifiers = prefix.match(IDENTIFIER_PATTERN) ?? [];
    if (identifiers.some((identifier) => sensitive(identifier)) && shouldRedactValue(value)) {
      return `${line.slice(0, equals + 1)}${value.match(/^\s*/)?.[0] ?? " "}<redacted>${trailingPunctuation(value)}`;
    }
  }
  const mapping = line.match(/^(\s*["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*:\s*)(.*)$/);
  if (mapping && sensitive(mapping[2]) && shouldRedactValue(mapping[3])) return `${mapping[1]}<redacted>${trailingPunctuation(mapping[3])}`;
  return redactSensitiveStringLiterals(line);
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
 * because `API_KEY=abcd1234` is indistinguishable from a real credential.
 */
function shouldRedactValue(raw: string): boolean {
  const value = raw.trim().replace(/[,;]$/, "").trim();
  if (!value || value.startsWith("${") || value === "null" || value === "true" || value === "false" || /^-?\d+(?:\.\d+)?$/.test(value)) return false;
  if (value.startsWith("{") || value.startsWith("[")) return false;
  if (MEMBER_EXPRESSION_PATTERN.test(value)) return false;
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
