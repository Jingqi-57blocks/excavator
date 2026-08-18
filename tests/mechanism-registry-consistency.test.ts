import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_EXTENSIONS } from "../src/snapshot/snapshot.ts";
import { TEXTUAL_EXTENSIONS } from "../src/snapshot/source.ts";
import {
  LANGUAGE_REGISTRY, corpusResolver, extensionsOfLanguage, isRegisteredCorpusMember,
  scannedExtensions, textualExtensions, type LanguageRegistry
} from "../src/base/language-registry.ts";
import {
  MECHANISM_IDS, MECHANISM_REGISTRY, declaredExtensions, mechanismById, validateMechanismRegistry,
  type MechanismEntry, type MechanismRegistry
} from "../src/base/mechanism-registry.ts";
import { AST_LANGUAGE_BY_EXTENSION, PERL_EXTENSIONS } from "../src/facts/probe/condition-extract.ts";
import { AST_PARTITION_VERSION, astPartitionLanguage } from "../src/facts/units/ast-partition.ts";
import { NATIVE_GRAPH_EXTENSIONS } from "../src/nativegraph/build.ts";
import { CTAGS_LANGUAGES } from "../src/nativegraph/ctags.ts";
import { PACKS } from "../src/framework/pack.ts";
import { SCHEMA_EXTENSIONS } from "../src/schema/discover.ts";
import { CROSSREPO_EXTENSIONS } from "../src/crossrepo/crossrepo-scan.ts";

/**
 * The registry's claim is that no mechanism can read a file type the scanner does not admit, and that no
 * adapter keeps a private whitelist nobody compares to it. Both halves need a check that FAILS.
 *
 * They already had a failure to catch. Before this slice `nativegraph/build.ts` consumed `.pod` (Perl POD) and
 * `.pt` (Zope page template), and neither was in `SOURCE_EXTENSIONS` — measured: `scanFiles` could not once
 * have handed either of them over, so both branches were dead code that read as language support. That is the
 * exact shape the subset assertion below catches.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The scanned-extension set EXACTLY as it was written before it became a registry projection, order included.
 * Frozen here rather than derived, because a projection that quietly changed the selection set would move
 * every target's file ledger while `SCANNER_VERSION` still claimed the same generation.
 */
const PRE_PROJECTION_SOURCE_EXTENSIONS = [
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".go", ".py", ".java", ".kt", ".kts", ".rb", ".php",
  ".cs", ".fs", ".rs", ".c", ".h", ".cc", ".cpp", ".hpp", ".swift", ".scala", ".vue", ".svelte", ".sql",
  ".yaml", ".yml", ".json", ".toml", ".xml", ".html", ".css", ".scss", ".md", ".sh", ".proto", ".graphql", ".gql",
  ".tf", ".hcl", ".astro", ".pm", ".pl", ".t", ".cgi", ".psgi", ".zpt", ".dtml"
];

/** `TEXTUAL_EXTENSIONS` as it was written before the move: byte-identical to the list above. */
const PRE_PROJECTION_TEXTUAL_EXTENSIONS = [...PRE_PROJECTION_SOURCE_EXTENSIONS];

function sorted(values: Iterable<string>): string[] { return [...values].sort(); }

test("the projected scan and search corpora are element-for-element the literals they replaced", () => {
  assert.deepEqual([...SOURCE_EXTENSIONS], PRE_PROJECTION_SOURCE_EXTENSIONS,
    "moving SOURCE_EXTENSIONS into the registry must not add, drop or reorder one extension");
  assert.deepEqual([...TEXTUAL_EXTENSIONS], PRE_PROJECTION_TEXTUAL_EXTENSIONS,
    "moving TEXTUAL_EXTENSIONS into the registry must not add, drop or reorder one extension");
  assert.deepEqual([...scannedExtensions()], [...SOURCE_EXTENSIONS]);
  assert.deepEqual([...textualExtensions()], [...TEXTUAL_EXTENSIONS]);
});

