import test from "node:test";
import assert from "node:assert/strict";
import { LANGUAGE_REGISTRY, type LanguageRegistry } from "../src/base/language-registry.ts";
import { MECHANISM_REGISTRY } from "../src/base/mechanism-registry.ts";
import {
  PARTITION_DESIGNATION, PARTITION_DESIGNATION_VERSION, designatedBuilder, languagesOfBuilder,
  partitionDesignationDigest, registeredLanguages, validatePartitionDesignation,
  type PartitionDesignation
} from "../src/base/partition-designation.ts";

/**
 * Every language the scanner admits declares how it is partitioned — checked in BOTH directions at load.
 *
 * The forward hole is "we added a language and forgot to say how it is partitioned", which would either throw
 * mid-run or, worse, pick up a default. The backward hole is a designation for a language the registry does not
 * have: a dead row that reads like support, the same shape as `.pod` and `.pt` sitting in `nativegraph/build.ts`
 * as dead branches for as long as nobody compared the two lists.
 */

test("the production designation loads and declares the partition schema generation", () => {
  validatePartitionDesignation(PARTITION_DESIGNATION, LANGUAGE_REGISTRY);
  assert.equal(PARTITION_DESIGNATION.version, "units-partition-v1");
  assert.equal(PARTITION_DESIGNATION_VERSION, PARTITION_DESIGNATION.version);
});

test("every registered language — extensions AND name classes — has a designated builder", () => {
  const declared = new Set(Object.keys(PARTITION_DESIGNATION.byLanguage));
  const registered = registeredLanguages(LANGUAGE_REGISTRY);
  assert.deepEqual([...registered].filter((language) => !declared.has(language)).sort(), []);
  assert.deepEqual([...declared].filter((language) => !registered.has(language)).sort(), []);
  // The name-class languages are the ones that get forgotten: they have no extension of their own, and a counted
  // `Makefile` or `go.mod` still needs a partition.
  for (const language of ["build-metadata", "dockerfile", "documentation", "dotenv", "make", "process-manifest"]) {
    assert.ok(declared.has(language), `${language} comes only from a name class and must still be designated`);
    assert.equal(designatedBuilder(language).kind, "file-level");
  }
});

test("the first batch is the three languages ast-grep resolves; everything else is file level by declaration", () => {
  assert.deepEqual([...languagesOfBuilder("partition-ast")].sort(), ["go", "javascript", "typescript"]);
  for (const language of ["typescript", "javascript", "go"]) {
    assert.deepEqual(designatedBuilder(language), { kind: "mechanism", mechanism: "partition-ast" }, language);
  }
  // Perl is the loud one: 1366 `.pm` files on the provital target become 1366 single-residual partitions with a
  // stated reason. A builder invented here would be inventing structure nothing in this repository can see.
  for (const language of ["perl", "zope-page-template", "dtml", "python", "html", "java", "ruby"]) {
    assert.deepEqual(designatedBuilder(language), { kind: "file-level" }, language);
  }
  assert.throws(() => designatedBuilder("klingon"), /No partition builder is designated/);
});

test("the designation refuses to load with a hole or a phantom in it", () => {
  const widened: LanguageRegistry = {
    ...LANGUAGE_REGISTRY,
    extensions: [...LANGUAGE_REGISTRY.extensions, { extension: ".brandnew", language: "brandnew", textual: true }]
  };
  assert.throws(() => validatePartitionDesignation(PARTITION_DESIGNATION, widened),
    /No partition builder is designated for registered language\(s\) brandnew/,
    "adding a language without saying how it is partitioned must fail at import, not mid-run");

  const phantom: PartitionDesignation = {
    ...PARTITION_DESIGNATION,
    byLanguage: { ...PARTITION_DESIGNATION.byLanguage, "klingon": { kind: "file-level" } }
  };
  assert.throws(() => validatePartitionDesignation(phantom, LANGUAGE_REGISTRY),
    /names unregistered language\(s\) klingon/);

  const unregisteredMechanism: PartitionDesignation = {
    ...PARTITION_DESIGNATION,
    byLanguage: { ...PARTITION_DESIGNATION.byLanguage, "perl": { kind: "mechanism", mechanism: "partition-perl" as "partition-ast" } }
  };
  assert.throws(() => validatePartitionDesignation(unregisteredMechanism, LANGUAGE_REGISTRY),
    /designates unregistered mechanism "partition-perl"/);

  assert.throws(() => validatePartitionDesignation({ ...PARTITION_DESIGNATION, version: " " }, LANGUAGE_REGISTRY),
    /must declare its version/);
});

test("every designated mechanism is a registered mechanism with a declared extension set", () => {
  for (const builder of Object.values(PARTITION_DESIGNATION.byLanguage)) {
    if (builder.kind !== "mechanism") continue;
    const entry = MECHANISM_REGISTRY.mechanisms.find((mechanism) => mechanism.id === builder.mechanism);
    assert.ok(entry, `${builder.mechanism} must be registered`);
    assert.equal(entry.coverageDomain, "file", "a partition builder accounts for files, so it takes matrix rows");
    assert.equal(entry.support.kind, "extensions", "a builder with no declared extension set cannot be checked against the corpus");
  }
});

test("retargeting one language moves the digest: UnitIds are not comparable across generations", () => {
  const before = partitionDesignationDigest();
  assert.equal(before, partitionDesignationDigest(PARTITION_DESIGNATION));
  const retargeted: PartitionDesignation = {
    ...PARTITION_DESIGNATION,
    byLanguage: { ...PARTITION_DESIGNATION.byLanguage, "python": { kind: "mechanism", mechanism: "partition-ast" } }
  };
  assert.notEqual(partitionDesignationDigest(retargeted), before);
  assert.notEqual(partitionDesignationDigest({ ...PARTITION_DESIGNATION, version: "units-partition-v2" }), before);
});
