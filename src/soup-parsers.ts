// Table-driven SOUP (software of unknown provenance) manifest/lockfile/container parsers.
//
// Every parser is a pure function over file *content*: it never executes the file, spawns a process,
// resolves a network dependency or touches the filesystem. Parsing is line/lexical (JSON.parse is used
// only to read data structure, never to run code), so the whole set stays deterministic and zero-dep,
// fit for Core. Parsers are vertical-neutral: the table keys on ecosystem/format, never on any domain.
//
// A parser reports a component's version only when it is *exact* (a concrete pin). A range, caret,
// wildcard, `latest` container tag or missing version yields `version: null` (optionally a `versionSpec`
// for the human-readable constraint). The orchestrator (soup.ts) turns a component group with no exact
// version anywhere into a structural gap — so parsers never decide gaps, they only report what they see.

export type SoupEcosystem = "npm" | "nuget" | "pypi" | "go" | "container";
export type SoupSource = "manifest" | "lockfile" | "container";
export type SoupScope = "runtime" | "dev";

export interface SoupParsedItem {
  name: string;
  /** Concrete pinned version only; null when the reference is a range/wildcard/`latest`/absent. */
  version: string | null;
  /** Human-readable constraint when the reference is not an exact pin (e.g. `^4.0.0`, `>=1.2`). */
  versionSpec?: string;
  /** 1-based line of the declaring reference, for evidence. */
  line: number;
  scope?: SoupScope;
}

export interface SoupParseResult {
  items: SoupParsedItem[];
  /** Honest coverage caveats: unparsed formats, skipped variable refs, parse errors. Never thrown. */
  notes: string[];
}

export interface SoupParser {
  ecosystem: SoupEcosystem;
  id: string;
  source: SoupSource;
  /** Decide by relative path (basename/extension); never reads content. */
  matches(relativePath: string): boolean;
  parse(content: string): SoupParseResult;
}

/**
 * A concrete pinned version. Accepts a leading `v`, one-to-four dotted numeric segments (so .NET's
 * four-part `2.1.0.18` counts), and an optional pre-release/build/pseudo suffix (`-rc.1`, `+incompatible`,
 * a Go pseudo-version's `-20190718012654-abcdef`). A caret/tilde/range/wildcard has a leading operator or
 * `*`/`x` and therefore fails this test — it is a spec, not an exact version.
 */
export function isExactVersion(value: string): boolean {
  // A trailing `.x`/`.X`/`.*` (e.g. `1.x`, `1.2.x`) is a range, but the numeric-prefix test below would
  // otherwise accept it (the `.x` matches the optional suffix group). Reject it so a `1.x` pin surfaces
  // as a no-exact-version gap rather than silently passing as concrete.
  if (/^v?\d+(\.\d+)*\.[xX*]$/.test(value)) return false;
  return /^v?\d+(\.\d+){0,3}([-+.][0-9A-Za-z.-]+)?$/.test(value);
}

