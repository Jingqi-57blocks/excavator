import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { EvidenceItem, SourceWindow } from "../base/types.ts";
import type { ScannedFile } from "./snapshot.ts";
import { CONTRACT_CATEGORIES, primaryCategory, projectDocumentGroup, scoreProjectDocument } from "./document-scoring.ts";
import { atomicWrite, ensureDir, exists, readJson, redactSecrets, redactionCacheTag, REDACTION_VERSION, sha256, truncate, writeJson } from "../base/util.ts";
import { nameClassesMatching, textualExtensions } from "../base/language-registry.ts";
import { declaredExtensions, mechanismById } from "../base/mechanism-registry.ts";

// The content-search corpus: every scanned extension the registry marks as text. It used to be a literal
// that had to be kept in step with `SOURCE_EXTENSIONS` by hand (57B-347 added the test that catches a
// divergence); now the two are projections of one declaration and cannot diverge at all.
export const TEXTUAL_EXTENSIONS: ReadonlySet<string> = textualExtensions();

/**
 * The search mechanism's own declaration, read from the registry instead of restated here.
 *
 * This is the tie that makes the layer-2 ledger's `search` row checkable against reality: the corpus, the
 * `README` name class and the 500 KB bound the ledger publishes are the same three values this filter applies.
 * Restating them would let the ledger record a bound the search does not honour, or honour one it never
 * recorded — and a size bound nobody accounts for is exactly how large files became invisibly unsearchable.
 */
const SEARCH_MECHANISM = mechanismById("search");
const SEARCH_CORPUS = declaredExtensions("search");
export const SOURCE_WINDOW_CACHE_VERSION = `source-window-v3-${REDACTION_VERSION}`;

/** Cache identity for one redaction mode: a window recorded with redaction off must never satisfy a run
 *  that asked for it on, or the audit re-derivation would compare against the wrong bytes. */
export function windowCacheVersion(redact: boolean): string {
  return `${SOURCE_WINDOW_CACHE_VERSION}${redactionCacheTag(redact)}`;
}

interface SourceReaderOptions {
  target: string;
  snapshotId: string;
  cacheDir: string;
  maxWindows: number;
  maxCharacters: number;
  /**
   * Whether to blank secret values in what is recorded; see `ReportRequest.redactSecrets`.
   *
   * REQUIRED, with no default, and that is the point. It began optional, and the one construction site that
   * forgot it — the prepare path in `context.ts` — recorded README and route windows verbatim on a run that
   * had ASKED for redaction, then failed its own audit with `source digest is stale`. A default that matches
   * the product default makes forgetting invisible; requiring it makes every new recording site decide.
   */
  redact: boolean;
}

/**
 * Ceiling on one window's line count. Callers are told when a request hits it (`addSourceEvidence` reports
 * `clamped`): the window itself has always recorded the truth, but a caller who is not told believes a
 * 378-line function was covered by one window and stops reading — and the reading gate cannot catch that,
 * because it requires a window OVERLAPPING a decision function, not covering it.
 */
export const MAX_WINDOW_LINES = 240;

export class SourceReader {
  private readonly options: SourceReaderOptions;
  private windows = 0;
  private characters = 0;
  private hits = 0;
  private readonly memory = new Map<string, SourceWindow>();

  constructor(options: SourceReaderOptions) { this.options = options; }

  /** Redaction as this run asked for it — the one place the mode is applied, so no path can disagree. */
  private redact(text: string): string {
    return this.options.redact ? redactSecrets(text) : text;
  }

  /**
   * The run's mode, for recording paths that do not go through this reader (searches, fact packs).
   *
   * Reading it off the reader rather than re-deriving it from the request at each site is deliberate: the
   * reader is already threaded everywhere source text is recorded, so there is one value to get wrong
   * instead of five.
   */
  get redacts(): boolean { return this.options.redact; }

  get stats(): { windows: number; characters: number; hits: number } {
    return { windows: this.windows, characters: this.characters, hits: this.hits };
  }

