// Versioned scanner boundary registry.
//
// The source-scan whitelist (`SOURCE_EXTENSIONS`) is part of a snapshot's identity: it decides which
// files enter the manifest and therefore the `sourceManifestDigest`. Because audit re-derives a run's
// snapshot to detect drift, the whitelist that produced a historical snapshot must remain
// reconstructable forever — otherwise widening the whitelist would retroactively change every old
// snapshot's identity and fail its re-audit ("source snapshot changed").
//
// So every scanner version freezes its extension set as an immutable literal here. A snapshot records
// its `scannerVersion`; audit resolves that exact set to rebuild the historical boundary, while new
// runs always use the current version. The sets are monotone — `v(n+1) ⊇ v(n)` — enforced by tests,
// so no file that a version scanned ever stops being scanned in a later version.
//
// Frozen sets are contracts: never edit a past version's literal. Adding scope means adding a new
// version whose set is a superset of the previous, then pointing `CURRENT_SCANNER_VERSION` at it.

export const SCANNER_VERSION_V1 = "git-aware-source-boundary-v1";
export const SCANNER_VERSION_V2 = "git-aware-source-boundary-v2";

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

export const CURRENT_SCANNER_VERSION = SCANNER_VERSION_V2;

const REGISTRY: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [SCANNER_VERSION_V1, new Set(V1_EXTENSIONS)],
  [SCANNER_VERSION_V2, new Set([...V1_EXTENSIONS, ...V2_ADDED])]
]);

/** Resolve a scanner version to its frozen extension set; throw deterministically on an unknown one. */
export function resolveScannerVersion(version: string): ReadonlySet<string> {
  const set = REGISTRY.get(version);
  if (!set) throw new Error(`Unknown scanner version: ${version} (known: ${[...REGISTRY.keys()].join(", ")})`);
  return set;
}

/** The current source-scan whitelist, re-exported by snapshot.ts for backward compatibility. */
export const SOURCE_EXTENSIONS: ReadonlySet<string> = resolveScannerVersion(CURRENT_SCANNER_VERSION);
