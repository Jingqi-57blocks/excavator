import { sha256, stableJson } from "../core/util.ts";
import { LANGUAGE_REGISTRY, isRegisteredExtension, nameClassIds, textualExtensions, type LanguageRegistry } from "./language-registry.ts";

/**
 * What can look at the corpus, at what granularity, and over which part of it.
 *
 * Layer 2 does not unify granularity — it unifies the ENVELOPE. A mechanism declares its `CoverageDomain` and
 * `UnitKind` first, and only file-domain mechanisms with a declared extension set get a (file x mechanism)
 * matrix; a module-pair resolver and a corpus census appear as declarations with no matrix rows, because
 * forcing them into a per-file grid would mean inventing per-file coverage they never claimed. That is also
 * why no ratio is published here and why a ratio across two domains is a forbidden input: `crossrepo` covering
 * 4 extensions and `search` covering 51 are not two numbers that may be added.
 *
 * `covered` means ONE thing: this mechanism's declared capability includes this row. It does NOT mean the
 * mechanism produced a fact about it. A framework pack that finds no Catalyst application on a Go target still
 * has `.pm` capability — its emptiness is a layer-3 `NotApplicable{not-detected}` determination, and a parse
 * failure on one file is a layer-3 warning. Folding either into layer 2 would make this ledger a report of
 * yields, which is exactly the "mechanism self-reports its coverage" input the contract forbids.
 *
 * The DEGRADED path is a mechanism of its own. `condition-regex-numeric` is registered separately from
 * `condition-ast` because it really runs on any text window (`condition-extract.ts` falls through to it), and
 * recording its successes under the AST mechanism's name is the precise lie the contract exists to prevent.
 */

export const MECHANISM_REGISTRY_VERSION = "mechanism-registry-v1";

/** The unit whose coverage the mechanism accounts for. A ratio may never cross two of these. */
export type CoverageDomain = "file" | "module" | "module-pair" | "corpus";

/** The granularity of what the mechanism produces, which is not the same as what it accounts for. */
export type MechanismUnitKind = "file" | "module" | "module-pair" | "corpus" | "node";

/**
 * What part of the corpus a mechanism can look at. A closed union, because the three answers are checked
 * differently: an extension list is cross-validated against the language registry, an external tool's language
 * names are validated as registered language ids, and "decided elsewhere" is a declaration that no set can be
 * stated here honestly.
 */
export type MechanismSupport =
  /** Extensions the mechanism's own code branches on. Every one must be a registered extension. */
  | { kind: "extensions"; extensions: readonly string[] }
  /** Language names handed to an external tool. Each must be a registered language id, lowercased. */
  | { kind: "tool-languages"; languages: readonly string[] }
  /**
   * Coverage is determined outside this repository. `codegraph` is the case: its language coverage comes from
   * whatever the external indexer wrote, and reading that back out of the database would be the mechanism
   * reporting its own coverage — a forbidden input. So it declares no set and takes no matrix rows.
   */
  | { kind: "externally-determined" };

export const MECHANISM_IDS = [
  "codegraph",
  "condition-ast",
  "condition-ast-perl",
  "condition-regex-numeric",
  "crossrepo",
  "ctags-census",
  "db-schema",
  "decision-probe",
  "framework",
  "native-graph",
  "search"
] as const;

export type MechanismId = typeof MECHANISM_IDS[number];

export interface MechanismEntry {
  id: MechanismId;
  /** Says what the mechanism actually is, degradation included — read by whoever reads the ledger. */
  title: string;
  version: string;
  coverageDomain: CoverageDomain;
  unitKind: MechanismUnitKind;
  support: MechanismSupport;
  /**
   * Name classes supported beyond the extension list. Required, never optional: content search's `README`
   * exception is a real property of its corpus, and a field that may be omitted is a field that gets
   * forgotten on the next mechanism.
   */
  nameClasses: readonly string[];
  /**
   * Largest file the mechanism will look at, or `null` for no bound. Required for the same reason: a bound
   * that nobody declared is a bound nobody accounts for, and content search has had one (500 KB) all along.
   */
  maxFileBytes: number | null;
}

export interface MechanismRegistry {
  version: string;
  mechanisms: MechanismEntry[];
}

/** Availability of one mechanism's runtime dependency, as observed by the orchestrator for THIS run. */
export type MechanismAvailability =
  | { status: "available" }
  | { status: "unavailable"; cause: string };

/**
 * Availability for every registered mechanism. A `Record` over the literal id union rather than a partial map,
 * so adding a mechanism is a compile error in the collector instead of a silently missing row.
 */
export type MechanismAvailabilityMap = Record<MechanismId, MechanismAvailability>;

/** The seven extensions ast-grep resolves to a grammar today; the key set of `AST_LANGUAGE_BY_EXTENSION`. */
const AST_GREP_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go"] as const;
/** The tree-sitter Perl backend's extensions; `PERL_EXTENSIONS` in `condition-extract.ts`. */
const PERL_EXTENSIONS = [".pm", ".pl", ".t", ".cgi", ".psgi"] as const;