test("the registered corpus predicate answers exactly as the scanner's own literals did", () => {
  // The four admission paths, and the near misses that must stay out. `isSupportedFileName` is private, so the
  // frozen expectations here are what the old alternation produced for each name.
  const cases: Array<[string, string, boolean]> = [
    ["service.ts", ".ts", true],
    ["Handler.pm", ".pm", true],
    ["package.json", ".json", true],
    ["go.mod", ".mod", true],
    ["Gemfile", "", true],
    ["build.gradle", ".gradle", true],
    [".env.sample", ".sample", true],
    [".env.defaults", ".defaults", true],
    ["README", "", true],
    ["README.txt", ".txt", true],
    ["license.txt", ".txt", true],
    ["Dockerfile.provital-zms-dev", ".provital-zms-dev", true],
    ["Makefile", "", true],
    ["Procfile.web", ".web", true],
    ["logo.png", ".png", false],
    ["notes.xyz", ".xyz", false],
    ["READMEISH", "", false],
    [".env", "", false],
    ["gemfile", "", false]
  ];
  for (const [name, extension, expected] of cases) {
    assert.equal(isRegisteredCorpusMember(name, extension), expected, `${name} (${extension || "no extension"})`);
  }
});

test("every mechanism whitelist is a subset of the scanned corpus", () => {
  const scanned = scannedExtensions();
  const consumed: Array<[string, Iterable<string>]> = [
    ["decision-probe / condition-ast (AST_LANGUAGE_BY_EXTENSION)", Object.keys(AST_LANGUAGE_BY_EXTENSION)],
    ["condition-ast-perl (PERL_EXTENSIONS)", PERL_EXTENSIONS],
    ["native-graph (NATIVE_GRAPH_EXTENSIONS)", NATIVE_GRAPH_EXTENSIONS],
    ["framework (pack extensions)", PACKS.flatMap((pack) => pack.extensions)],
    ["db-schema (SCHEMA_EXTENSIONS)", SCHEMA_EXTENSIONS],
    ["crossrepo (CROSSREPO_EXTENSIONS)", CROSSREPO_EXTENSIONS]
  ];
  for (const [label, extensions] of consumed) {
    const unscanned = sorted(extensions).filter((extension) => !scanned.has(extension));
    assert.deepEqual(unscanned, [],
      `${label} consumes extensions the scanner never yields, so those branches can never run: ${unscanned.join(", ")}`);
  }
  // The two that were really dead, named so a re-introduction is recognisable rather than merely red.
  for (const extension of [".pod", ".pt"]) {
    assert.ok(!NATIVE_GRAPH_EXTENSIONS.has(extension), `${extension} is not scanned; native-graph must not claim it`);
  }
});