  /**
   * How many lines the file has. Exists so a caller can tell the two ways a window comes back short apart:
   * the 240-line cap leaves real code unread, while a file that simply ended leaves nothing unread, and
   * arithmetic alone cannot separate them when the file happens to end exactly at the cap. Reads the file
   * without recording a window, so it charges nothing against the window budget.
   */
  async lineCount(relativePath: string): Promise<number> {
    const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
    const absolute = resolve(this.options.target, normalized);
    if (!absolute.startsWith(`${resolve(this.options.target)}/`) && absolute !== resolve(this.options.target)) throw new Error(`Source path escapes target: ${relativePath}`);
    const lines = (await readFile(absolute, "utf8")).split(/\r?\n/);
    // A file ending in a newline splits into a trailing empty segment. Counting it invents a line: on the
    // POSIX-normal 240-line file with a final newline, the caller was told line 241 was "still unread" and
    // spent a window discovering it was nothing. `window()` keeps its own arithmetic — the phantom line
    // there is harmless and its schema is frozen — so the correction lives here, where the claim is made.
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines.length;
  }

  async window(relativePath: string, startLine: number, endLine: number, reason: string): Promise<SourceWindow> {
    const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
    const key = sha256(`${windowCacheVersion(Boolean(this.options.redact))}:${this.options.snapshotId}:${normalized}:${startLine}:${endLine}`);
    const inMemory = this.memory.get(key);
    if (inMemory) { this.hits += 1; return inMemory; }
    const cachePath = join(this.options.cacheDir, "source-windows", `${key}.json`);
    if (await exists(cachePath)) {
      const cached = await readJson<SourceWindow>(cachePath);
      if (cached.cacheVersion === windowCacheVersion(Boolean(this.options.redact)) && cached.snapshotId === this.options.snapshotId && cached.digest === sha256(cached.content)) {
        this.memory.set(key, cached);
        this.hits += 1;
        return cached;
      }
    }
    if (this.windows >= this.options.maxWindows) throw new Error(`Source window budget exceeded (${this.options.maxWindows}); increase --max-source-windows (e.g. ${this.options.maxWindows * 2})`);
    const absolute = resolve(this.options.target, normalized);
    if (!absolute.startsWith(`${resolve(this.options.target)}/`) && absolute !== resolve(this.options.target)) throw new Error(`Source path escapes target: ${relativePath}`);
    const raw = await readFile(absolute, "utf8");
    const lines = raw.split(/\r?\n/);
    const safeStart = Math.max(1, startLine);
    const requestedEnd = Math.min(lines.length, Math.max(safeStart, endLine));
    const safeEnd = Math.min(requestedEnd, safeStart + MAX_WINDOW_LINES - 1);
    const selected = this.redact(lines.slice(safeStart - 1, safeEnd).join("\n"));
    if (this.characters + selected.length > this.options.maxCharacters) throw new Error(`Source character budget exceeded (${this.options.maxCharacters}); increase --max-source-characters (e.g. ${this.options.maxCharacters * 2})`);
    const value: SourceWindow = {
      cacheVersion: windowCacheVersion(Boolean(this.options.redact)),
      id: `S-${key.slice(0, 10)}`,
      snapshotId: this.options.snapshotId,
      path: normalized,
      startLine: safeStart,
      endLine: safeEnd,
      content: selected,
      digest: sha256(selected),
      reason
    };
    this.windows += 1;
    this.characters += selected.length;
    this.memory.set(key, value);
    await writeJson(cachePath, value);
    return value;
  }

  async wholeFile(relativePath: string, reason: string, maxCharacters = 20_000): Promise<SourceWindow> {
    const absolute = resolve(this.options.target, relativePath);
    if (!absolute.startsWith(`${resolve(this.options.target)}/`) && absolute !== resolve(this.options.target)) throw new Error(`Source path escapes target: ${relativePath}`);
    const raw = this.redact(await readFile(absolute, "utf8"));
    const lines = raw.split(/\r?\n/);
    let endLine = 1;
    let characters = 0;
    for (let index = 0; index < lines.length; index += 1) {
      characters += lines[index].length + 1;
      if (characters > maxCharacters) break;
      endLine = index + 1;
    }
    return this.window(relativePath, 1, endLine, reason);
  }
}

interface ScoredDocument { file: ScannedFile; score: number; group: string; category: string; }