const MECHANISMS: MechanismEntry[] = [
  {
    id: "search",
    title: "Literal and regex content search over the scanned corpus",
    version: "search-v1",
    coverageDomain: "file",
    unitKind: "file",
    support: { kind: "extensions", extensions: [...textualExtensions()] },
    // README is in the corpus by NAME, not by extension: `README`, `README.txt` and `license.txt` are all
    // counted rows, and only the readme ones are searchable today. Declaring the class is what makes that
    // difference a row in the ledger instead of an accident in a predicate.
    nameClasses: ["readme"],
    // The mechanism refuses files above this size, so those rows are `no-mechanism`, not `covered`.
    maxFileBytes: 500_000
  },
  {
    id: "decision-probe",
    title: "Structural decision probe: does this span branch at all",
    version: "decision-probe-v1",
    coverageDomain: "file",
    unitKind: "node",
    support: { kind: "extensions", extensions: [...AST_GREP_EXTENSIONS] },
    nameClasses: [],
    maxFileBytes: null
  },
  {
    id: "condition-ast",
    title: "Literal-comparison extraction via ast-grep",
    version: "condition-ast-v1",
    coverageDomain: "file",
    unitKind: "node",
    support: { kind: "extensions", extensions: [...AST_GREP_EXTENSIONS] },
    nameClasses: [],
    maxFileBytes: null
  },
  {
    id: "condition-ast-perl",
    title: "Literal-comparison extraction via the tree-sitter Perl backend",
    version: "condition-ast-perl-v1",
    coverageDomain: "file",
    unitKind: "node",
    support: { kind: "extensions", extensions: [...PERL_EXTENSIONS] },
    nameClasses: [],
    maxFileBytes: null
  },
  {
    id: "condition-regex-numeric",
    title: "DEGRADED numeric-only comparison extraction by regex, over any text window",
    version: "condition-regex-numeric-v1",
    coverageDomain: "file",
    unitKind: "node",
    // Declared over the whole textual corpus because that is where it really runs: `extractComparisons` falls
    // through to it for every window no structural backend claimed. Narrowing it to "languages where it is
    // useful" would be layer 2 exercising judgement it has no basis for.
    support: { kind: "extensions", extensions: [...textualExtensions()] },
    nameClasses: [],
    maxFileBytes: null
  },
  {
    id: "native-graph",
    title: "Native tree-sitter Perl graph plus Zope template inventory",
    version: "native-graph-v1",
    coverageDomain: "file",
    unitKind: "node",
    support: { kind: "extensions", extensions: [...PERL_EXTENSIONS, ".zpt", ".dtml"] },
    nameClasses: [],
    maxFileBytes: null
  },
  {
    id: "framework",
    title: "Framework convention recovery (routes, components) from pack rules",
    version: "framework-v1",
    coverageDomain: "file",
    unitKind: "node",
    support: { kind: "extensions", extensions: [".pm"] },
    nameClasses: [],
    maxFileBytes: null
  },
  {
    id: "db-schema",
    title: "Database schema discovery across ORM, migration and SQL dialects",
    version: "db-schema-v1",
    coverageDomain: "file",
    unitKind: "node",
    support: { kind: "extensions", extensions: [".go", ".js", ".cjs", ".mjs", ".sql", ".ts", ".tsx", ".mts", ".cts", ".py", ".rb"] },
    nameClasses: [],
    maxFileBytes: null
  },
  {
    id: "crossrepo",
    title: "Cross-repository HTTP link resolution between a caller and a route",
    version: "crossrepo-v1",
    // A resolved link has two ends in two modules. There is no per-file coverage to state, so this mechanism
    // declares its domain and takes no matrix rows — the alternative is a grid of half-truths.
    coverageDomain: "module-pair",
    unitKind: "module-pair",
    support: { kind: "extensions", extensions: [".go", ".js", ".ts", ".tsx"] },
    nameClasses: [],
    maxFileBytes: null
  },
  {
    id: "ctags-census",
    title: "Universal Ctags definition census over the whole target",
    version: "ctags-census-v1",
    coverageDomain: "corpus",
    unitKind: "corpus",
    support: { kind: "tool-languages", languages: ["html", "javascript", "perl", "python", "sql"] },
    nameClasses: [],
    maxFileBytes: null
  },
  {
    id: "codegraph",
    title: "CodeGraph index queries; language coverage decided by the external indexer",
    version: "codegraph-v1",
    coverageDomain: "file",
    unitKind: "node",
    support: { kind: "externally-determined" },
    nameClasses: [],
    maxFileBytes: null
  }
];

export const MECHANISM_REGISTRY: MechanismRegistry = {
  version: MECHANISM_REGISTRY_VERSION,
  mechanisms: MECHANISMS
};

/**
 * A file-domain mechanism with a declared extension set: the only shape that gets matrix rows.
 *
 * Narrowed as a TYPE rather than checked with a boolean, so the matrix builder cannot be handed a corpus
 * census or an externally-determined mechanism and quietly produce rows for it.
 */
