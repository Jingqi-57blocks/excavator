import { sha256, stableJson } from "./util.ts";

/**
 * The one place that says what the corpus IS: which file types the scanner admits, and what each one is.
 *
 * Before this, "which languages does Excavator see" was answered by six sets in five files that nobody
 * cross-checked — and they had already drifted: `nativegraph/build.ts` consumed `.pod` and `.pt`, neither of
 * which was in `SOURCE_EXTENSIONS`, so `scanFiles` could never hand it one. Two dead branches that looked
 * like Perl POD and Zope page-template support. The registry does not prevent that by discipline; it prevents
 * it by being the projection every consumer reads, plus a consistency test that fails when an adapter's set
 * is not a subset of the scanned corpus.
 *
 * Two things deliberately stay OUT of here:
 *
 *  - Adapter vocabulary. An ast-grep language id (`Tsx`), a ctags language name (`Perl`) and a tree-sitter
 *    grammar handle are each one mechanism's internal dialect; pulling them into the base would couple the
 *    corpus definition to every mechanism's implementation. They live in their adapters and are proven
 *    key-set-identical to a registry projection by test.
 *  - Which mechanism supports what. That is `mechanism-registry.ts`, and keeping it separate is what stops a
 *    new language from moving the artifact-contract digest: the corpus is not the artifact set.
 *
 * NAME CLASSES exist because a file's extension is not always what admits it. `Dockerfile.provital-zms-dev`,
 * `go.mod`, `README.txt`, `LICENSE`, `Makefile` and `.env.sample` are all counted rows on real targets whose
 * extension (`.provital-zms-dev`, `.mod`, `.txt`, ``, ``, `.sample`) is NOT a registered language. Measured:
 * provital has 16 such rows across 8 extension groups, wcp 11 across 5. A registry that only knew extensions
 * would have to call those rows unregistered and either drop them (breaking layer 2's conservation against
 * the layer-1 denominator) or invent a bucket for them.
 */

export const LANGUAGE_REGISTRY_VERSION = "language-registry-v1";

export interface LanguageEntry {
  /** Lowercase, with the leading dot, exactly as `extname().toLowerCase()` produces it. */
  extension: string;
  /** Our vocabulary, never an adapter's: `typescript`, not `Tsx`. Groups the `byLanguage` census. */
  language: string;
  /**
   * Whether the bytes are UTF-8 text. Every scanned extension is text today; the flag exists so that adding a
   * binary extension to the scanner is a declared exception here rather than a silent "scanned but
   * unsearchable" divergence (the shape `tests/search-corpus.test.ts` has been pinning since 57B-347).
   */
  textual: boolean;
}

/** How a name class recognises a file. Data, never a function, so the registry digest covers the rule itself. */
export type NameRule =
  /** Case-sensitive whole-name match, the shape `PROJECT_FILE_NAMES` has always had. */
  | { kind: "exact"; names: readonly string[] }
  /** Case-insensitive prefix/whole-name pattern; the source is stored so it enters the digest. */
  | { kind: "pattern"; pattern: string };

export interface NameClassEntry {
  /** Stable id; a mechanism declares support by naming it, so it never changes silently. */
  id: string;
  language: string;
  textual: boolean;
  rule: NameRule;
}

export interface LanguageRegistry {
  version: string;
  extensions: LanguageEntry[];
  nameClasses: NameClassEntry[];
}

function extension(ext: string, language: string): LanguageEntry {
  return { extension: ext, language, textual: true };
}

/**
 * Every extension the scanner admits, in the order the former `SOURCE_EXTENSIONS` literal listed them. The
 * order is preserved so `scannedExtensions()` iterates identically to the set it replaces; membership is what
 * the identity test pins, but an unchanged iteration order keeps any incidental consumer unchanged too.
 */
