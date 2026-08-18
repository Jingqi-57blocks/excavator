import { LANGUAGE_REGISTRY, type LanguageRegistry } from "./language-registry.ts";
import { MECHANISM_IDS, type MechanismId } from "./mechanism-registry.ts";
import { assertNever } from "./artifact-result.ts";
import { sha256, stableJson } from "./util.ts";

/**
 * Which builder produces the canonical partition for each language — declared, per language, before any run.
 *
 * `docs/layering.md` §一 ("分区由指定构建器产出，观察者不得改分区") resolves a contradiction the contract had with
 * itself: the denominator law says adding or removing a fact producer must not change the existing partition,
 * while §六's granularity ladder said "project onto the partition where an index exists, fall back to the file
 * where it does not" — which makes the partition a FUNCTION of which optional tool happened to load. One
 * optional tool flickering would then replace the whole denominator and a large set of `UnitId`s.
 *
 * The split this table encodes: a language's partition granularity is declared HERE and nowhere else. If the
 * designated builder's runtime dependency is missing for a run that has files in that language, layer 3's
 * envelope is `Unavailable` — never a quietly coarser partition. A language designated `file-level` gets one
 * residual cell per file, and that is a DECLARED coverage gap visible in `mechanisms.json`, not an accident.
 *
 * Adding a builder, or changing one's algorithm, is a partition SCHEMA GENERATION: `UnitId`s are not comparable
 * across versions, so it moves `PARTITION_DESIGNATION_VERSION` and runs through a new epoch rather than
 * refining an existing partition in place.
 *
 * The completeness check at the bottom runs at import. It is the reason "we added a language and forgot to say
 * how it is partitioned" cannot be a silent hole: the module fails to load, so no run can be prepared on it.
 */

/**
 * The designation table's own version, and the partition schema generation with it.
 *
 * One version for both because they cannot move independently: the only ways this table changes are adding a
 * builder, retargeting a language, or changing a builder's algorithm, and every one of them makes old `UnitId`s
 * incomparable to new ones.
 */
export const PARTITION_DESIGNATION_VERSION = "units-partition-v1";

/**
 * Who partitions a file. Two arms, because they are checked differently: a mechanism must be registered and its
 * availability is observed per run, while `file-level` is a declaration that no structural builder exists for
 * this language and the file is therefore one residual cell.
 */
export type PartitionBuilder =
  | { readonly kind: "mechanism"; readonly mechanism: MechanismId }
  | { readonly kind: "file-level" };

const AST: PartitionBuilder = { kind: "mechanism", mechanism: "partition-ast" };
const FILE_LEVEL: PartitionBuilder = { kind: "file-level" };

/**
 * Language → designated builder. EVERY language the corpus registry knows appears here, including the languages
 * that only exist as name classes (`build-metadata`, `dockerfile`, …) — a counted `Makefile` needs a partition
 * just as much as a counted `.ts` file does.
 *
 * The first batch is the three languages ast-grep already resolves to a grammar in this repository. Everything
 * else is `file-level` BY DECLARATION. Perl is the loud case: 1366 `.pm` files on the provital target become
 * 1366 single-residual partitions with a stated reason, which is the honest shape — inventing a Perl builder
 * here would be inventing structure nothing in this repository can see.
 */
const DESIGNATION: Record<string, PartitionBuilder> = {
  "typescript": AST,
  "javascript": AST,
  "go": AST,

  "astro": FILE_LEVEL,
  "c": FILE_LEVEL,
  "cpp": FILE_LEVEL,
  "csharp": FILE_LEVEL,
  "css": FILE_LEVEL,
  "dtml": FILE_LEVEL,
  "fsharp": FILE_LEVEL,
  "graphql": FILE_LEVEL,
  "hcl": FILE_LEVEL,
  "html": FILE_LEVEL,
  "java": FILE_LEVEL,
  "json": FILE_LEVEL,
  "kotlin": FILE_LEVEL,
  "markdown": FILE_LEVEL,
  "perl": FILE_LEVEL,
  "php": FILE_LEVEL,
  "protobuf": FILE_LEVEL,
  "python": FILE_LEVEL,
  "ruby": FILE_LEVEL,
  "rust": FILE_LEVEL,
  "scala": FILE_LEVEL,
  "scss": FILE_LEVEL,
  "shell": FILE_LEVEL,
  "sql": FILE_LEVEL,
  "svelte": FILE_LEVEL,
  "swift": FILE_LEVEL,
  "terraform": FILE_LEVEL,
  "toml": FILE_LEVEL,
  "vue": FILE_LEVEL,
  "xml": FILE_LEVEL,
  "yaml": FILE_LEVEL,
  "zope-page-template": FILE_LEVEL,

  // The name-class languages. They have no extension of their own, which is exactly why they get forgotten.
  "build-metadata": FILE_LEVEL,
  "dockerfile": FILE_LEVEL,
  "documentation": FILE_LEVEL,
  "dotenv": FILE_LEVEL,
  "make": FILE_LEVEL,
  "process-manifest": FILE_LEVEL
};