export interface FileMatrixMechanism extends MechanismEntry {
  coverageDomain: "file";
  support: { kind: "extensions"; extensions: readonly string[] };
}

export function fileMatrixMechanisms(registry: MechanismRegistry = MECHANISM_REGISTRY): FileMatrixMechanism[] {
  return registry.mechanisms.filter((entry): entry is FileMatrixMechanism =>
    entry.coverageDomain === "file" && entry.support.kind === "extensions");
}

/**
 * The extension set one mechanism declares. Throws for a mechanism that declares none, because the caller is
 * asking for a corpus to iterate and an empty answer would silently disable it rather than fail.
 */
export function declaredExtensions(id: MechanismId, registry: MechanismRegistry = MECHANISM_REGISTRY): ReadonlySet<string> {
  const support = mechanismById(id, registry).support;
  if (support.kind !== "extensions") throw new Error(`Mechanism ${JSON.stringify(id)} declares no extension set (support kind ${support.kind})`);
  return new Set(support.extensions);
}

export function mechanismById(id: MechanismId, registry: MechanismRegistry = MECHANISM_REGISTRY): MechanismEntry {
  const entry = registry.mechanisms.find((mechanism) => mechanism.id === id);
  if (!entry) throw new Error(`Mechanism ${JSON.stringify(id)} is not registered`);
  return entry;
}

/**
 * The counter-tripwire, run at module load.
 *
 * The registry's whole claim is "a mechanism cannot support a file type the scanner does not admit". That
 * claim needs a check that fails, not a comment: `.pod` and `.pt` sat in `nativegraph/build.ts` as dead
 * branches for exactly as long as nobody compared the two lists. Throwing at import means a mechanism whose
 * support set drifts from the corpus cannot be loaded at all, so no run can be prepared on a lie.
 */
export function validateMechanismRegistry(registry: MechanismRegistry, languages: LanguageRegistry = LANGUAGE_REGISTRY): void {
  const seen = new Set<string>();
  const classes = new Set(nameClassIds());
  const languageIds = new Set(languages.extensions.map((entry) => entry.language));
  for (const mechanism of registry.mechanisms) {
    if (seen.has(mechanism.id)) throw new Error(`Mechanism ${JSON.stringify(mechanism.id)} is registered twice`);
    seen.add(mechanism.id);
    if (!mechanism.title.trim()) throw new Error(`Mechanism ${JSON.stringify(mechanism.id)} declares no title`);
    if (!mechanism.version.trim()) throw new Error(`Mechanism ${JSON.stringify(mechanism.id)} declares no version`);
    if (mechanism.maxFileBytes !== null && !(mechanism.maxFileBytes > 0)) {
      throw new Error(`Mechanism ${JSON.stringify(mechanism.id)} declares a non-positive size bound ${mechanism.maxFileBytes}`);
    }
    for (const id of mechanism.nameClasses) {
      if (!classes.has(id)) throw new Error(`Mechanism ${JSON.stringify(mechanism.id)} claims support for unregistered name class ${JSON.stringify(id)}`);
    }
    switch (mechanism.support.kind) {
      case "extensions": {
        if (!mechanism.support.extensions.length) throw new Error(`Mechanism ${JSON.stringify(mechanism.id)} declares an empty extension set; use externally-determined instead`);
        for (const ext of mechanism.support.extensions) {
          if (!isRegisteredExtension(ext)) {
            throw new Error(`Mechanism ${JSON.stringify(mechanism.id)} claims support for unregistered extension ${JSON.stringify(ext)}; register it in language-registry.ts or drop the branch that consumes it`);
          }
        }
        break;
      }
      case "tool-languages": {
        if (!mechanism.support.languages.length) throw new Error(`Mechanism ${JSON.stringify(mechanism.id)} declares an empty tool-language set`);
        for (const language of mechanism.support.languages) {
          if (!languageIds.has(language)) {
            throw new Error(`Mechanism ${JSON.stringify(mechanism.id)} hands its tool the language ${JSON.stringify(language)}, which is not a registered language id`);
          }
        }
        break;
      }
      case "externally-determined":
        break;
      default:
        throw new Error(`Mechanism ${JSON.stringify(mechanism.id)} declares an unhandled support kind`);
    }
  }
  const registered = new Set(registry.mechanisms.map((mechanism) => mechanism.id));
  for (const id of MECHANISM_IDS) {
    if (!registered.has(id)) throw new Error(`Mechanism id ${JSON.stringify(id)} is declared in MECHANISM_IDS but has no registry entry`);
  }
}

validateMechanismRegistry(MECHANISM_REGISTRY, LANGUAGE_REGISTRY);

/** Digest over the declared content. A mechanism version bump or a support change moves it. */
export function mechanismRegistryDigest(registry: MechanismRegistry = MECHANISM_REGISTRY): string {
  return sha256(stableJson(registry));
}