test("each adapter's whitelist is identical to the support set the mechanism registry declares for it", () => {
  assert.deepEqual(sorted(Object.keys(AST_LANGUAGE_BY_EXTENSION)), sorted(declaredExtensions("decision-probe")));
  assert.deepEqual(sorted(Object.keys(AST_LANGUAGE_BY_EXTENSION)), sorted(declaredExtensions("condition-ast")));
  // The designated partition builder reads the SAME adapter table as the two probes. A separate support set for
  // it would let the builder claim a file type ast-grep cannot resolve, and that file would then get no cells
  // while the ledger reported it covered.
  assert.deepEqual(sorted(Object.keys(AST_LANGUAGE_BY_EXTENSION)), sorted(declaredExtensions("partition-ast")));
  for (const extension of Object.keys(AST_LANGUAGE_BY_EXTENSION)) {
    assert.ok(astPartitionLanguage(extension), `${extension} must resolve to an ast-grep language for the partition builder`);
  }
  for (const extension of [".mts", ".cts"]) {
    assert.equal(astPartitionLanguage(extension), null,
      `${extension} is a scanned TypeScript extension ast-grep does not resolve; the builder must report builder-extension-not-declared rather than claim it`);
    assert.ok(!declaredExtensions("partition-ast").has(extension));
  }
  assert.equal(mechanismById("partition-ast").version, AST_PARTITION_VERSION,
    "the builder module and the registry declare one version; two would let the schema generation drift from the code");
  assert.deepEqual(sorted(PERL_EXTENSIONS), sorted(declaredExtensions("condition-ast-perl")));
  assert.deepEqual(sorted(NATIVE_GRAPH_EXTENSIONS), sorted(declaredExtensions("native-graph")));
  assert.deepEqual(sorted(PACKS.flatMap((pack) => pack.extensions)), sorted(declaredExtensions("framework")));
  assert.deepEqual(sorted(SCHEMA_EXTENSIONS), sorted(declaredExtensions("db-schema")));
  assert.deepEqual(sorted(CROSSREPO_EXTENSIONS), sorted(declaredExtensions("crossrepo")));
  // The two whole-corpus mechanisms: search is the search corpus itself, and the degraded numeric extractor
  // really does run on any text window, so both are the textual projection rather than a hand-kept copy.
  assert.deepEqual(sorted(declaredExtensions("search")), sorted(textualExtensions()));
  assert.deepEqual(sorted(declaredExtensions("condition-regex-numeric")), sorted(textualExtensions()));
  // ctags is handed language NAMES, not extensions; each must still be a language the registry knows.
  const support = mechanismById("ctags-census").support;
  assert.equal(support.kind, "tool-languages");
  if (support.kind !== "tool-languages") return;
  assert.deepEqual(sorted(CTAGS_LANGUAGES.split(",").map((name) => name.toLowerCase())), sorted(support.languages));
  const languages = new Set(LANGUAGE_REGISTRY.extensions.map((entry) => entry.language));
  for (const language of support.languages) assert.ok(languages.has(language), `${language} is not a registered language id`);
});

test("the search mechanism's declared bound is the bound content search actually applies", async () => {
  // Read from the source rather than asserted as a number: the point is that the 500 KB refusal in
  // `sourceSearch` reads the registry, so no literal can drift away from what the ledger publishes.
  const source = await readFile(join(HERE, "..", "src", "snapshot", "source.ts"), "utf8");
  assert.equal(mechanismById("search").maxFileBytes, 500_000);
  assert.match(source, /SEARCH_MECHANISM\.maxFileBytes/, "the search filter must read the declared bound, not a literal");
  assert.ok(!/file\.size > 500_000/.test(source), "a restated size bound is a bound the ledger cannot vouch for");
  assert.deepEqual(mechanismById("search").nameClasses, ["readme"]);
});

test("every extension the schema discoverer branches on is in its exported support set", async () => {
  // A counter-tripwire for the one adapter whose set is assembled from literals spread through a loop: a new
  // `ext === ".kt"` branch that forgets SCHEMA_EXTENSIONS would otherwise be reported as uncovered forever.
  const source = await readFile(join(HERE, "..", "src", "schema", "discover.ts"), "utf8");
  const branches = sorted(new Set([...source.matchAll(/ext === "(\.[a-z0-9]+)"/g)].map((match) => match[1])));
  assert.ok(branches.length >= 4, `the scan found ${branches.length} literal branches; the regex has stopped matching the code`);
  for (const extension of branches) {
    assert.ok(SCHEMA_EXTENSIONS.has(extension), `discover.ts branches on ${extension} but SCHEMA_EXTENSIONS omits it`);
  }
});

test("the production registry validates, and every declared id has an entry", () => {
  validateMechanismRegistry(MECHANISM_REGISTRY, LANGUAGE_REGISTRY);
  assert.deepEqual(sorted(MECHANISM_REGISTRY.mechanisms.map((entry) => entry.id)), sorted(MECHANISM_IDS));
  for (const entry of MECHANISM_REGISTRY.mechanisms) {
    assert.ok(entry.title.trim().length > 0, `${entry.id} states what it is`);
    assert.ok(entry.version.trim().length > 0, `${entry.id} declares a version`);
  }
  // Only file-domain mechanisms with a declared extension set may produce a per-file grid; the other three
  // declare their domain and take no rows, which is what keeps a module-pair count out of a file ratio.
  const matrix = MECHANISM_REGISTRY.mechanisms.filter((entry) => entry.coverageDomain === "file" && entry.support.kind === "extensions");
  assert.equal(matrix.length, 9, `nine file-domain mechanisms carry matrix rows: ${matrix.map((entry) => entry.id).join(", ")}`);
  assert.deepEqual(sorted(MECHANISM_REGISTRY.mechanisms.filter((entry) => !matrix.includes(entry)).map((entry) => entry.id)),
    ["codegraph", "crossrepo", "ctags-census"]);
});