function basename(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function extension(relativePath: string): string {
  const name = basename(relativePath);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 1-based line of the first line containing `"<needle>"`; 1 when absent (e.g. minified single line). */
function lineOfKey(lines: string[], needle: string): number {
  const pattern = new RegExp(`"${escapeRegExp(needle)}"`);
  const index = lines.findIndex((line) => pattern.test(line));
  return index >= 0 ? index + 1 : 1;
}

/** Classify one version string into the exact/spec split every parser shares. */
function versionFields(raw: string | null | undefined): { version: string | null; versionSpec?: string } {
  if (!raw) return { version: null };
  const value = raw.trim();
  if (!value) return { version: null };
  return isExactVersion(value) ? { version: value } : { version: null, versionSpec: value };
}

// ---------------------------------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------------------------------

const NPM_DEP_SECTIONS: Array<[string, SoupScope]> = [
  ["dependencies", "runtime"],
  ["devDependencies", "dev"],
  ["peerDependencies", "runtime"],
  ["optionalDependencies", "runtime"]
];

const npmPackageJson: SoupParser = {
  ecosystem: "npm",
  id: "npm-package-json",
  source: "manifest",
  matches: (relativePath) => basename(relativePath) === "package.json",
  parse(content) {
    let json: Record<string, unknown>;
    try { json = JSON.parse(content) as Record<string, unknown>; }
    catch { return { items: [], notes: ["package.json did not parse as JSON; no components extracted"] }; }
    const lines = content.split(/\r?\n/);
    const items: SoupParsedItem[] = [];
    for (const [section, scope] of NPM_DEP_SECTIONS) {
      const deps = json[section];
      if (!deps || typeof deps !== "object") continue;
      for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
        const { version, versionSpec } = versionFields(String(spec));
        items.push({ name, version, ...(versionSpec ? { versionSpec } : {}), line: lineOfKey(lines, name), ...(scope === "dev" ? { scope } : {}) });
      }
    }
    const notes = items.length && lines.length <= 2 ? ["single-line JSON; evidence line numbers are approximate"] : [];
    return { items, notes };
  }
};

const npmPackageLock: SoupParser = {
  ecosystem: "npm",
  id: "npm-package-lock",
  source: "lockfile",
  matches: (relativePath) => basename(relativePath) === "package-lock.json",
  parse(content) {
    let json: Record<string, unknown>;
    try { json = JSON.parse(content) as Record<string, unknown>; }
    catch { return { items: [], notes: ["package-lock.json did not parse as JSON; no components extracted"] }; }
    const lockfileVersion = json.lockfileVersion;
    const packages = json.packages as Record<string, { version?: string; dev?: boolean }> | undefined;
    if (!packages || typeof packages !== "object") {
      return { items: [], notes: [`lockfileVersion ${lockfileVersion ?? "?"} not parsed (only the v2/v3 packages map is supported)`] };
    }
    const lines = content.split(/\r?\n/);
    const items: SoupParsedItem[] = [];
    const prefix = "node_modules/";
    for (const [key, meta] of Object.entries(packages)) {
      if (!key.startsWith(prefix) && !key.includes(`/${prefix}`)) continue; // skip root ("") and workspace roots
      const name = key.slice(key.lastIndexOf(prefix) + prefix.length);
      if (!name || !meta || typeof meta !== "object") continue;
      const { version, versionSpec } = versionFields(meta.version);
      if (version === null && versionSpec === undefined) continue; // link/workspace entry without a version
      items.push({ name, version, ...(versionSpec ? { versionSpec } : {}), line: lineOfKey(lines, key), ...(meta.dev === true ? { scope: "dev" } : {}) });
    }
    return { items, notes: [] };
  }
};

/** Strip a pnpm/yarn peer-deps suffix: `(react@18.0.0)` or `_react@18.0.0`. */
function stripPeerSuffix(value: string): string {
  const paren = value.indexOf("(");
  const trimmed = paren >= 0 ? value.slice(0, paren) : value;
  const underscore = trimmed.indexOf("_");
  return underscore >= 0 ? trimmed.slice(0, underscore) : trimmed;
}

/** Split a `name@version` (npm/pnpm/yarn) spec into name and version, honoring a leading `@scope`. */
function splitNameAtVersion(spec: string): { name: string; version: string } | null {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return null; // no version part, or a bare scope
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  return name && version ? { name, version } : null;
}

const npmPnpmLock: SoupParser = {
  ecosystem: "npm",
  id: "npm-pnpm-lock",
  source: "lockfile",
  matches: (relativePath) => basename(relativePath) === "pnpm-lock.yaml",
  parse(content) {
    const lines = content.split(/\r?\n/);
    const items: SoupParsedItem[] = [];
    let inPackages = false;
    let skipped = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\S/.test(line)) inPackages = /^packages:\s*$/.test(line); // a new top-level section ends `packages:`
      if (!inPackages) continue;
      const keyMatch = line.match(/^ {2}(['"]?)([^\s].*?)\1:\s*$/); // a package entry: two-space indented key ending in `:`
      if (!keyMatch) continue;
      const parsed = parsePnpmKey(keyMatch[2]);
      if (!parsed) { skipped += 1; continue; }
      const { version, versionSpec } = versionFields(parsed.version);
      items.push({ name: parsed.name, version, ...(versionSpec ? { versionSpec } : {}), line: index + 1 });
    }
    return { items, notes: skipped ? [`${skipped} pnpm package key(s) had an unrecognized shape and were skipped`] : [] };
  }
};

function parsePnpmKey(rawKey: string): { name: string; version: string } | null {
  const key = stripPeerSuffix(rawKey.trim().replace(/^['"]|['"]$/g, ""));
  if (key.startsWith("/")) {
    // pnpm <= v6: `/name/1.2.3` or `/@scope/name/1.2.3`
    const body = key.slice(1);
    const lastSlash = body.lastIndexOf("/");
    if (lastSlash <= 0) return null;
    const name = body.slice(0, lastSlash);
    const version = body.slice(lastSlash + 1);
    return name && version ? { name, version } : null;
  }
  // pnpm v9: `name@1.2.3` or `@scope/name@1.2.3`
  return splitNameAtVersion(key);
}

const npmYarnLock: SoupParser = {
  ecosystem: "npm",
  id: "npm-yarn-lock",
  source: "lockfile",
  matches: (relativePath) => basename(relativePath) === "yarn.lock",
  parse(content) {
    const lines = content.split(/\r?\n/);
    const items: SoupParsedItem[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      // Block header: a non-indented line that ends in `:` and is not the `__metadata` block.
      if (!/^\S/.test(line) || !line.trimEnd().endsWith(":") || line.startsWith("__metadata")) continue;
      const header = line.trimEnd().slice(0, -1);
      const firstSpec = header.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
      const name = yarnName(firstSpec);
      if (!name) continue;
      let version: string | null = null;
      for (let cursor = index + 1; cursor < lines.length && !/^\S/.test(lines[cursor]); cursor += 1) {
        const versionMatch = lines[cursor].match(/^ {2}version:?\s+"?([^"\s]+)"?/); // classic `version "x"` and berry `version: x`
        if (versionMatch) { version = versionMatch[1]; break; }
      }
      if (!version) continue;
      const { version: exact, versionSpec } = versionFields(version);
      items.push({ name, version: exact, ...(versionSpec ? { versionSpec } : {}), line: index + 1 });
    }
    return { items, notes: [] };
  }
};

/** Extract the package name from a yarn spec: `@babel/core@^7` -> `@babel/core`, `x@npm:1.2` -> `x`. */
function yarnName(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at <= 0 ? spec : spec.slice(0, at);
}

// ---------------------------------------------------------------------------------------------------
// NuGet
// ---------------------------------------------------------------------------------------------------

function attribute(line: string, attr: string): string | null {
  const match = line.match(new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`, "i"));
  return match ? match[1] : null;
}

const nugetCsproj: SoupParser = {
  ecosystem: "nuget",
  id: "nuget-csproj",
  source: "manifest",
  matches: (relativePath) => [".csproj", ".vbproj", ".fsproj"].includes(extension(relativePath)),
  parse(content) {
    const lines = content.split(/\r?\n/);
    const items: SoupParsedItem[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!/<PackageReference\b/i.test(line)) continue;
      const name = attribute(line, "Include");
      if (!name) continue;
      let versionRaw = attribute(line, "Version") ?? attribute(line, "VersionOverride");
      if (!versionRaw && !line.includes("/>")) {
        // Multi-line element: the version may sit in a <Version> child before </PackageReference>.
        for (let cursor = index + 1; cursor < lines.length && !/<\/PackageReference>/i.test(lines[cursor]); cursor += 1) {
          const child = lines[cursor].match(/<Version>([^<]+)<\/Version>/i);
          if (child) { versionRaw = child[1].trim(); break; }
        }
      }
      const { version, versionSpec } = versionFields(versionRaw);
      items.push({ name, version, ...(versionSpec ? { versionSpec } : {}), line: index + 1 });
    }
    return { items, notes: [] };
  }
};

const nugetProps: SoupParser = {
  ecosystem: "nuget",
  id: "nuget-props",
  source: "manifest",
  matches: (relativePath) => extension(relativePath) === ".props",
  parse(content) {
    const lines = content.split(/\r?\n/);
    const items: SoupParsedItem[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!/<PackageVersion\b/i.test(line)) continue;
      const name = attribute(line, "Include");
      if (!name) continue;
      const { version, versionSpec } = versionFields(attribute(line, "Version"));
      items.push({ name, version, ...(versionSpec ? { versionSpec } : {}), line: index + 1 });
    }
    return { items, notes: [] };
  }
};

const nugetPackagesConfig: SoupParser = {
  ecosystem: "nuget",
  id: "nuget-packages-config",
  source: "manifest",
  matches: (relativePath) => basename(relativePath) === "packages.config",
  parse(content) {
    const lines = content.split(/\r?\n/);
    const items: SoupParsedItem[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!/<package\b/i.test(line)) continue;
      const name = attribute(line, "id");
      if (!name) continue;
      const { version, versionSpec } = versionFields(attribute(line, "version"));
      const dev = (attribute(line, "developmentDependency") ?? "").toLowerCase() === "true";
      items.push({ name, version, ...(versionSpec ? { versionSpec } : {}), line: index + 1, ...(dev ? { scope: "dev" } : {}) });
    }
    return { items, notes: [] };
  }
};

const nugetSln: SoupParser = {
  ecosystem: "nuget",
  id: "nuget-sln",
  source: "manifest",
  matches: (relativePath) => extension(relativePath) === ".sln",
  parse: () => ({ items: [], notes: ["solution file recognized; it enumerates projects, not packages, so no components are emitted"] })
};

// ---------------------------------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------------------------------

/** Parse one PEP 508 requirement (`name[extras] OP version ; marker`) into name/version/spec. */
function parsePyRequirement(spec: string): { name: string; version: string | null; versionSpec?: string } | null {
  const withoutMarker = spec.split(";")[0].trim();
  if (!withoutMarker) return null;
  const match = withoutMarker.match(/^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(===|==|~=|!=|>=|<=|>|<)?\s*(.*)$/);
  if (!match) return null;
  const name = match[1];
  const operator = match[2];
  const value = (match[3] ?? "").trim().replace(/[,#].*$/, "").trim();
  if (!operator || !value) return { name, version: null };
  if (operator === "==" && isExactVersion(value)) return { name, version: value };
  return { name, version: null, versionSpec: `${operator}${value}` };
}

const pypiRequirements: SoupParser = {
  ecosystem: "pypi",
  id: "pypi-requirements",
  source: "manifest",
  matches: (relativePath) => basename(relativePath) === "requirements.txt",
  parse(content) {
    const lines = content.split(/\r?\n/);
    const items: SoupParsedItem[] = [];
    const notes: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("-r") || line.startsWith("--")) continue; // includes / global options
      if (line.startsWith("-e") || /^(git\+|https?:|file:)/.test(line)) {
        const egg = line.match(/[#&]egg=([A-Za-z0-9._-]+)/);
        if (egg) items.push({ name: egg[1], version: null, line: index + 1 });
        else notes.push(`line ${index + 1}: editable/URL requirement without #egg= name; skipped`);
        continue;
      }
      const parsed = parsePyRequirement(line);
      if (!parsed) continue;
      items.push({ name: parsed.name, version: parsed.version, ...(parsed.versionSpec ? { versionSpec: parsed.versionSpec } : {}), line: index + 1 });
    }
    return { items, notes };
  }
};

const pypiPyproject: SoupParser = {
  ecosystem: "pypi",
  id: "pypi-pyproject",
  source: "manifest",
  matches: (relativePath) => basename(relativePath) === "pyproject.toml",
  parse(content) {
    const lines = content.split(/\r?\n/);
    const items: SoupParsedItem[] = [];
    let section = "";
    let inProjectDeps = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const sectionMatch = line.match(/^\s*\[([^\]]+)\]/);
      if (sectionMatch) { section = sectionMatch[1].trim(); inProjectDeps = false; continue; }

      if (section === "project") {
        if (/^\s*dependencies\s*=\s*\[/.test(line)) inProjectDeps = true;
        if (inProjectDeps) {
          for (const literal of line.match(/"([^"]+)"|'([^']+)'/g) ?? []) {
            const parsed = parsePyRequirement(literal.slice(1, -1));
            if (parsed) items.push({ name: parsed.name, version: parsed.version, ...(parsed.versionSpec ? { versionSpec: parsed.versionSpec } : {}), line: index + 1 });
          }
          if (line.includes("]")) inProjectDeps = false;
        }
        continue;
      }

      const isPoetryDeps = section === "tool.poetry.dependencies"
        || section === "tool.poetry.dev-dependencies"
        || (section.startsWith("tool.poetry.group.") && section.endsWith(".dependencies"));
      if (!isPoetryDeps) continue;
      const scope: SoupScope | undefined = section === "tool.poetry.dependencies" ? undefined : "dev";
      const entry = line.match(/^\s*([A-Za-z0-9._-]+)\s*=\s*(.+?)\s*$/);
      if (!entry) continue;
      if (entry[1].toLowerCase() === "python") continue;
      const inline = entry[2].match(/^["']([^"']+)["']/) ?? entry[2].match(/version\s*=\s*["']([^"']+)["']/);
      if (!inline) continue; // git/path/complex dependency: no plain version to pin
      const { version, versionSpec } = versionFields(inline[1]);
      items.push({ name: entry[1], version, ...(versionSpec ? { versionSpec } : {}), line: index + 1, ...(scope ? { scope } : {}) });
    }
    return { items, notes: [] };
  }
};

