import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Snapshot, SnapshotRoot } from "../core/types.ts";
import { exists, nowIso, sha256, stableJson } from "../core/util.ts";
import { FileLedgerDraft, buildFileLedger, type ExcludeRule, type FileLedger, type LedgerRootRecord } from "./file-ledger.ts";

const execFileAsync = promisify(execFile);

async function spawnWithInput(command: string, args: string[], input: Buffer, options: { cwd?: string; timeoutMs?: number } = {}): Promise<{ stdout: Buffer; stderr: Buffer; code: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      rejectPromise(new Error(`${command} timed out`));
    }, options.timeoutMs ?? 30_000);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); rejectPromise(error); } });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? 1 });
    });
    child.stdin.end(input);
  });
}

/**
 * v2 declares a generation change in HOW the identity is derived, not in WHICH files are selected: the
 * identity now anchors on the tier2 content digest of the counted set instead of a (path, size, mtime) shape,
 * and the optional CodeGraph database has left it entirely. Every existing target's snapshot id therefore
 * moves once, deliberately, and any consumer comparing ids across the boundary must first compare
 * `scannerVersion` — an id derived under a different generation is not comparable, it is not "changed".
 */
export const SCANNER_VERSION = "git-aware-source-boundary-v2";

const EXCLUDED_DIRS = new Set([
  ".git", ".hg", ".svn", ".codegraph", ".excavator", ".excavator-work", "node_modules",
  "coverage", ".next", ".nuxt", ".idea", ".vscode",
  ".claude", ".codex", ".cursor", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".Spotlight-V100", ".Trashes", ".fseventsd", ".AppleDouble"
]);
/** File-name exclusions that produce a LEDGER ROW: the file exists, is tracked, and is deliberately not read. */
const SENSITIVE_FILES = [/\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /\.crt$/i];
const OS_ARTIFACT_FILES = [
  /^\.DS_Store$/i, /^Thumbs\.db$/i, /^ehthumbs\.db$/i, /^Desktop\.ini$/i,
  /^Icon\r$/i, /^\._/, /^\.LSOverride$/i, /\.sw[op]$/i, /~$/
];
const EXCLUDED_FILES = [...SENSITIVE_FILES, ...OS_ARTIFACT_FILES];
const SAFE_ENV_SAMPLE = /^\.env\.(sample|example|template|defaults?)$/i;
export const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".go", ".py", ".java", ".kt", ".kts", ".rb", ".php",
  ".cs", ".fs", ".rs", ".c", ".h", ".cc", ".cpp", ".hpp", ".swift", ".scala", ".vue", ".svelte", ".sql",
  ".yaml", ".yml", ".json", ".toml", ".xml", ".html", ".css", ".scss", ".md", ".sh", ".proto", ".graphql", ".gql", ".tf", ".hcl", ".astro",
  ".pm", ".pl", ".t", ".cgi", ".psgi", ".zpt", ".dtml"
]);
const PROJECT_FILE_NAMES = new Set([
  "package.json", "go.mod", "Cargo.toml", "pyproject.toml", "requirements.txt", "pom.xml",
  "build.gradle", "build.gradle.kts", "Gemfile", "composer.json", "docker-compose.yml", "docker-compose.yaml"
]);

/** The largest file the scanner counts. Beyond it the file becomes an `oversize` ledger row, not a silent skip. */
const MAX_COUNTED_FILE_BYTES = 2_000_000;

export interface ScannedFile {
  absolutePath: string;
  relativePath: string;
  size: number;
  extension: string;
  rootName: string;
}

interface ScanResult {
  files: ScannedFile[];
  ignoreRulesDigest: string;
  draft: FileLedgerDraft;
}

async function gitValue(root: string, args: string[], maxBuffer = 1024 * 1024): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], { timeout: 10_000, maxBuffer, encoding: "utf8" });
    return stdout.trim() || null;
  } catch { return null; }
}

async function gitBuffer(root: string, args: string[]): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, ...args], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024, encoding: null });
    return stdout as Buffer;
  } catch { return null; }
}

async function rootInfo(path: string, target: string, fileCount: number): Promise<SnapshotRoot> {
  const gitHead = await gitValue(path, ["rev-parse", "HEAD"]);
  const gitBranch = await gitValue(path, ["branch", "--show-current"]);
  const status = await gitValue(path, ["status", "--porcelain", "--untracked-files=normal"], 16 * 1024 * 1024);
  return {
    name: relative(target, path) || basename(path),
    path,
    gitHead,
    gitBranch,
    dirty: status === null ? null : status.length > 0,
    fileCount
  };
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/{2,}/g, "/");
}