/** A registry built from one deliberately broken entry, so each rejection is asserted on its own. */
function registryWith(overrides: Partial<MechanismEntry>): MechanismRegistry {
  const base = mechanismById("framework");
  return { version: "test-registry", mechanisms: [{ ...base, ...overrides } as MechanismEntry] };
}

test("the registry refuses to load a mechanism whose declarations do not line up with the corpus", () => {
  assert.throws(() => validateMechanismRegistry(registryWith({ support: { kind: "extensions", extensions: [".pod"] } })),
    /unregistered extension "\.pod"/, "a support set may not name a file type the scanner never yields");
  assert.throws(() => validateMechanismRegistry(registryWith({ nameClasses: ["changelog"] })),
    /unregistered name class "changelog"/);
  assert.throws(() => validateMechanismRegistry(registryWith({ support: { kind: "tool-languages", languages: ["klingon"] } })),
    /not a registered language id/);
  assert.throws(() => validateMechanismRegistry(registryWith({ support: { kind: "extensions", extensions: [] } })),
    /empty extension set/);
  assert.throws(() => validateMechanismRegistry(registryWith({ maxFileBytes: 0 })), /non-positive size bound/);
  assert.throws(() => validateMechanismRegistry(registryWith({ title: "  " })), /declares no title/);
  const base = mechanismById("framework");
  assert.throws(() => validateMechanismRegistry({ version: "test-registry", mechanisms: [base, base] }), /registered twice/);
  // And the reverse hole: an id promised by the union with no entry behind it.
  assert.throws(() => validateMechanismRegistry(registryWith({})), /has no registry entry/);
});

test("a language nobody adapted stays a registered language, so its rows can be counted as uncovered", () => {
  // The Linear acceptance in miniature: adding an extension to the registry alone must be legal — that is what
  // makes "we added a language and forgot to adapt anything" expressible as no-mechanism rows rather than as a
  // load failure or an invisible file type.
  const widened: LanguageRegistry = {
    ...LANGUAGE_REGISTRY,
    extensions: [...LANGUAGE_REGISTRY.extensions, { extension: ".brandnew", language: "brandnew", textual: true }]
  };
  validateMechanismRegistry(MECHANISM_REGISTRY, widened);
  const resolver = corpusResolver(widened);
  assert.ok(resolver.isRegisteredExtension(".brandnew"));
  assert.equal(resolver.languageOf("thing.brandnew", ".brandnew"), "brandnew");
  assert.ok(!scannedExtensions().has(".brandnew"), "and the production registry is untouched by the widened copy");
});

test("every language and name class the registry declares is complete enough to group a census by", () => {
  for (const entry of LANGUAGE_REGISTRY.extensions) {
    assert.match(entry.extension, /^\.[a-z0-9]+$/, `${entry.extension} is not a lowercase dotted extension`);
    assert.ok(entry.language.trim().length > 0, `${entry.extension} declares a language`);
    assert.equal(typeof entry.textual, "boolean", `${entry.extension} states explicitly whether it is text`);
  }
  const ids = new Set<string>();
  for (const entry of LANGUAGE_REGISTRY.nameClasses) {
    assert.ok(!ids.has(entry.id), `name class ${entry.id} is declared twice`);
    ids.add(entry.id);
    assert.ok(entry.language.trim().length > 0, `name class ${entry.id} declares a language`);
    if (entry.rule.kind === "pattern") assert.doesNotThrow(() => new RegExp(entry.rule.kind === "pattern" ? entry.rule.pattern : "", "i"));
    else assert.ok(entry.rule.names.length > 0, `name class ${entry.id} declares no names`);
  }
});