const pypiPoetryLock: SoupParser = {
  ecosystem: "pypi",
  id: "pypi-poetry-lock",
  source: "lockfile",
  matches: (relativePath) => basename(relativePath) === "poetry.lock",
  parse(content) {
    const lines = content.split(/\r?\n/);
    const items: SoupParsedItem[] = [];
    let name: string | null = null;
    let version: string | null = null;
    let nameLine = 0;
    let inPackage = false;
    const flush = () => {
      if (name && version) {
        const fields = versionFields(version);
        items.push({ name, version: fields.version, ...(fields.versionSpec ? { versionSpec: fields.versionSpec } : {}), line: nameLine });
      }
      name = null; version = null;
    };
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*\[\[package\]\]/.test(line)) { flush(); inPackage = true; continue; }
      if (/^\s*\[/.test(line)) { flush(); inPackage = false; continue; }
      if (!inPackage) continue;
      const nameMatch = line.match(/^\s*name\s*=\s*["']([^"']+)["']/);
      if (nameMatch) { name = nameMatch[1]; nameLine = index + 1; }
      const versionMatch = line.match(/^\s*version\s*=\s*["']([^"']+)["']/);
      if (versionMatch) version = versionMatch[1];
    }
    flush();
    return { items, notes: [] };
  }
};