const EXTENSIONS: LanguageEntry[] = [
  extension(".ts", "typescript"), extension(".tsx", "typescript"), extension(".mts", "typescript"), extension(".cts", "typescript"),
  extension(".js", "javascript"), extension(".jsx", "javascript"), extension(".mjs", "javascript"), extension(".cjs", "javascript"),
  extension(".go", "go"),
  extension(".py", "python"),
  extension(".java", "java"),
  extension(".kt", "kotlin"), extension(".kts", "kotlin"),
  extension(".rb", "ruby"),
  extension(".php", "php"),
  extension(".cs", "csharp"),
  extension(".fs", "fsharp"),
  extension(".rs", "rust"),
  extension(".c", "c"), extension(".h", "c"),
  extension(".cc", "cpp"), extension(".cpp", "cpp"), extension(".hpp", "cpp"),
  extension(".swift", "swift"),
  extension(".scala", "scala"),
  extension(".vue", "vue"),
  extension(".svelte", "svelte"),
  extension(".sql", "sql"),
  extension(".yaml", "yaml"), extension(".yml", "yaml"),
  extension(".json", "json"),
  extension(".toml", "toml"),
  extension(".xml", "xml"),
  extension(".html", "html"),
  extension(".css", "css"), extension(".scss", "scss"),
  extension(".md", "markdown"),
  extension(".sh", "shell"),
  extension(".proto", "protobuf"),
  extension(".graphql", "graphql"), extension(".gql", "graphql"),
  extension(".tf", "terraform"), extension(".hcl", "hcl"),
  extension(".astro", "astro"),
  extension(".pm", "perl"), extension(".pl", "perl"), extension(".t", "perl"), extension(".cgi", "perl"), extension(".psgi", "perl"),
  extension(".zpt", "zope-page-template"),
  extension(".dtml", "dtml")
];

/**
 * The name-based admission rules, split one class per concept.
 *
 * They used to be one alternation inside `isSupportedFileName`, which made them impossible to reference
 * individually — and mechanisms need them individually: content search reads `README*` but not `Makefile`
 * or `LICENSE`, and that difference is a real property of the search corpus, not an oversight.
 */
const NAME_CLASSES: NameClassEntry[] = [
  {
    id: "project-manifest",
    language: "build-metadata",
    textual: true,
    rule: {
      kind: "exact",
      names: [
        "package.json", "go.mod", "Cargo.toml", "pyproject.toml", "requirements.txt", "pom.xml",
        "build.gradle", "build.gradle.kts", "Gemfile", "composer.json", "docker-compose.yml", "docker-compose.yaml"
      ]
    }
  },
  // A sample env file is admitted precisely BECAUSE it is a sample: the same class is what keeps a real
  // `.env` out (see `fileExclusionRule`), so both sides of that decision read one rule.
  { id: "env-sample", language: "dotenv", textual: true, rule: { kind: "pattern", pattern: "^\\.env\\.(sample|example|template|defaults?)$" } },
  { id: "readme", language: "documentation", textual: true, rule: { kind: "pattern", pattern: "^README(?:\\.|$)" } },
  { id: "license", language: "documentation", textual: true, rule: { kind: "pattern", pattern: "^LICENSE(?:\\.|$)" } },
  { id: "dockerfile", language: "dockerfile", textual: true, rule: { kind: "pattern", pattern: "^Dockerfile(?:\\.|$)" } },
  { id: "makefile", language: "make", textual: true, rule: { kind: "pattern", pattern: "^Makefile(?:\\.|$)" } },
  { id: "procfile", language: "process-manifest", textual: true, rule: { kind: "pattern", pattern: "^Procfile(?:\\.|$)" } }
];

export const LANGUAGE_REGISTRY: LanguageRegistry = {
  version: LANGUAGE_REGISTRY_VERSION,
  extensions: EXTENSIONS,
  nameClasses: NAME_CLASSES
};

/**
 * The lookups every consumer of the corpus definition needs, bound to ONE registry instance.
 *
 * Parameterised rather than module-global because layer 2's ledger takes the registry as a contract input and
 * records its digest: a builder that accepted a registry argument and then answered from the module's own
 * tables would be publishing a digest for declarations it did not apply. Building a resolver is a handful of
 * maps over ~50 entries, so there is nothing to cache and no cache key to get wrong.
 */
