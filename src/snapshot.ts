import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { BoundaryCensus, Snapshot, SnapshotRoot } from "./types.ts";
import { CURRENT_SCANNER_VERSION, resolveScannerVersion } from "./scanner-versions.ts";
import { BoundaryCensusBuilder, sniffFileKind, type CensusEntry } from "./scan-census.ts";
import { exists, nowIso, sha256, stableJson } from "./util.ts";

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

// The scanner boundary is versioned in scanner-versions.ts so historical snapshots stay re-derivable.
export const SCANNER_VERSION = CURRENT_SCANNER_VERSION;
export { SOURCE_EXTENSIONS } from "./scanner-versions.ts";

const EXCLUDED_DIRS = new Set([
  ".git", ".hg", ".svn", ".codegraph", ".excavator", ".excavator-work", "node_modules",
  "coverage", ".next", ".nuxt", ".idea", ".vscode",
  ".claude", ".codex", ".cursor", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".Spotlight-V100", ".Trashes", ".fseventsd", ".AppleDouble"
]);
const EXCLUDED_FILES = [
  /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /\.crt$/i,
  /^\.DS_Store$/i, /^Thumbs\.db$/i, /^ehthumbs\.db$/i, /^Desktop\.ini$/i,
  /^Icon\r$/i, /^\._/, /^\.LSOverride$/i, /\.sw[op]$/i, /~$/
];
const SAFE_ENV_SAMPLE = /^\.env\.(sample|example|template|defaults?)$/i;
const PROJECT_FILE_NAMES = new Set([
  "package.json", "go.mod", "Cargo.toml", "pyproject.toml", "requirements.txt", "pom.xml",
  "build.gradle", "build.gradle.kts", "Gemfile", "composer.json", "docker-compose.yml", "docker-compose.yaml"
]);


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
  boundaryCensus: BoundaryCensus;
  unscanned: CensusEntry[];
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

function isFixedExcludedPath(relativePath: string): boolean {
  const segments = pathSegments(relativePath);
  if (segments.some((segment) => EXCLUDED_DIRS.has(segment))) return true;
  const name = segments.at(-1) ?? "";
  return isExcludedFile(name);
}

function isExcludedFile(name: string): boolean {
  if (/^\.env(?:\.|$)/i.test(name) && !SAFE_ENV_SAMPLE.test(name)) return true;
  return EXCLUDED_FILES.some((pattern) => pattern.test(name));
}

function isSupportedFileName(name: string, extensions: ReadonlySet<string>): boolean {
  const extension = extname(name).toLowerCase();
  return extensions.has(extension)
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

async function scanRoot(root: string, target: string, maxFiles: number, extensions: ReadonlySet<string>, census: BoundaryCensusBuilder): Promise<ScannedFile[]> {
  const rootName = normalizeRelativePath(relative(target, root)) || basename(root);
  const candidates = await gitCandidates(root) ?? await nonGitCandidates(root);
  const files: ScannedFile[] = [];
  for (const candidate of candidates.sort()) {
    // Policy-excluded paths (secrets, editor junk) are never scanned and never sniffed for the census.
    if (isFixedExcludedPath(candidate)) continue;
    if (files.length >= maxFiles) { census.markTruncated(); continue; }
    const name = basename(candidate);
    const absolutePath = resolve(root, candidate);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) continue;
    let info;
    try { info = await lstat(absolutePath); } catch { continue; /* file changed during scan */ }
    if (!info.isFile() || info.isSymbolicLink()) continue;
    const relativePath = normalizeRelativePath(relative(target, absolutePath));
    const extension = extname(name).toLowerCase();
    if (!isSupportedFileName(name, extensions)) {
      // Inside the boundary but outside the whitelist: census it (text vs binary) so a not-found
      // search verdict can be honest about files it never reached.
      census.add({ relativePath, extension, kind: await sniffFileKind(absolutePath) });
      continue;
    }
    if (info.size > 2_000_000) {
      // Whitelisted text, but over the scan size cap: an in-boundary text file the manifest omits.
      census.add({ relativePath, extension, kind: "text" });
      continue;
    }
    files.push({ absolutePath, relativePath, size: info.size, extension, rootName });
  }
  return files;
}