// ---------------------------------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------------------------------

const goMod: SoupParser = {
  ecosystem: "go",
  id: "go-mod",
  source: "manifest",
  matches: (relativePath) => basename(relativePath) === "go.mod",
  parse(content) {
    const lines = content.split(/\r?\n/);
    const items: SoupParsedItem[] = [];
    const notes: string[] = [];
    let inRequire = false;
    let sawReplace = false;
    const pushRequire = (text: string, line: number) => {
      const match = text.match(/^(\S+)\s+(v\S+)/);
      if (!match) return;
      const { version, versionSpec } = versionFields(match[2]);
      items.push({ name: match[1], version, ...(versionSpec ? { versionSpec } : {}), line });
    };
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index].replace(/\/\/.*$/, "").trim(); // drop `// indirect` and other comments
      if (inRequire) {
        if (text === ")") { inRequire = false; continue; }
        if (text) pushRequire(text, index + 1);
        continue;
      }
      if (/^require\s*\($/.test(text)) { inRequire = true; continue; }
      if (text.startsWith("require ")) pushRequire(text.slice("require ".length).trim(), index + 1);
      if (text.startsWith("replace ")) sawReplace = true;
    }
    if (sawReplace) notes.push("replace directive(s) present; original required versions are reported unmodified");
    return { items, notes };
  }
};