function pathSegments(value: string): string[] { return normalizeRelativePath(value).split("/").filter(Boolean); }

/**
 * The two fixed-exclusion mechanisms, split apart.
 *
 * They used to be one predicate, which made them impossible to account for separately — and they are not the
 * same kind of thing. A directory segment names WORKSPACE MACHINERY (`.git`, `.codegraph`, `node_modules`):
 * it is pruned before candidacy, produces no rows, and its list is already covered by `ignoreRulesDigest`.
 * That pruning is also what makes the ledger bytes independent of whether an index has been built. A file-name
 * rule names a file that really is part of the repository and is deliberately not read, so it produces a row —
 * which is how a tracked `.pem` becomes visible instead of absent.
 */
function hasExcludedDirectorySegment(relativePath: string): boolean {
  return pathSegments(relativePath).some((segment) => EXCLUDED_DIRS.has(segment));
}

function fileExclusionRule(name: string): Extract<ExcludeRule, "sensitive-file" | "os-artifact"> | null {
  if (/^\.env(?:\.|$)/i.test(name) && !SAFE_ENV_SAMPLE.test(name)) return "sensitive-file";
  if (SENSITIVE_FILES.some((pattern) => pattern.test(name))) return "sensitive-file";
  if (OS_ARTIFACT_FILES.some((pattern) => pattern.test(name))) return "os-artifact";
  return null;
}

/** The union of both mechanisms, kept intact for the non-git directory walk so its pruning is unchanged. */
function isFixedExcludedPath(relativePath: string): boolean {
  if (hasExcludedDirectorySegment(relativePath)) return true;
  return fileExclusionRule(pathSegments(relativePath).at(-1) ?? "") !== null;
}

function isSupportedFileName(name: string): boolean {
  const extension = extname(name).toLowerCase();
  return SOURCE_EXTENSIONS.has(extension)
    || PROJECT_FILE_NAMES.has(name)
    || SAFE_ENV_SAMPLE.test(name)
    || /^(README(?:\.|$)|LICENSE(?:\.|$)|Dockerfile(?:\.|$)|Makefile(?:\.|$)|Procfile(?:\.|$))/i.test(name);
}

async function collectIgnoreRuleFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(abs);
      } else if (entry.isFile() && entry.name === ".gitignore") result.push(abs);
    }
  };
  await walk(root);

  const gitInfoExclude = await gitValue(root, ["rev-parse", "--git-path", "info/exclude"]);
  if (gitInfoExclude) result.push(isAbsolute(gitInfoExclude) ? gitInfoExclude : resolve(root, gitInfoExclude));
  const globalExclude = await gitValue(root, ["config", "--path", "--get", "core.excludesFile"]);
  if (globalExclude) result.push(isAbsolute(globalExclude) ? globalExclude : resolve(root, globalExclude));
  return [...new Set(result.map((path) => resolve(path)))].sort();
}

async function ignoreRulesForRoot(root: string): Promise<Array<{ path: string; digest: string }>> {
  const entries: Array<{ path: string; digest: string }> = [];
  for (const path of await collectIgnoreRuleFiles(root)) {
    try {
      const content = await readFile(path);
      entries.push({ path: path.startsWith(`${root}${sep}`) ? normalizeRelativePath(relative(root, path)) : path, digest: sha256(content) });
    } catch { /* ignore inaccessible global rules */ }
  }
  return entries;
}

async function gitCandidates(root: string): Promise<string[] | null> {
  const output = await gitBuffer(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (output === null) return null;
  return output.toString("utf8").split("\0").map(normalizeRelativePath).filter(Boolean);
}

async function nonGitCandidates(root: string): Promise<string[]> {
  const result: string[] = [];
  const tempGitDir = await mkdtemp(join(tmpdir(), "excavator-ignore-"));
  try {
    await execFileAsync("git", ["init", "--bare", tempGitDir], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    const all: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const abs = join(dir, entry.name);
        const rel = normalizeRelativePath(relative(root, abs));
        if (entry.isDirectory()) {
          if (isFixedExcludedPath(rel)) continue;
          await walk(abs);
        } else if (entry.isFile()) all.push(rel);
      }
    };
    await walk(root);
    if (!all.length) return [];
    const input = Buffer.from(all.join("\0") + "\0", "utf8");
    let ignored = new Set<string>();
    try {
      const result = await spawnWithInput("git", ["--git-dir", tempGitDir, "--work-tree", root, "check-ignore", "--no-index", "-z", "--stdin"], input);
      if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr.toString("utf8") || `git check-ignore failed with ${result.code}`);
      ignored = new Set(result.stdout.toString("utf8").split("\0").map(normalizeRelativePath).filter(Boolean));
    } catch {
      ignored = new Set();
    }
    for (const path of all) if (!ignored.has(path)) result.push(path);
    return result;
  } finally {
    await rm(tempGitDir, { recursive: true, force: true });
  }
}