export function selectProjectDocuments(files: ScannedFile[], maxFiles = 30): ScannedFile[] {
  // A mild size penalty breaks ties against oversized files; contract weights dominate it (see
  // document-scoring.ts).
  const scored: ScoredDocument[] = files.filter((file) => file.size > 0).map((file) => ({
    file,
    score: scoreProjectDocument(file) - file.size / 100_000,
    group: projectDocumentGroup(file),
    category: primaryCategory(file)
  })).filter((entry) => entry.score > 0);

  // Collapse each de-duplication group to its single best-scoring representative.
  const byGroup = new Map<string, ScoredDocument>();
  for (const entry of scored) {
    const current = byGroup.get(entry.group);
    if (!current || entry.score > current.score || (entry.score === current.score && entry.file.relativePath.localeCompare(current.file.relativePath) < 0)) byGroup.set(entry.group, entry);
  }

  // Bucket the survivors by category, each ranked by score.
  const buckets = new Map<string, ScoredDocument[]>();
  for (const entry of byGroup.values()) {
    const bucket = buckets.get(entry.category);
    if (bucket) bucket.push(entry); else buckets.set(entry.category, [entry]);
  }
  for (const bucket of buckets.values()) bucket.sort((a, b) => b.score - a.score || a.file.relativePath.localeCompare(b.file.relativePath));

  // Reserve one slot per root that owns a README so it is never dropped — de-weighted, not excluded.
  const readmes = buckets.get("readme") ?? [];
  const readmeReserve = Math.min(readmes.length, maxFiles);
  const contractSlots = maxFiles - readmeReserve;

  // Round-robin across contract categories so no single one monopolizes the cap; strongest categories
  // are visited first each round, so contract-facing files still outrank the README.
  const cursors = new Map<string, number>(CONTRACT_CATEGORIES.map((category) => [category, 0]));
  const selected: ScannedFile[] = [];
  let progressed = true;
  while (selected.length < contractSlots && progressed) {
    progressed = false;
    for (const category of CONTRACT_CATEGORIES) {
      if (selected.length >= contractSlots) break;
      const bucket = buckets.get(category);
      const cursor = cursors.get(category) ?? 0;
      if (!bucket || cursor >= bucket.length) continue;
      selected.push(bucket[cursor].file);
      cursors.set(category, cursor + 1);
      progressed = true;
    }
  }

  // Append the reserved READMEs after the contract picks: README is never first, never dropped.
  for (const entry of readmes) {
    if (selected.length >= maxFiles) break;
    selected.push(entry.file);
  }
  return selected;
}


export interface SourceSearchOptions {
  graphPaths?: Set<string>;
  onlyUnindexed?: boolean;
  maxResults?: number;
  regex?: boolean;
  caseSensitive?: boolean;
  /**
   * Whether the recorded excerpt is redacted; follows the run's own mode. Required for the same reason
   * `SourceReaderOptions.redact` is: `factpack.json` and the context excerpts are durable artifacts, and
   * both were recording plain text on runs that asked for redaction because the flag was optional here.
   */
  redact: boolean;
}

export interface SourceSearchMatch {
  file: ScannedFile;
  line: number;
  excerpt: string;
  matchedTerms: string[];
  score: number;
}

/**
 * Optional out-parameter: the caller passes an object and reads back how the returned set relates to
 * everything that matched. `total` is a lower bound on the real match count — each file stops after
 * 20 matched lines — so `truncated` (more matched than returned, or a file hit its per-file cap)
 * means the returned matches are provably not exhaustive.
 */
export interface SourceSearchStats {
  total: number;
  returned: number;
  truncated: boolean;
}