export interface PartitionDesignation {
  readonly version: string;
  readonly byLanguage: Readonly<Record<string, PartitionBuilder>>;
}

export const PARTITION_DESIGNATION: PartitionDesignation = {
  version: PARTITION_DESIGNATION_VERSION,
  byLanguage: DESIGNATION
};

/**
 * The designated builder for one language. Throws for a language the table does not cover, which the load-time
 * check makes unreachable for any REGISTERED language — the throw is there for the caller who passes a language
 * it invented, and it is a bug in that caller, not a coverage gap to be smoothed over with a default.
 */
export function designatedBuilder(language: string, designation: PartitionDesignation = PARTITION_DESIGNATION): PartitionBuilder {
  const builder = designation.byLanguage[language];
  if (!builder) throw new Error(`No partition builder is designated for language ${JSON.stringify(language)}; declare one in partition-designation.ts`);
  return builder;
}

/** Every language whose designated builder is one particular mechanism; used to decide the run's gate. */
export function languagesOfBuilder(mechanism: MechanismId, designation: PartitionDesignation = PARTITION_DESIGNATION): ReadonlySet<string> {
  return new Set(Object.entries(designation.byLanguage)
    .filter(([, builder]) => builder.kind === "mechanism" && builder.mechanism === mechanism)
    .map(([language]) => language));
}

/** Every language the corpus registry knows — extensions AND name classes. The set this table must cover. */
export function registeredLanguages(languages: LanguageRegistry = LANGUAGE_REGISTRY): ReadonlySet<string> {
  return new Set([
    ...languages.extensions.map((entry) => entry.language),
    ...languages.nameClasses.map((entry) => entry.language)
  ]);
}

/**
 * The load-time completeness check, in both directions.
 *
 * Forward: a registered language with no designation would reach `designatedBuilder` and throw mid-run, or
 * worse, get a default. Backward: a designation for a language the registry does not have is a dead row that
 * reads like support — the same shape as `.pod` and `.pt` sitting in `nativegraph/build.ts` as dead branches
 * for as long as nobody compared the two lists.
 */
export function validatePartitionDesignation(
  designation: PartitionDesignation = PARTITION_DESIGNATION,
  languages: LanguageRegistry = LANGUAGE_REGISTRY
): void {
  const registered = registeredLanguages(languages);
  const declared = new Set(Object.keys(designation.byLanguage));
  const missing = [...registered].filter((language) => !declared.has(language)).sort();
  if (missing.length) {
    throw new Error(`No partition builder is designated for registered language(s) ${missing.join(", ")}; every language the scanner admits must declare its partition granularity`);
  }
  const phantom = [...declared].filter((language) => !registered.has(language)).sort();
  if (phantom.length) {
    throw new Error(`Partition designation names unregistered language(s) ${phantom.join(", ")}; a designation the corpus can never yield is a dead row that reads like support`);
  }
  const mechanisms = new Set<string>(MECHANISM_IDS);
  for (const [language, builder] of Object.entries(designation.byLanguage)) {
    switch (builder.kind) {
      case "mechanism":
        if (!mechanisms.has(builder.mechanism)) {
          throw new Error(`Language ${JSON.stringify(language)} designates unregistered mechanism ${JSON.stringify(builder.mechanism)} as its partition builder`);
        }
        break;
      case "file-level":
        break;
      default:
        assertNever(builder, "partition builder");
    }
  }
  if (!designation.version.trim()) throw new Error("The partition designation table must declare its version; it is the partition schema generation");
}

validatePartitionDesignation(PARTITION_DESIGNATION, LANGUAGE_REGISTRY);

/** Digest over the declared table. Retargeting one language is a partition schema generation, and this says so. */
export function partitionDesignationDigest(designation: PartitionDesignation = PARTITION_DESIGNATION): string {
  return sha256(stableJson(designation));
}