/**
 * Classify every candidate of one root. The SELECTION is unchanged — the same files are pushed, in the same
 * order, under the same rules — but nothing is dropped without a row any more. The bucket priority mirrors the
 * old filter order (fixed exclusion, unregistered extension, path escape, file kind and size) with one
 * deliberate move: the cap is now judged LAST, so `skippedByCap` counts the files that passed every other
 * filter and were refused only for lack of room. Judging it first, as before, would report the cap's cost as
 * whatever mix of assets and junk happened to sort after the limit.
 */
async function scanRoot(root: string, target: string, maxFiles: number, draft: FileLedgerDraft): Promise<{ files: ScannedFile[]; record: LedgerRootRecord }> {
  const rootName = normalizeRelativePath(relative(target, root)) || basename(root);
  const fromGit = await gitCandidates(root);
  const candidates = fromGit ?? await nonGitCandidates(root);
  const files: ScannedFile[] = [];
  let counted = 0;
  let examined = 0;
  for (const candidate of candidates.sort()) {
    if (hasExcludedDirectorySegment(candidate)) continue;
    examined += 1;
    const name = basename(candidate);
    const extension = extname(name).toLowerCase();
    const absolutePath = resolve(root, candidate);
    const relativePath = normalizeRelativePath(relative(target, absolutePath));
    const base = { relativePath, absolutePath, rootName, extension };

    // Judged BEFORE any stat: a path outside the root must not be opened, sampled or hashed at all.
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
      draft.candidate({ ...base, rule: "path-escape", stat: null, unsampled: "path-escape" });
      continue;
    }

    let stat: { size: number; mtimeMs: number } | null = null;
    let unsampled: "irregular-file" | "symlink" | "stat-failed" | null = null;
    try {
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) unsampled = "symlink";
      else if (!info.isFile()) unsampled = "irregular-file";
      else stat = { size: info.size, mtimeMs: Math.trunc(info.mtimeMs) };
    } catch {
      unsampled = "stat-failed";
    }

    const rule = classify(name, stat, unsampled, counted, maxFiles);
    if (rule === null) {
      counted += 1;
      files.push({ absolutePath, relativePath, size: stat!.size, extension, rootName });
    }
    draft.candidate({ ...base, rule, stat, unsampled });
  }
  return {
    files,
    record: { name: rootName, candidateSource: fromGit ? "git-ls-files" : "filesystem-walk", candidates: examined, counted, dropped: false }
  };
}

function classify(
  name: string,
  stat: { size: number; mtimeMs: number } | null,
  unsampled: "irregular-file" | "symlink" | "stat-failed" | null,
  counted: number,
  maxFiles: number
): ExcludeRule | null {
  const fileRule = fileExclusionRule(name);
  if (fileRule) return fileRule;
  if (!isSupportedFileName(name)) return "unsupported-extension";
  if (unsampled !== null) return unsampled;
  if (stat === null) return "stat-failed";
  if (stat.size > MAX_COUNTED_FILE_BYTES) return "oversize";
  if (counted >= maxFiles) return "cap-reached";
  return null;
}