export interface CorpusResolver {
  isRegisteredExtension(ext: string): boolean;
  /**
   * Every name class this file name matches. ALL of them, not the first — a mechanism declares support class
   * by class, so answering from a single first match would silently deny support for a second class the
   * mechanism does declare.
   */
  nameClassesMatching(name: string): NameClassEntry[];
  /** The registered corpus predicate: a registered extension, or a name class. Layer 1's admission rule. */
  isRegisteredCorpusMember(name: string, ext: string): boolean;
  /**
   * What language a counted row belongs to. The extension wins when it is registered, because that is the
   * stronger statement (`README.md` is markdown that happens to be a readme); a name class answers only for
   * rows whose extension the registry does not know. `null` means the registry and layer 1 disagree about what
   * the corpus is — structurally impossible while the scanner admits rows through the same predicate, and the
   * consistency test is what keeps it that way.
   */
  languageOf(name: string, ext: string): string | null;
  scannedExtensions(): ReadonlySet<string>;
  textualExtensions(): ReadonlySet<string>;
}

export function corpusResolver(registry: LanguageRegistry): CorpusResolver {
  const byExtension = new Map(registry.extensions.map((entry) => [entry.extension, entry]));
  const scanned = new Set(registry.extensions.map((entry) => entry.extension));
  const textual = new Set(registry.extensions.filter((entry) => entry.textual).map((entry) => entry.extension));
  // Compiled once per resolver. Every pattern is non-global, so `test` carries no lastIndex state.
  const matchers = registry.nameClasses.map((entry) => {
    if (entry.rule.kind === "exact") {
      const names = new Set(entry.rule.names);
      return { entry, matches: (name: string) => names.has(name) };
    }
    const pattern = new RegExp(entry.rule.pattern, "i");
    return { entry, matches: (name: string) => pattern.test(name) };
  });
  const classesMatching = (name: string): NameClassEntry[] => matchers.filter((matcher) => matcher.matches(name)).map((matcher) => matcher.entry);
  return {
    isRegisteredExtension: (ext) => scanned.has(ext),
    nameClassesMatching: classesMatching,
    isRegisteredCorpusMember: (name, ext) => scanned.has(ext) || matchers.some((matcher) => matcher.matches(name)),
    languageOf: (name, ext) => byExtension.get(ext)?.language ?? classesMatching(name)[0]?.language ?? null,
    scannedExtensions: () => scanned,
    textualExtensions: () => textual
  };
}

/** The production resolver. The module-level projections below are its methods, named for their old callers. */
const DEFAULT = corpusResolver(LANGUAGE_REGISTRY);

/** Every extension the scanner admits. The former `SOURCE_EXTENSIONS` literal, now derived. */
export function scannedExtensions(): ReadonlySet<string> { return DEFAULT.scannedExtensions(); }

/** The scanned extensions whose bytes are UTF-8 text. The former `TEXTUAL_EXTENSIONS` literal, now derived. */
export function textualExtensions(): ReadonlySet<string> { return DEFAULT.textualExtensions(); }

export function isRegisteredExtension(ext: string): boolean { return DEFAULT.isRegisteredExtension(ext); }

export function nameClassesMatching(name: string): NameClassEntry[] { return DEFAULT.nameClassesMatching(name); }

export function isRegisteredCorpusMember(name: string, ext: string): boolean { return DEFAULT.isRegisteredCorpusMember(name, ext); }

export function extensionsOfLanguage(language: string, registry: LanguageRegistry = LANGUAGE_REGISTRY): ReadonlySet<string> {
  return new Set(registry.extensions.filter((entry) => entry.language === language).map((entry) => entry.extension));
}

export function nameClassIds(registry: LanguageRegistry = LANGUAGE_REGISTRY): readonly string[] {
  return registry.nameClasses.map((entry) => entry.id);
}

/** The compiled pattern of one pattern class; the scanner's `SAFE_ENV_SAMPLE` reads through here. */
export function patternOfClass(id: string, registry: LanguageRegistry = LANGUAGE_REGISTRY): RegExp {
  const rule = registry.nameClasses.find((entry) => entry.id === id)?.rule;
  if (rule?.kind !== "pattern") throw new Error(`Name class ${JSON.stringify(id)} is not a pattern class`);
  return new RegExp(rule.pattern, "i");
}

/** Digest over the declared content. Adding a language changes it; it is recorded in the layer-2 ledger. */
export function languageRegistryDigest(registry: LanguageRegistry = LANGUAGE_REGISTRY): string {
  return sha256(stableJson(registry));
}