export function sourceSearch(files: ScannedFile[], terms: string[], options: SourceSearchOptions, stats?: SourceSearchStats): Promise<SourceSearchMatch[]> {
  const clean = [...new Set(terms.map((term) => term.trim()).filter((term) => options.regex ? term.length > 0 : term.length >= 2))];
  if (!clean.length) return Promise.resolve([]);
  const flags = options.caseSensitive ? "" : "i";
  const expressions = clean.map((term) => {
    try { return new RegExp(options.regex ? term : escapeRegex(term), flags); }
    catch (error) { throw new Error(`Invalid source search expression ${JSON.stringify(term)}: ${(error as Error).message}`); }
  });
  const union = new RegExp(expressions.map((expression) => `(?:${expression.source})`).join("|"), flags);
  const candidates = files.filter((file) => {
    const supported = SEARCH_CORPUS.has(file.extension)
      || nameClassesMatching(basename(file.relativePath)).some((entry) => SEARCH_MECHANISM.nameClasses.includes(entry.id));
    if (!supported) return false;
    if (SEARCH_MECHANISM.maxFileBytes !== null && file.size > SEARCH_MECHANISM.maxFileBytes) return false;
    if (options.onlyUnindexed && options.graphPaths?.has(file.relativePath)) return false;
    return true;
  });
  const max = Math.max(1, options.maxResults ?? 80);
  const retained = Math.max(250, max * 5);
  return (async () => {
    let results: SourceSearchMatch[] = [];
    // `total` counts every match seen (independent of the intermediate pruning of `results`), so it
    // survives as an honest lower bound on the real count; `capped` records that a file stopped early.
    let total = 0;
    let capped = false;
    for (const file of candidates) {
      let text: string;
      try { text = await readFile(file.absolutePath, "utf8"); } catch { continue; }
      const lines = text.split(/\r?\n/);
      let fileMatches = 0;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!union.test(line)) continue;
        const matchedTerms = clean.filter((_, termIndex) => expressions[termIndex].test(line));
        const excerpt = options.redact ? redactSecrets(lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 2)).join("\n")) : lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 2)).join("\n");
        results.push({ file, line: index + 1, excerpt, matchedTerms, score: searchScore(file, line, matchedTerms, clean, options) });
        total += 1;
        fileMatches += 1;
        if (fileMatches >= 20) { capped = true; break; }
      }
      if (results.length > retained * 2) results = rankSearchMatches(results).slice(0, retained);
    }
    const ranked = rankSearchMatches(results).slice(0, max);
    if (stats) {
      stats.total = total;
      stats.returned = ranked.length;
      stats.truncated = total > ranked.length || capped;
    }
    return ranked;
  })();
}

function rankSearchMatches(matches: SourceSearchMatch[]): SourceSearchMatch[] {
  return matches.sort((a, b) => b.score - a.score || a.file.relativePath.localeCompare(b.file.relativePath) || a.line - b.line);
}

function searchScore(file: ScannedFile, line: string, matchedTerms: string[], terms: string[], options: SourceSearchOptions): number {
  const path = file.relativePath.replaceAll("\\", "/");
  const lowerPath = path.toLowerCase();
  const pathTerms = options.regex ? [] : terms.filter((term) => lowerPath.includes(term.toLowerCase()));
  let score = matchedTerms.length * 25 + pathTerms.length * 90;
  if (matchedTerms.some((term) => line.includes(term))) score += 8;
  if (/\.(ts|tsx|js|jsx|go|py|java|kt|rb|php|cs|rs|c|cc|cpp|swift|vue|svelte)$/i.test(path)) score += 5;
  const isTest = /(^|\/)(tests?|__tests__|fixtures?|mocks?)(\/|$)|\.(test|spec)\./i.test(path);
  const isGenerated = /(^|\/)(dist|build|generated|vendor|node_modules)(\/|$)|swagger|openapi/i.test(path);
  if (isTest) score -= pathTerms.length ? 10 : 60;
  if (isGenerated) score -= pathTerms.length ? 10 : 45;
  if (/\.md$/i.test(path) && !pathTerms.length) score -= 15;
  return score;
}

export function evidenceFromWindow(window: SourceWindow, kind: EvidenceItem["kind"] = "source"): EvidenceItem {
  return {
    id: window.id,
    snapshotId: window.snapshotId,
    kind,
    title: `${window.path}:${window.startLine}-${window.endLine}`,
    path: window.path,
    startLine: window.startLine,
    endLine: window.endLine,
    content: window.content,
    reason: window.reason,
    digest: window.digest
  };
}

export function manifestSummary(path: string, content: string, redact: boolean): Record<string, unknown> {
  const name = basename(path);
  if (name === "package.json") {
    try {
      const json = JSON.parse(content) as Record<string, unknown>;
      return {
        name: json.name,
        version: json.version,
        scripts: Object.keys((json.scripts as Record<string, unknown>) ?? {}),
        dependencies: Object.keys((json.dependencies as Record<string, unknown>) ?? {}),
        devDependencies: Object.keys((json.devDependencies as Record<string, unknown>) ?? {})
      };
    } catch { return { parseError: true }; }
  }
  if (name === "go.mod") {
    const module = content.match(/^module\s+(.+)$/m)?.[1];
    const go = content.match(/^go\s+(.+)$/m)?.[1];
    const requires = [...content.matchAll(/^\s*([\w./-]+)\s+v[^\s]+/gm)].map((m) => m[1]).slice(0, 100);
    return { module, go, requires };
  }
  return { name, directory: dirname(path), excerpt: truncate(redact ? redactSecrets(content) : content, 8000) };
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