const goSum: SoupParser = {
  ecosystem: "go",
  id: "go-sum",
  source: "lockfile",
  matches: (relativePath) => basename(relativePath) === "go.sum",
  parse(content) {
    const lines = content.split(/\r?\n/);
    const items: SoupParsedItem[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].trim().match(/^(\S+)\s+(v[^\s/]+)(\/go\.mod)?\s+h1:/);
      if (!match) continue;
      const key = `${match[1]}@${match[2]}`;
      if (seen.has(key)) continue; // the `/go.mod` line duplicates the module line
      seen.add(key);
      const { version, versionSpec } = versionFields(match[2]);
      items.push({ name: match[1], version, ...(versionSpec ? { versionSpec } : {}), line: index + 1 });
    }
    return { items, notes: [] };
  }
};

// ---------------------------------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------------------------------

/** Split an image reference `name[:tag][@digest]` into its parts. Tag colon must follow the last slash. */
function parseImageRef(reference: string): { name: string; tag: string | null; digest: string | null } {
  let remainder = reference;
  let digest: string | null = null;
  const at = remainder.indexOf("@");
  if (at >= 0) { digest = remainder.slice(at + 1); remainder = remainder.slice(0, at); }
  let tag: string | null = null;
  const slash = remainder.lastIndexOf("/");
  const colon = remainder.lastIndexOf(":");
  if (colon > slash) { tag = remainder.slice(colon + 1); remainder = remainder.slice(0, colon); }
  return { name: remainder, tag, digest };
}

