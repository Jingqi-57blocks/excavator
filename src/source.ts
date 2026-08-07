import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { EvidenceItem, SourceWindow } from "./types.ts";
import type { ScannedFile } from "./snapshot.ts";
import { atomicWrite, ensureDir, exists, readJson, redactSecrets, REDACTION_VERSION, sha256, truncate, writeJson } from "./util.ts";

const TEXTUAL_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".py", ".java", ".kt", ".kts", ".rb", ".php", ".cs", ".fs", ".rs", ".c", ".h", ".cc", ".cpp", ".hpp", ".swift", ".scala", ".vue", ".svelte", ".sql", ".yaml", ".yml", ".json", ".toml", ".xml", ".html", ".css", ".scss", ".md", ".sh"]);
export const SOURCE_WINDOW_CACHE_VERSION = `source-window-v3-${REDACTION_VERSION}`;

const MANIFEST_NAMES = new Set(["package.json", "go.mod", "Cargo.toml", "pyproject.toml", "requirements.txt", "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "composer.json", "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "Makefile"]);

interface SourceReaderOptions {
  target: string;
  snapshotId: string;
  cacheDir: string;
  maxWindows: number;
  maxCharacters: number;
}

export class SourceReader {
  private readonly options: SourceReaderOptions;
  private windows = 0;
  private characters = 0;
  private hits = 0;
  private readonly memory = new Map<string, SourceWindow>();

  constructor(options: SourceReaderOptions) { this.options = options; }

  get stats(): { windows: number; characters: number; hits: number } {
    return { windows: this.windows, characters: this.characters, hits: this.hits };
  }

  async window(relativePath: string, startLine: number, endLine: number, reason: string): Promise<SourceWindow> {
    const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
    const key = sha256(`${SOURCE_WINDOW_CACHE_VERSION}:${this.options.snapshotId}:${normalized}:${startLine}:${endLine}`);
    const inMemory = this.memory.get(key);
    if (inMemory) { this.hits += 1; return inMemory; }
    const cachePath = join(this.options.cacheDir, "source-windows", `${key}.json`);
    if (await exists(cachePath)) {
      const cached = await readJson<SourceWindow>(cachePath);
      if (cached.cacheVersion === SOURCE_WINDOW_CACHE_VERSION && cached.snapshotId === this.options.snapshotId && cached.digest === sha256(cached.content)) {
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
    const safeEnd = Math.min(requestedEnd, safeStart + 239);
    const selected = redactSecrets(lines.slice(safeStart - 1, safeEnd).join("\n"));
    if (this.characters + selected.length > this.options.maxCharacters) throw new Error(`Source character budget exceeded (${this.options.maxCharacters}); increase --max-source-characters (e.g. ${this.options.maxCharacters * 2})`);
    const value: SourceWindow = {
      cacheVersion: SOURCE_WINDOW_CACHE_VERSION,
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
    const raw = redactSecrets(await readFile(absolute, "utf8"));
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

export function selectProjectDocuments(files: ScannedFile[], maxFiles = 30): ScannedFile[] {
  const scored = files.filter((file) => file.size > 0).map((file) => {
    const name = basename(file.relativePath);
    let score = 0;
    if (/^README(\.|$)/i.test(name)) score += 100;
    if (MANIFEST_NAMES.has(name) || /^\.env\.(sample|example|template|defaults?)$/i.test(name)) score += 90;
    if (/swagger|openapi/i.test(name)) score += 40 + (/\.ya?ml$/i.test(name) ? 5 : 0);
    if (/docker-compose|Dockerfile|Procfile|Makefile/i.test(name)) score += 30;
    if (/config.*\.(ya?ml|toml|json)$/i.test(name)) score += 15;
    score -= file.size / 100_000;
    return { file, score, group: projectDocumentGroup(file) };
  }).filter((entry) => entry.score > 0);
  scored.sort((a, b) => b.score - a.score || a.file.relativePath.localeCompare(b.file.relativePath));
  const selected: ScannedFile[] = [];
  const groups = new Set<string>();
  for (const entry of scored) {
    if (groups.has(entry.group)) continue;
    groups.add(entry.group);
    selected.push(entry.file);
    if (selected.length >= maxFiles) break;
  }
  return selected;
}

function projectDocumentGroup(file: ScannedFile): string {
  const name = basename(file.relativePath).toLowerCase();
  if (/^readme(?:\.|$)/i.test(name)) return `${file.rootName}:readme`;
  if (/swagger|openapi/i.test(name)) return `${file.rootName}:api-spec`;
  return `${file.rootName}:${name}`;
}


export interface SourceSearchOptions {
  graphPaths?: Set<string>;
  onlyUnindexed?: boolean;
  maxResults?: number;
  regex?: boolean;
  caseSensitive?: boolean;
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

export function sourceSearch(files: ScannedFile[], terms: string[], options: SourceSearchOptions = {}, stats?: SourceSearchStats): Promise<SourceSearchMatch[]> {
  const clean = [...new Set(terms.map((term) => term.trim()).filter((term) => options.regex ? term.length > 0 : term.length >= 2))];
  if (!clean.length) return Promise.resolve([]);
  const flags = options.caseSensitive ? "" : "i";
  const expressions = clean.map((term) => {
    try { return new RegExp(options.regex ? term : escapeRegex(term), flags); }
    catch (error) { throw new Error(`Invalid source search expression ${JSON.stringify(term)}: ${(error as Error).message}`); }
  });
  const union = new RegExp(expressions.map((expression) => `(?:${expression.source})`).join("|"), flags);
  const candidates = files.filter((file) => {
    if (!TEXTUAL_EXTENSIONS.has(file.extension) && !/^README/i.test(basename(file.relativePath))) return false;
    if (file.size > 500_000) return false;
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
        const excerpt = redactSecrets(lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 2)).join("\n"));
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

export function manifestSummary(path: string, content: string): Record<string, unknown> {
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
  return { name, directory: dirname(path), excerpt: truncate(redactSecrets(content), 8000) };
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