async function scanWorkspace(targetInput: string, maxFiles = 100_000, scannerVersion: string = SCANNER_VERSION): Promise<ScanResult> {
  const extensions = resolveScannerVersion(scannerVersion);
  const target = resolve(targetInput);
  const roots = await discoverRoots(target);
  const files: ScannedFile[] = [];
  const census = new BoundaryCensusBuilder();
  const ignoreRules: Array<{ root: string; entries: Array<{ path: string; digest: string }> }> = [];
  for (const root of roots) {
    const remaining = Math.max(0, maxFiles - files.length);
    if (!remaining) { census.markTruncated(); break; }
    files.push(...await scanRoot(root, target, remaining, extensions, census));
    ignoreRules.push({ root: normalizeRelativePath(relative(target, root)) || ".", entries: await ignoreRulesForRoot(root) });
  }
  const deduped = [...new Map(files.map((file) => [file.relativePath, file])).values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const ignoreRulesDigest = sha256(stableJson({
    scannerVersion,
    fixedExcludedDirs: [...EXCLUDED_DIRS].sort(),
    fixedExcludedFiles: EXCLUDED_FILES.map(String),
    roots: ignoreRules
  }));
  return { files: deduped, ignoreRulesDigest, boundaryCensus: census.summary(), unscanned: census.entries };
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

export async function scanFiles(targetInput: string, maxFiles = 100_000, scannerVersion: string = SCANNER_VERSION): Promise<ScannedFile[]> {
  return (await scanWorkspace(targetInput, maxFiles, scannerVersion)).files;
}

export async function createSnapshot(targetInput: string, codegraphPath?: string | string[], maxFiles = 100_000, scannerVersion: string = SCANNER_VERSION): Promise<{ snapshot: Snapshot; files: ScannedFile[]; unscanned: CensusEntry[] }> {
  const target = resolve(targetInput);
  const { files, ignoreRulesDigest, boundaryCensus, unscanned } = await scanWorkspace(target, maxFiles, scannerVersion);
  const roots = await discoverRoots(target);
  const rootCounts = new Map<string, number>();
  for (const root of roots) rootCounts.set(root, 0);
  for (const file of files) {
    const root = [...roots].sort((a, b) => b.length - a.length).find((candidate) => file.absolutePath.startsWith(`${candidate}${sep}`) || file.absolutePath === candidate);
    if (root) rootCounts.set(root, (rootCounts.get(root) ?? 0) + 1);
  }
  const rootDetails = await Promise.all(roots.map((root) => rootInfo(root, target, rootCounts.get(root) ?? 0)));
  const hash = createHash("sha256");
  for (const file of files) {
    const info = await stat(file.absolutePath);
    hash.update(file.relativePath).update("\0").update(String(info.size)).update("\0").update(String(Math.trunc(info.mtimeMs))).update("\n");
  }
  const sourceManifestDigest = hash.digest("hex");
  let codegraphDigest: string | null = null;
  const codegraphPaths = codegraphPath == null ? [] : Array.isArray(codegraphPath) ? codegraphPath : [codegraphPath];
  if (codegraphPaths.length === 1) {
    // A single database keeps its original identity formula so single-module snapshots are unchanged.
    const [path] = codegraphPaths;
    if (await exists(path)) {
      const info = await stat(path);
      codegraphDigest = sha256(`${resolve(path)}:${info.size}:${Math.trunc(info.mtimeMs)}`);
    }
  } else if (codegraphPaths.length > 1) {
    const parts: string[] = [];
    for (const path of [...codegraphPaths].sort()) {
      if (!await exists(path)) continue;
      const info = await stat(path);
      parts.push(`${resolve(path)}:${info.size}:${Math.trunc(info.mtimeMs)}`);
    }
    if (parts.length) codegraphDigest = sha256(parts.join("\n"));
  }
  // Identity uses the recorded scanner version so audit can re-derive a historical snapshot exactly.
  // boundaryCensus is intentionally absent here — it must never enter the identity hash.
  const identity = {
    target,
    roots: rootDetails.map(({ name, gitHead, dirty }) => ({ name, gitHead, dirty })),
    scannerVersion,
    ignoreRulesDigest,
    sourceManifestDigest,
    codegraphDigest
  };
  return {
    files,
    unscanned,
    snapshot: {
      id: sha256(JSON.stringify(identity)).slice(0, 20),
      target,
      createdAt: nowIso(),
      roots: rootDetails,
      scannerVersion,
      ignoreRulesDigest,
      sourceManifestDigest,
      codegraphDigest,
      boundaryCensus
    }
  };
}

// Extensions that count as documentation/markup/config/resource rather than code CodeGraph would
// index. They are scanned and searchable, but excluded from the codegraph-coverage denominator so a
// project full of UI markup or resource files does not read as poorly indexed. Scripts (.ps1/.psm1/
// .bat/.cmd) and .gradle stay counted as likely source — they are executable code.
const NON_CODE_EXTENSIONS = new Set([
  ".md", ".json", ".yaml", ".yml", ".toml", ".xml", ".html", ".css", ".scss",
  ".xaml", ".axaml", ".storyboard", ".xib", ".feature",
  ".csproj", ".fsproj", ".vbproj", ".sln", ".props", ".targets",
  ".resx", ".strings", ".plist",
  ".ini", ".properties", ".cfg", ".conf",
  ".txt", ".rst", ".adoc"
]);

export function isLikelySource(file: ScannedFile): boolean {
  return !NON_CODE_EXTENSIONS.has(file.extension);
}