/** Turn an image reference into a component item; null when it is a variable, a stage alias, or empty. */
function imageItem(reference: string, line: number, stageAliases: Set<string>, notes: string[]): SoupParsedItem | null {
  if (!reference) return null;
  if (reference.includes("${") || reference.includes("$(")) { notes.push(`line ${line}: image reference uses a variable and was not resolved`); return null; }
  if (stageAliases.has(reference.toLowerCase())) return null; // a build stage referring to an earlier stage
  const { name, tag, digest } = parseImageRef(reference);
  if (!name) return null;
  const version = digest ? digest : (tag && tag.toLowerCase() !== "latest" ? tag : null);
  return { name, version, line };
}

const containerDockerfile: SoupParser = {
  ecosystem: "container",
  id: "container-dockerfile",
  source: "container",
  matches: (relativePath) => /^Dockerfile([.\-].*)?$/i.test(basename(relativePath)),
  parse(content) {
    const lines = content.split(/\r?\n/);
    const items: SoupParsedItem[] = [];
    const notes: string[] = [];
    const stageAliases = new Set<string>();
    for (let index = 0; index < lines.length; index += 1) {
      const fromMatch = lines[index].trim().match(/^FROM\s+(.+)$/i);
      if (!fromMatch) continue;
      const tokens = fromMatch[1].trim().split(/\s+/);
      let cursor = 0;
      while (cursor < tokens.length && tokens[cursor].startsWith("--")) cursor += 1; // skip --platform=...
      const reference = tokens[cursor];
      const asIndex = tokens.findIndex((token, position) => position > cursor && token.toLowerCase() === "as");
      const alias = asIndex >= 0 ? tokens[asIndex + 1]?.toLowerCase() : undefined;
      const item = imageItem(reference ?? "", index + 1, stageAliases, notes);
      if (alias) stageAliases.add(alias);
      if (item) items.push(item);
    }
    return { items, notes };
  }
};

const containerCompose: SoupParser = {
  ecosystem: "container",
  id: "container-compose",
  source: "container",
  matches: (relativePath) => /^(docker-)?compose[\w.-]*\.ya?ml$/i.test(basename(relativePath)),
  parse(content) {
    const lines = content.split(/\r?\n/);
    const items: SoupParsedItem[] = [];
    const notes: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(/^\s*image:\s*["']?([^"'\s#]+)/);
      if (!match) continue;
      const item = imageItem(match[1], index + 1, new Set(), notes);
      if (item) items.push(item);
    }
    return { items, notes };
  }
};

export const SOUP_PARSERS: readonly SoupParser[] = [
  npmPackageJson, npmPackageLock, npmPnpmLock, npmYarnLock,
  nugetCsproj, nugetProps, nugetPackagesConfig, nugetSln,
  pypiRequirements, pypiPyproject, pypiPoetryLock,
  goMod, goSum,
  containerDockerfile, containerCompose
];