async function scanWorkspace(targetInput: string, maxFiles = 100_000): Promise<ScanResult> {
  const target = resolve(targetInput);
  const roots = await discoverRoots(target);
  const files: ScannedFile[] = [];
  const ignoreRules: Array<{ root: string; entries: Array<{ path: string; digest: string }> }> = [];
  const draft = new FileLedgerDraft();
  for (const [index, root] of roots.entries()) {
    const remaining = Math.max(0, maxFiles - files.length);
    if (!remaining) {
      // The cap ran out before this root was examined at all. Its files are in NO bucket, because they were
      // never candidates — so the only honest record is the root itself, named, as a dropped root.
      for (const dropped of roots.slice(index)) {
        draft.root({ name: normalizeRelativePath(relative(target, dropped)) || basename(dropped), candidateSource: "not-examined", candidates: 0, counted: 0, dropped: true });
      }
      break;
    }
    const scanned = await scanRoot(root, target, remaining, draft);
    files.push(...scanned.files);
    draft.root(scanned.record);
    ignoreRules.push({ root: normalizeRelativePath(relative(target, root)) || ".", entries: await ignoreRulesForRoot(root) });
  }
  const deduped = [...new Map(files.map((file) => [file.relativePath, file])).values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const ignoreRulesDigest = sha256(stableJson({
    scannerVersion: SCANNER_VERSION,
    fixedExcludedDirs: [...EXCLUDED_DIRS].sort(),
    fixedExcludedFiles: EXCLUDED_FILES.map(String),
    roots: ignoreRules
  }));
  return { files: deduped, ignoreRulesDigest, draft };
}

export async function discoverRoots(targetInput: string): Promise<string[]> {
  const target = resolve(targetInput);
  if (await exists(join(target, ".git"))) return [target];
  const entries = await readdir(target, { withFileTypes: true });
  const gitRoots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name)) continue;
    const child = join(target, entry.name);
    if (await exists(join(child, ".git"))) gitRoots.push(child);
  }
  return gitRoots.length ? gitRoots.sort() : [target];
}

export async function scanFiles(targetInput: string, maxFiles = 100_000): Promise<ScannedFile[]> {
  return (await scanWorkspace(targetInput, maxFiles)).files;
}

/**
 * The layer-1 output: the selected file set, the ledger that accounts for every candidate, and the snapshot
 * identity derived from them.
 *
 * The identity takes NO input from any index — that is the layer's defining constraint, and it is enforced by
 * the signature no longer having a database parameter. The CodeGraph identity is `codegraphIdentity()`,
 * computed and compared by the orchestrator on its own.
 *
 * `cacheDir` is optional and is a pure speed cache for the content digests; cold and warm runs are pinned by
 * test to produce identical bytes, so a caller that omits it gets the same artifact more slowly.
 */
export async function createSnapshot(targetInput: string, maxFiles = 100_000, options: { cacheDir?: string } = {}): Promise<{ snapshot: Snapshot; files: ScannedFile[]; ledger: FileLedger }> {
  const target = resolve(targetInput);
  const { files, ignoreRulesDigest, draft } = await scanWorkspace(target, maxFiles);
  const roots = await discoverRoots(target);
  const rootCounts = new Map<string, number>();
  for (const root of roots) rootCounts.set(root, 0);
  for (const file of files) {
    const root = [...roots].sort((a, b) => b.length - a.length).find((candidate) => file.absolutePath.startsWith(`${candidate}${sep}`) || file.absolutePath === candidate);
    if (root) rootCounts.set(root, (rootCounts.get(root) ?? 0) + 1);
  }
  const rootDetails = await Promise.all(roots.map((root) => rootInfo(root, target, rootCounts.get(root) ?? 0)));
  const ledger = await buildFileLedger({ draft, target, scannerVersion: SCANNER_VERSION, maxFiles, cacheDir: options.cacheDir });
  const identity = {
    target,
    roots: rootDetails.map(({ name, gitHead, dirty }) => ({ name, gitHead, dirty })),
    scannerVersion: SCANNER_VERSION,
    ignoreRulesDigest,
    // The tier2 whole-table digest, NOT the tier1 (path, size, mtime) shape: a same-size rewrite that keeps the
    // mtime reproduced the old id exactly, and every content-addressed cache downstream then served stale bytes.
    contentManifestDigest: ledger.contentManifestDigest
  };
  return {
    files,
    ledger,
    snapshot: {
      id: sha256(JSON.stringify(identity)).slice(0, 20),
      target,
      createdAt: nowIso(),
      roots: rootDetails,
      scannerVersion: SCANNER_VERSION,
      ignoreRulesDigest,
      // Kept as a recorded field but OUT of the identity: it is the advisory tier, and layer 8 treats a tier1
      // mismatch as advice and a tier2 mismatch as an error.
      sourceManifestDigest: ledger.sourceManifestDigest,
      contentManifestDigest: ledger.contentManifestDigest
    }
  };
}

export function isLikelySource(file: ScannedFile): boolean {
  return ![".md", ".json", ".yaml", ".yml", ".toml", ".xml", ".html", ".css", ".scss"].includes(file.extension);
}
