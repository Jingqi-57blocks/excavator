// Versioned scanner boundary registry.
//
// The scan boundary is part of a snapshot's identity: it decides which files enter the manifest and
// therefore the `sourceManifestDigest`. Because audit re-derives a run's snapshot to detect drift, the
// boundary that produced a historical snapshot must remain reconstructable forever — otherwise widening
// it would retroactively change every old snapshot's identity and fail its re-audit ("source snapshot
// changed").
//
// The boundary has two dimensions, both frozen per version here:
//   1. `extensions`       — the source-scan whitelist by file extension (`SOURCE_EXTENSIONS`).
//   2. `projectFileNames` — manifest/build/lockfile files admitted by exact name, not by extension
//                           (`PROJECT_FILE_NAMES`), e.g. `package.json`, `go.sum`.
// A snapshot records its `scannerVersion`; audit resolves that exact boundary to rebuild the historical
// scan, while new runs always use the current version. Both sets are monotone — `v(n+1) ⊇ v(n)` —
// enforced by tests, so no file a version scanned ever stops being scanned in a later version.
//
// Frozen sets are contracts: never edit a past version's literal. Adding scope means adding a new
// version whose sets are supersets of the previous, then pointing `CURRENT_SCANNER_VERSION` at it.

export const SCANNER_VERSION_V1 = "git-aware-source-boundary-v1";
export const SCANNER_VERSION_V2 = "git-aware-source-boundary-v2";
export const SCANNER_VERSION_V3 = "git-aware-source-boundary-v3";

/** Frozen v1 boundary — the exact 44 extensions scanned before the v2 expansion. Never edit. */
const V1_EXTENSIONS: readonly string[] = [
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".go", ".py", ".java", ".kt", ".kts", ".rb", ".php",
  ".cs", ".fs", ".rs", ".c", ".h", ".cc", ".cpp", ".hpp", ".swift", ".scala", ".vue", ".svelte", ".sql",
  ".yaml", ".yml", ".json", ".toml", ".xml", ".html", ".css", ".scss", ".md", ".sh", ".proto", ".graphql", ".gql", ".tf", ".hcl", ".astro"
];

// v2 adds 26 extensions by *class* (never by vendor): UI markup, BDD specs, project/build files,
// resource/localization, plain-text config, scripts and documentation. Formats that are frequently
// binary or tabular (.svg, .csv, .log, .lock) are deliberately excluded — the boundary census sniffs
// and reports those instead of guessing they are searchable text.
const V2_ADDED: readonly string[] = [
  // UI markup
  ".xaml", ".axaml", ".storyboard", ".xib",
  // BDD specifications
  ".feature",
  // project / build
  ".csproj", ".fsproj", ".vbproj", ".sln", ".props", ".targets", ".gradle",
  // resource / localization
  ".resx", ".strings", ".plist",
  // plain-text configuration
  ".ini", ".properties", ".cfg", ".conf",
  // scripts
  ".ps1", ".psm1", ".bat", ".cmd",
  // documentation
  ".txt", ".rst", ".adoc"
];

/** Frozen v1/v2 project-file-name set — manifest/build files admitted by exact name. Never edit. */
const V1_PROJECT_FILE_NAMES: readonly string[] = [
  "package.json", "go.mod", "Cargo.toml", "pyproject.toml", "requirements.txt", "pom.xml",
  "build.gradle", "build.gradle.kts", "Gemfile", "composer.json", "docker-compose.yml", "docker-compose.yaml"
];

// v3 admits SOUP lockfiles by name so the inventory can read exact pins. Their extension classes
// (.lock/.sum/.config) stay out of SOURCE_EXTENSIONS and the search corpus on purpose — they are
// data files SOUP reads directly, not searchable prose (see docs/pending-decisions.md).
const V3_PROJECT_FILE_NAMES_ADDED: readonly string[] = ["yarn.lock", "poetry.lock", "go.sum", "packages.config"];

export const CURRENT_SCANNER_VERSION = SCANNER_VERSION_V3;

export interface ScannerBoundary {
  extensions: ReadonlySet<string>;
  projectFileNames: ReadonlySet<string>;
}

const REGISTRY: ReadonlyMap<string, ScannerBoundary> = new Map([
  [SCANNER_VERSION_V1, { extensions: new Set(V1_EXTENSIONS), projectFileNames: new Set(V1_PROJECT_FILE_NAMES) }],
  [SCANNER_VERSION_V2, { extensions: new Set([...V1_EXTENSIONS, ...V2_ADDED]), projectFileNames: new Set(V1_PROJECT_FILE_NAMES) }],
  [SCANNER_VERSION_V3, { extensions: new Set([...V1_EXTENSIONS, ...V2_ADDED]), projectFileNames: new Set([...V1_PROJECT_FILE_NAMES, ...V3_PROJECT_FILE_NAMES_ADDED]) }]
]);

/** Resolve a scanner version to its frozen boundary; throw deterministically on an unknown one. */
export function resolveScannerBoundary(version: string): ScannerBoundary {
  const boundary = REGISTRY.get(version);
  if (!boundary) throw new Error(`Unknown scanner version: ${version} (known: ${[...REGISTRY.keys()].join(", ")})`);
  return boundary;
}

/** The frozen extension whitelist for a scanner version. */
export function resolveScannerVersion(version: string): ReadonlySet<string> {
  return resolveScannerBoundary(version).extensions;
}

/** The frozen by-name project-file whitelist for a scanner version. */
export function resolveProjectFileNames(version: string): ReadonlySet<string> {
  return resolveScannerBoundary(version).projectFileNames;
}

/** The current source-scan whitelist, re-exported by snapshot.ts for backward compatibility. */
export const SOURCE_EXTENSIONS: ReadonlySet<string> = resolveScannerVersion(CURRENT_SCANNER_VERSION);

/** The current by-name project-file whitelist, re-exported by snapshot.ts. */
export const PROJECT_FILE_NAMES: ReadonlySet<string> = resolveProjectFileNames(CURRENT_SCANNER_VERSION);
