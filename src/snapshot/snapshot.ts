import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Snapshot, SnapshotRoot } from "../core/types.ts";
import { exists, nowIso, sha256, stableJson } from "../core/util.ts";

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

export const SCANNER_VERSION = "git-aware-source-boundary-v1";

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

async function scanRoot(root: string, target: string, maxFiles: number): Promise<ScannedFile[]> {
  const rootName = normalizeRelativePath(relative(target, root)) || basename(root);
  const candidates = await gitCandidates(root) ?? await nonGitCandidates(root);
  const files: ScannedFile[] = [];
  for (const candidate of candidates.sort()) {
    if (files.length >= maxFiles || isFixedExcludedPath(candidate)) continue;
    const name = basename(candidate);
    if (!isSupportedFileName(name)) continue;
    const absolutePath = resolve(root, candidate);
    if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) continue;
    try {
      const info = await lstat(absolutePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000) continue;
      files.push({
        absolutePath,
        relativePath: normalizeRelativePath(relative(target, absolutePath)),
        size: info.size,
        extension: extname(name).toLowerCase(),
        rootName
      });
    } catch { /* file changed during scan */ }
  }
  return files;
}

async function scanWorkspace(targetInput: string, maxFiles = 100_000): Promise<ScanResult> {
  const target = resolve(targetInput);
  const roots = await discoverRoots(target);
  const files: ScannedFile[] = [];
  const ignoreRules: Array<{ root: string; entries: Array<{ path: string; digest: string }> }> = [];
  for (const root of roots) {
    const remaining = Math.max(0, maxFiles - files.length);
    if (!remaining) break;
    files.push(...await scanRoot(root, target, remaining));
    ignoreRules.push({ root: normalizeRelativePath(relative(target, root)) || ".", entries: await ignoreRulesForRoot(root) });
  }
  const deduped = [...new Map(files.map((file) => [file.relativePath, file])).values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const ignoreRulesDigest = sha256(stableJson({
    scannerVersion: SCANNER_VERSION,
    fixedExcludedDirs: [...EXCLUDED_DIRS].sort(),
    fixedExcludedFiles: EXCLUDED_FILES.map(String),
    roots: ignoreRules
  }));
  return { files: deduped, ignoreRulesDigest };
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

export async function createSnapshot(targetInput: string, codegraphPath?: string | string[], maxFiles = 100_000): Promise<{ snapshot: Snapshot; files: ScannedFile[] }> {
  const target = resolve(targetInput);
  const { files, ignoreRulesDigest } = await scanWorkspace(target, maxFiles);
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
  const identity = {
    target,
    roots: rootDetails.map(({ name, gitHead, dirty }) => ({ name, gitHead, dirty })),
    scannerVersion: SCANNER_VERSION,
    ignoreRulesDigest,
    sourceManifestDigest,
    codegraphDigest
  };
  return {
    files,
    snapshot: {
      id: sha256(JSON.stringify(identity)).slice(0, 20),
      target,
      createdAt: nowIso(),
      roots: rootDetails,
      scannerVersion: SCANNER_VERSION,
      ignoreRulesDigest,
      sourceManifestDigest,
      codegraphDigest
    }
  };
}

export function isLikelySource(file: ScannedFile): boolean {
  return ![".md", ".json", ".yaml", ".yml", ".toml", ".xml", ".html", ".css", ".scss"].includes(file.extension);
}
