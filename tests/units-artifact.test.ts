import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluateSeat, factKindById, type FactKindId, type FactKindRegistry } from "../src/base/fact-kind-registry.ts";
import { LANGUAGE_REGISTRY } from "../src/base/language-registry.ts";
import { MECHANISM_REGISTRY } from "../src/base/mechanism-registry.ts";
import { PARTITION_DESIGNATION, type PartitionDesignation } from "../src/base/partition-designation.ts";
import { canonicalJson } from "../src/base/util.ts";
import { built } from "../src/base/artifact-result.ts";
import { crossRepoObservations, targetRelative, type CrossRepoModule } from "../src/crossrepo/crossrepo-facts.ts";
import type { CrossRepoScan } from "../src/crossrepo/crossrepo-scan.ts";
import { buildProducerFactSet, factsOfProducer, FACT_DETAIL_MAX_CHARS, serializeProducerFactSet } from "../src/facts/envelope.ts";
import { loadAstGrep } from "../src/facts/probe/condition-extract.ts";
import {
  mapObservations, partitionView, UNNORMALIZED_REASONS,
  type ObservedFact, type UnnormalizedReason
} from "../src/facts/units/membership-map.ts";
import { PartitionSkeletonCache } from "../src/facts/units/partition-cache.ts";
import { buildPartition, type PartitionBuildResult } from "../src/facts/units/partition-build.ts";
import {
  assembleUnitsArtifact, runObservationPass, serializeUnitsArtifact, unitsContentDigest, unitsRowSet,
  type UnitsArtifact
} from "../src/facts/units/units-artifact.ts";
import type { CountedRow, FileLedger } from "../src/snapshot/file-ledger.ts";
import { createSnapshot } from "../src/snapshot/snapshot.ts";
import { tempDir } from "./helpers.ts";

/**
 * `facts/units.json` and the producer envelopes: the observation pass, the merge, and the identities.
 *
 * The three properties that could not be recovered by any later audit are pinned here. Two producers observing one
 * declaration must produce ONE reference unit with two observers, never two units — the second would make the
 * denominator a count of tool observations. Adding or removing an observer must not move one byte of
 * `partition[]`, and the same comparison must be able to SEE a difference, or it is proving nothing. And an
 * envelope identity must not contain a feature key, because a fact is not about a feature.
 *
 * Every unmapped and unnormalized reason has a fixture below, for the reason the degrade vocabulary has one: a
 * bucket nothing can reach vouches for whatever it is pointed at.
 */

const AST_GREP = loadAstGrep();
const EXERCISED_UNNORMALIZED = new Set<UnnormalizedReason>();

async function partitionOf(target: string, designation: PartitionDesignation = PARTITION_DESIGNATION): Promise<{ build: PartitionBuildResult; counted: CountedRow[] }> {
  const cacheDir = await tempDir("excavator-artifact-cache-");
  const { ledger } = await createSnapshot(target, 100_000, { cacheDir });
  const counted = (ledger as FileLedger).counted;
  const build = await buildPartition({
    counted,
    target,
    languages: LANGUAGE_REGISTRY,
    designation,
    mechanisms: MECHANISM_REGISTRY,
    astGrep: AST_GREP,
    cache: await PartitionSkeletonCache.open(cacheDir)
  });
  return { build, counted };
}

function assemble(build: PartitionBuildResult, mapping: Parameters<typeof assembleUnitsArtifact>[0]["mapping"], offered = 0): UnitsArtifact {
  return assembleUnitsArtifact({
    build,
    mapping,
    identity: { filesContentManifestDigest: "files-digest", scannerVersion: "scanner-v1", mechanismsDigest: "mechanisms-digest" },
    inheritedCompleteness: { capReached: false, skippedByCap: 0, droppedRoots: [] },
    observationsOffered: offered,
    lineIndexReads: 0,
    lineIndexReadFailures: 0
  });
}

function fact(factId: string, kind: FactKindId, anchors: ObservedFact["anchors"], detail: ObservedFact["detail"] = {}): ObservedFact {
  return { factId, kind, anchors, detail };
}

/** A file whose declaration lines are a property of the fixture rather than of a comment. */
const APP_TS = [
  "// header",                    // line 1
  "export function handler() {",  // line 2
  "  return 1;",                  // line 3
  "}",                            // line 4
  "export class Service {",       // line 5
  "  method() {",                 // line 6
  "    return 2;",                // line 7
  "  }",                          // line 8
  "}"                             // line 9
].join("\n") + "\n";

test("two producers observing one declaration produce ONE reference unit with two observers", async () => {
  assert.ok(AST_GREP, "the ast-grep binding is required: this is the designated builder for typescript");
  const target = await tempDir("excavator-observed-by-");
  await writeFile(join(target, "app.ts"), APP_TS);
  const { build } = await partitionOf(target);

  const view = partitionView(build.files, build.lineOffsets);
  const facts = [
    // The index, claiming a function at the declaration's own line.
    fact("cg:handler", "indexed-function", [{ relativePath: "app.ts", startLine: 2, endLine: 4, unitKind: "function" }]),
    // The route recovery, claiming nothing about the kind — the registration line is all it knows.
    fact("xr:route", "recovered-route", [{ relativePath: "app.ts", startLine: 2, endLine: 4, unitKind: null }]),
    // And a redundant second observation from the same producer, to prove the merge deduplicates by producer.
    fact("cg:handler-again", "indexed-function", [{ relativePath: "app.ts", startLine: 2, endLine: 4, unitKind: "function" }])
  ];
  const mapping = mapObservations(view, facts);
  const artifact = assemble(build, mapping, facts.length);

  // The MEMBERSHIP lands on the function's own cell, not on the seven-byte `export ` residual in front of it.
  // Resolving by "the cell containing the first byte of the line" files every exported declaration in that
  // sliver — measured on this repository's own source, which is why the preference order is explicit.
  const seated = mapping.mapped.find((entry) => entry.factId === "cg:handler")!;
  assert.equal(seated.membership.kind, "unit");
  const cellId = seated.membership.kind === "unit" ? seated.membership.unitId : "";
  assert.match(cellId, /^cell:structure:/, "a declaration belongs to its structure cell, not to the residual before it");
  const cell = artifact.partition.find((entry) => entry.unitId === cellId)!;
  assert.equal(cell.unitKind, "function");
  assert.equal(Buffer.from(APP_TS, "utf8").subarray(cell.span.startByte, cell.span.endByte).toString("utf8"),
    "function handler() {\n  return 1;\n}", "and back to the source: those bytes are the declaration");

  const handler = artifact.refUnits.filter((unit) => unit.unitKind === "function");
  assert.equal(handler.length, 1, "one declaration, one reference unit — never one per observation");
  assert.deepEqual(handler[0]!.observedBy, ["codegraph", "crossrepo"], "sorted, deduplicated producer ids");
  assert.equal(handler[0]!.normalization, "builder-node", "the builder's skeleton is the authority on the span");
  assert.equal(artifact.observations.observedByAtLeastTwo, 1);
  assert.equal(artifact.observations.mintedRefUnits, 0, "nothing was minted: the skeleton already had the node");
  // The class the observations said nothing about keeps an empty observer list, which is legal and common.
  const service = artifact.refUnits.find((unit) => unit.unitKind === "class")!;
  assert.deepEqual(service.observedBy, []);
});

test("adding or removing an observer moves observedBy and nothing else — and the comparison can see a difference", async () => {
  const target = await tempDir("excavator-observer-toggle-");
  await writeFile(join(target, "app.ts"), APP_TS);
  const { build } = await partitionOf(target);
  const view = partitionView(build.files, build.lineOffsets);

  const withoutObserver = assemble(build, mapObservations(view, []), 0);
  const observation = [fact("cg:handler", "indexed-function", [{ relativePath: "app.ts", startLine: 2, endLine: 4, unitKind: "function" }])];
  const withObserver = assemble(build, mapObservations(view, observation), 1);

  assert.equal(canonicalJson(withObserver.partition), canonicalJson(withoutObserver.partition),
    "an observer may not change one byte of the denominator");
  assert.deepEqual(withObserver.refUnits.map((unit) => unit.refUnitId), withoutObserver.refUnits.map((unit) => unit.refUnitId),
    "nor the reference unit id set");
  assert.deepEqual(withObserver.files, withoutObserver.files);

  // THE SENSITIVITY CONTROL. Without it the three equalities above could hold because the comparison sees nothing.
  assert.notEqual(canonicalJson(withObserver.refUnits), canonicalJson(withoutObserver.refUnits),
    "the two artifacts must differ somewhere, or this test proves only that both are empty");
  assert.deepEqual(withObserver.refUnits.find((unit) => unit.unitKind === "function")!.observedBy, ["codegraph"]);
  assert.deepEqual(withoutObserver.refUnits.find((unit) => unit.unitKind === "function")!.observedBy, []);
  assert.notEqual(unitsContentDigest(withObserver), unitsContentDigest(withoutObserver));
});

test("a resolved cross-repo link carries both ends, and a seat at either end seats the edge", async () => {
  const target = await tempDir("excavator-link-");
  await mkdir(join(target, "web"), { recursive: true });
  await mkdir(join(target, "api"), { recursive: true });
  await writeFile(join(target, "web/page.ts"), "const load = () => httpClient.get(`/v2/items/${id}`);\n");
  await writeFile(join(target, "api/routes.ts"), "router.get('/v2/items/:id', (req, res) => res.json({}));\n");
  const { build } = await partitionOf(target);
  const modules: CrossRepoModule[] = [{ id: "web", dir: "web" }, { id: "api", dir: "api" }];
  const scan = scanWith({
    modules: ["api", "web"],
    links: [{
      from: { module: "web", path: "page.ts", line: 1, method: "GET", baseKey: null, expression: "`/v2/items/${id}`", routePath: "/v2/items/:p1" },
      to: { module: "api", path: "routes.ts", line: 1, route: "GET /v2/items/:id", localPath: "/v2/items/:id", prefixComposed: false, handlerExpression: "(req, res) => res.json({})" },
      resolution: "static", confidence: "confirmed", rule: "R2"
    }]
  });

  const facts = crossRepoObservations(scan, modules);
  const link = facts.find((entry) => entry.kind === "http-link")!;
  assert.deepEqual(link.anchors.map((anchor) => anchor.relativePath), ["web/page.ts", "api/routes.ts"],
    "module-relative paths are translated to the target-relative paths a cell is keyed by");

  const mapping = mapObservations(partitionView(build.files, build.lineOffsets), facts);
  const mapped = mapping.mapped.find((entry) => entry.factId === link.factId)!;
  assert.equal(mapped.membership.kind, "relation");
  assert.equal(mapped.membership.kind === "relation" ? mapped.membership.endpoints.length : 0, 2);
  const endpoints = mapped.membership.kind === "relation" ? mapped.membership.endpoints : [];
  const entry = factKindById("http-link");
  const backendOnly = new Set(endpoints.filter((id) => id.includes("api/routes.ts")));
  assert.equal(backendOnly.size, 1, "the fixture must really have one endpoint per module");
  assert.equal(evaluateSeat(entry, mapped.membership, backendOnly, () => null), "member",
    "any-endpoint: the backend route seated is enough — otherwise the edge reads as co-located and is dropped");
  assert.equal(evaluateSeat(entry, mapped.membership, new Set(), () => null), "not-member");
});

test("a corpus-domain fact gets the corpus membership, and the mapper never invents a cell for it", async () => {
  const target = await tempDir("excavator-corpus-");
  await writeFile(join(target, "app.ts"), APP_TS);
  const { build } = await partitionOf(target);
  const mapping = mapObservations(partitionView(build.files, build.lineOffsets), [
    fact("df:invoice", "term-df", [], { term: "invoice", documentFrequency: 12 })
  ]);
  assert.equal(mapping.mapped.length, 1);
  assert.deepEqual(mapping.mapped[0]!.membership, { kind: "corpus" });
  assert.deepEqual(mapping.unmappedAnchors, []);
  const entry = factKindById("term-df");
  assert.equal(evaluateSeat(entry, mapping.mapped[0]!.membership, new Set(["cell:structure:0-1:app.ts"]), () => null), "not-applicable");

  // And a corpus fact carrying an anchor is a producer bug, refused rather than mapped onto the anchor's cell.
  assert.throws(() => mapObservations(partitionView(build.files, build.lineOffsets), [
    fact("df:bad", "term-df", [{ relativePath: "app.ts", startLine: 2, endLine: 4, unitKind: null }])
  ]), /corpus fact has no place in the source to point at/);
});

test("every membership arm the registry declares has a derivation, including the two no v1 kind uses", async () => {
  const target = await tempDir("excavator-arms-");
  await writeFile(join(target, "app.ts"), APP_TS);
  const { build } = await partitionOf(target);
  const view = partitionView(build.files, build.lineOffsets);
  const anchor = { relativePath: "app.ts", startLine: 2, endLine: 4, unitKind: "function" as const };

  // `unit`, `relation` and `corpus` come from real v1 kinds and are pinned by the tests around this one. `span-set`
  // and `module` have no v1 kind, so they are exercised by pointing a synthetic registry at those arms — a
  // derivation whose only fixture is the day someone needs it is a derivation invented under deadline.
  assert.equal(mapObservations(view, [fact("u", "indexed-function", [anchor])]).mapped[0]!.membership.kind, "unit");

  const registry: FactKindRegistry = { version: "fact-kind-registry-test", kinds: [
    { id: "indexed-function", title: "a span set over the reported range", producer: "codegraph", membershipKind: "span-set", seatRule: "all-covered", structuralDeclaration: false },
    { id: "http-link", title: "a module membership", producer: "crossrepo", membershipKind: "module", seatRule: "any-endpoint", structuralDeclaration: false }
  ] };
  const spanSet = mapObservations(view, [fact("s", "indexed-function", [anchor])], registry).mapped[0]!.membership;
  assert.equal(spanSet.kind, "span-set");
  assert.ok(spanSet.kind === "span-set" && spanSet.unitIds.length >= 1, "the cells the reported span covers, non-empty by construction");
  const moduleArm = mapObservations(view, [fact("m", "http-link", [anchor])], registry).mapped[0]!.membership;
  assert.deepEqual(moduleArm, { kind: "module", moduleId: build.files[0]!.rootName },
    "the module comes off the cell's own rootName, so nothing re-derives a module from a path");
});

test("the line-granular preference order is decisive in both directions, and each half has its own fixture", async () => {
  // Written after a deliberate-breakage pass: with only the fixtures above, DROPPING either half of the order left
  // every test green, and a rule with no failing fixture is a comment. Each half now has a file where it decides.
  const target = await tempDir("excavator-preference-");
  // (a) THE RANK half. `export ` is a residual cell that starts on the SAME line as the declaration, so
  //     "starts in this line" ties and only "structure before residual" separates them. The residual is also the
  //     SMALLER span, so without the rank the size tie-break picks the seven-byte sliver — which is precisely the
  //     failure measured on this repository's own source.
  await writeFile(join(target, "leading.ts"), "export function first() {\n  return 1;\n}\n");
  // (b) THE STARTS-IN-LINE half. The class cell CONTAINS line 3 and has the better rank, but what begins on line 3
  //     is the statement after it — so the answer must be the residual, and only "starts in this line" says so.
  await writeFile(join(target, "sharing.ts"), "class A {\n  m() {}\n}  const x = 1;\n");
  const { build } = await partitionOf(target);
  const view = partitionView(build.files, build.lineOffsets);

  const rank = mapObservations(view, [fact("a", "indexed-function", [{ relativePath: "leading.ts", startLine: 1, endLine: 3, unitKind: "function" }])]);
  const rankCell = rank.mapped[0]!.membership;
  assert.ok(rankCell.kind === "unit" && rankCell.unitId.startsWith("cell:structure:"),
    `a declaration sharing its line with a leading residual belongs to the structure cell, got ${JSON.stringify(rankCell)}`);

  const starts = mapObservations(view, [fact("b", "frontend-call", [{ relativePath: "sharing.ts", startLine: 3, endLine: null, unitKind: null }])]);
  const startsCell = starts.mapped[0]!.membership;
  assert.ok(startsCell.kind === "unit" && startsCell.unitId.startsWith("cell:residual:"),
    `what BEGINS on the anchor's line wins over what merely contains it, got ${JSON.stringify(startsCell)}`);
});

test("an anchor outside the counted corpus lands in a visible bucket, one reason per cause", async () => {
  const target = await tempDir("excavator-unmapped-");
  await writeFile(join(target, "app.ts"), APP_TS);
  const { build } = await partitionOf(target);
  const view = partitionView(build.files, build.lineOffsets);

  const outside = mapObservations(view, [fact("f1", "indexed-function", [{ relativePath: "generated/nope.ts", startLine: 1, endLine: 2, unitKind: "function" }])]);
  assert.deepEqual(outside.unmappedAnchors.map((anchor) => anchor.reason), ["path-not-counted"]);
  assert.deepEqual(outside.unmappable, ["f1"], "a fact with no resolvable anchor has no membership, and says so");
  assert.equal(outside.mapped.length, 0);

  const stale = mapObservations(view, [fact("f2", "indexed-function", [{ relativePath: "app.ts", startLine: 9999, endLine: 10000, unitKind: "function" }])]);
  assert.deepEqual(stale.unmappedAnchors.map((anchor) => anchor.reason), ["line-outside-file"]);

  // `file-not-partitioned`: layer 1 observed no size, so the row has no cell to belong to.
  const unsized = build.files.map((file) => file.relativePath === "app.ts" ? { ...file, cells: [], refUnits: [] } : file);
  const noCells = mapObservations(partitionView(unsized, new Map()), [fact("f3", "indexed-function", [{ relativePath: "app.ts", startLine: 2, endLine: 4, unitKind: "function" }])]);
  assert.deepEqual(noCells.unmappedAnchors.map((anchor) => anchor.reason), ["file-not-partitioned"]);

  // One relation end resolvable and one not: the half we can see is kept, and the half we cannot is recorded.
  const half = mapObservations(view, [fact("f4", "http-link", [
    { relativePath: "app.ts", startLine: 2, endLine: null, unitKind: null },
    { relativePath: "gone/api.ts", startLine: 3, endLine: null, unitKind: null }
  ])]);
  assert.equal(half.mapped.length, 1);
  assert.equal(half.mapped[0]!.membership.kind === "relation" ? half.mapped[0]!.membership.endpoints.length : 0, 1);
  assert.deepEqual(half.unmappedAnchors.map((anchor) => anchor.relativePath), ["gone/api.ts"]);
});

test("a structural declaration the skeleton has no node for mints a reported-span unit, or says why it could not", async () => {
  const target = await tempDir("excavator-normalize-");
  await writeFile(join(target, "app.ts"), APP_TS);
  await writeFile(join(target, "App.pm"), "package App;\nsub run { 1 }\n1;\n");
  const { build, counted } = await partitionOf(target);
  const view = partitionView(build.files, build.lineOffsets);

  // A CLASS claim cannot attach to a function node — the kind CLASS has to match, or a type observation would
  // silently become an observer of a callable. It mints its own unit instead, marked as not the builder's.
  const minted = mapObservations(view, [fact("cg:type", "indexed-function", [{ relativePath: "app.ts", startLine: 2, endLine: 4, unitKind: "class" }])]);
  assert.equal(minted.mintedRefUnits.length, 1);
  assert.equal(minted.mintedRefUnits[0]!.normalization, "reported-span");
  assert.equal(minted.mintedRefUnits[0]!.depth, null, "depth is a coordinate in the builder's skeleton, and this is not in it");
  assert.match(minted.mintedRefUnits[0]!.refUnitId, /^ref:class:\d+-\d+:app\.ts$/);
  assert.deepEqual(minted.unnormalized, []);

  // A closure claim, on the other hand, is the same kind class as a function and attaches.
  const attached = mapObservations(view, [fact("cg:arrow", "indexed-function", [{ relativePath: "app.ts", startLine: 2, endLine: 4, unitKind: "closure" }])]);
  assert.equal(attached.mintedRefUnits.length, 0, "function and closure are one kind class: CodeGraph calls arrows functions");

  const reasons: Array<[UnnormalizedReason, ObservedFact]> = [
    // A recovered express route claims no kind, so there is nothing to mint under.
    ["no-kind-claim", fact("xr:1", "recovered-route", [{ relativePath: "app.ts", startLine: 1, endLine: 1, unitKind: null }])],
    // A gin registration with no end line has no span at all.
    ["no-end-line", fact("cg:2", "indexed-function", [{ relativePath: "app.ts", startLine: 1, endLine: null, unitKind: "function" }])],
    // A stale index reporting past the end of the file.
    ["end-line-outside-file", fact("cg:3", "indexed-function", [{ relativePath: "app.ts", startLine: 1, endLine: 9999, unitKind: "function" }])],
    // A file the builder never decoded, and whose line index the observation pass could not obtain.
    ["no-line-index", fact("cg:4", "indexed-function", [{ relativePath: "App.pm", startLine: 2, endLine: 2, unitKind: "function" }])]
  ];
  for (const [reason, observation] of reasons) {
    const result = mapObservations(view, [observation]);
    assert.deepEqual(result.unnormalized.map((record) => record.reason), [reason], `${reason} must be the reason for ${observation.factId}`);
    EXERCISED_UNNORMALIZED.add(reason);
  }

  // And with the observation pass, the `.pm` file's line index IS obtained — from a real read, verified against
  // layer 1's digest — so the same observation mints a unit instead of landing in a bucket.
  const pass = await runObservationPass({ target, build, counted, facts: [reasons[3]![1]] });
  assert.equal(pass.lineIndexReads, 1, "exactly one extra file was opened, and only because an observation needed it");
  assert.equal(pass.lineIndexReadFailures, 0);
  assert.deepEqual(pass.mapping.unnormalized, []);
  assert.equal(pass.mapping.mintedRefUnits.length, 1);
  // Back to the source: `package App;\n` is 13 bytes, so line 2 is [13, 27) and those bytes are the sub.
  assert.equal(pass.mapping.mintedRefUnits[0]!.refUnitId, "ref:function:13-27:App.pm");
  assert.equal((await readFile(join(target, "App.pm"))).subarray(13, 27).toString("utf8"), "sub run { 1 }\n");
});

test("every unnormalized reason has a fixture: the vocabulary may not contain a state nothing can produce", () => {
  assert.deepEqual([...EXERCISED_UNNORMALIZED].sort(), [...UNNORMALIZED_REASONS].sort());
});

test("the envelope identity contains no feature key, and is byte-identical under different feature sets", async () => {
  const target = await tempDir("excavator-envelope-identity-");
  await writeFile(join(target, "app.ts"), APP_TS);
  const { build } = await partitionOf(target);
  const mapping = mapObservations(partitionView(build.files, build.lineOffsets), [
    fact("cg:handler", "indexed-function", [{ relativePath: "app.ts", startLine: 2, endLine: 4, unitKind: "function" }], { name: "handler" })
  ]);
  const artifact = assemble(build, mapping, 1);
  const identity = { filesContentManifestDigest: "files", mechanismsDigest: "mechanisms", unitsContentDigest: unitsContentDigest(artifact), configDigest: "config" };
  const envelope = buildProducerFactSet({
    producer: "codegraph",
    producerVersion: "function-inventory-v1",
    identity,
    ...factsOfProducer(mapping, "codegraph"),
    producerCompleteness: { truncated: false }
  });
  const serialized = canonicalJson(envelope.identity);
  assert.ok(!/feature/i.test(canonicalJson(envelope)), "no field of a layer-3 envelope may mention a feature");
  assert.deepEqual(Object.keys(envelope.identity).sort(), ["configDigest", "filesContentManifestDigest", "mappingVersion", "mechanismsDigest", "producer", "producerVersion", "unitsContentDigest"]);
  // The identity is derived from the corpus, the ledgers and the producer alone, so nothing about which features a
  // run asked for can enter it — the same inputs twice are the same bytes twice.
  const again = buildProducerFactSet({
    producer: "codegraph",
    producerVersion: "function-inventory-v1",
    identity,
    ...factsOfProducer(mapping, "codegraph"),
    producerCompleteness: { truncated: false }
  });
  assert.equal(canonicalJson(again.identity), serialized);
  assert.equal(serializeProducerFactSet(built(again)), serializeProducerFactSet(built(envelope)), "and the whole envelope is byte-identical");
});

test("an envelope refuses a fact the registry assigns to another producer", async () => {
  const target = await tempDir("excavator-envelope-owner-");
  await writeFile(join(target, "app.ts"), APP_TS);
  const { build } = await partitionOf(target);
  const mapping = mapObservations(partitionView(build.files, build.lineOffsets), [
    fact("xr:route", "recovered-route", [{ relativePath: "app.ts", startLine: 2, endLine: 4, unitKind: null }])
  ]);
  assert.throws(() => buildProducerFactSet({
    producer: "codegraph",
    producerVersion: "v",
    identity: { filesContentManifestDigest: "f", mechanismsDigest: "m", unitsContentDigest: "u", configDigest: "c" },
    mapped: mapping.mapped,
    unmappedAnchors: [],
    unmappableFactIds: [],
    producerCompleteness: {}
  }), /the fact-kind registry assigns to "crossrepo"/);
  // And the split by producer is what keeps that from happening in production.
  assert.deepEqual(factsOfProducer(mapping, "codegraph").mapped, []);
  assert.equal(factsOfProducer(mapping, "crossrepo").mapped.length, 1);
});

test("an over-long detail value is clipped deterministically, and the clip counts itself", async () => {
  const target = await tempDir("excavator-detail-clip-");
  await writeFile(join(target, "app.ts"), APP_TS);
  const { build } = await partitionOf(target);
  const long = "x".repeat(FACT_DETAIL_MAX_CHARS + 37);
  const mapping = mapObservations(partitionView(build.files, build.lineOffsets), [
    fact("cg:long", "indexed-function", [{ relativePath: "app.ts", startLine: 2, endLine: 4, unitKind: "function" }], { name: long })
  ]);
  const envelope = buildProducerFactSet({
    producer: "codegraph",
    producerVersion: "v",
    identity: { filesContentManifestDigest: "f", mechanismsDigest: "m", unitsContentDigest: "u", configDigest: "c" },
    ...factsOfProducer(mapping, "codegraph"),
    producerCompleteness: {}
  });
  assert.equal(envelope.completeness.detailClipped, 1);
  assert.equal(envelope.facts[0]!.detail.name, `${"x".repeat(FACT_DETAIL_MAX_CHARS)}…+37c`);
  assert.equal(envelope.completeness.detailMaxChars, FACT_DETAIL_MAX_CHARS);
});

test("the artifact carries no source text, declares its bounds, and re-serializes byte-identically", async () => {
  const target = await tempDir("excavator-bounds-");
  await writeFile(join(target, "app.ts"), `${APP_TS}const SECRET_MARKER_STRING = "unmistakable-source-text";\n`);
  const { build } = await partitionOf(target);
  const artifact = assemble(build, mapObservations(partitionView(build.files, build.lineOffsets), []), 0);
  const bytes = serializeUnitsArtifact(built(artifact));
  assert.ok(!bytes.includes("SECRET_MARKER_STRING"), "no row of this artifact may carry file content");
  assert.ok(!bytes.includes("unmistakable-source-text"));
  assert.equal(artifact.bounds.carriesSourceText, false);
  assert.deepEqual(artifact.bounds.builderCaps["partition-ast"], { maxFileBytes: 500_000, maxLineLength: 5_000 },
    "the declared caps are read off the mechanism registry, not restated here");
  assert.ok(artifact.bounds.maxCellsInOneFile > 0 && artifact.bounds.maxRefUnitsInOneFile > 0);
  assert.equal(serializeUnitsArtifact(built(artifact)), bytes, "canonical bytes, twice");
  // The per-file counts and the flat lists have to agree, or the readable table and the denominator disagree.
  assert.equal(artifact.files.reduce((sum, file) => sum + file.structureCells + file.residualCells, 0), artifact.partition.length);
  assert.equal(artifact.files.reduce((sum, file) => sum + file.refUnits + file.reportedSpanUnits, 0), artifact.refUnits.length);
});

test("the artifact's content digest moves with the partition schema generation, and the RowSet inherits layer 1's cap", async () => {
  const target = await tempDir("excavator-digest-generation-");
  await writeFile(join(target, "app.ts"), APP_TS);
  const { build } = await partitionOf(target);
  const first = assemble(build, mapObservations(partitionView(build.files, build.lineOffsets), []), 0);

  const retargeted: PartitionDesignation = { ...PARTITION_DESIGNATION, version: "units-partition-v2" };
  const second = assembleUnitsArtifact({
    build,
    mapping: mapObservations(partitionView(build.files, build.lineOffsets), []),
    identity: { filesContentManifestDigest: "files-digest", scannerVersion: "scanner-v1", mechanismsDigest: "mechanisms-digest" },
    inheritedCompleteness: { capReached: false, skippedByCap: 0, droppedRoots: [] },
    observationsOffered: 0,
    lineIndexReads: 0,
    lineIndexReadFailures: 0,
    designation: retargeted
  });
  assert.notEqual(unitsContentDigest(second), unitsContentDigest(first),
    "ids are not comparable across generations, so a digest that could not tell them apart would let a cache serve the wrong one");

  const capped = assembleUnitsArtifact({
    build,
    mapping: mapObservations(partitionView(build.files, build.lineOffsets), []),
    identity: { filesContentManifestDigest: "files-digest", scannerVersion: "scanner-v1", mechanismsDigest: "mechanisms-digest" },
    inheritedCompleteness: { capReached: true, skippedByCap: 12, droppedRoots: ["vendor", "assets"] },
    observationsOffered: 0,
    lineIndexReads: 0,
    lineIndexReadFailures: 0
  });
  const rows = unitsRowSet(capped);
  assert.equal(rows.unitKind, "partition-cell");
  assert.equal(rows.coverageDomain, "file");
  assert.equal(rows.size, capped.partition.length);
  assert.deepEqual(rows.identity.completeness, { capReached: true, skippedByCap: 12, droppedRoots: ["assets", "vendor"] },
    "the partition of a capped scan is a capped denominator, and it travels with the rows");
  assert.equal(rows.identity.artifact, "facts/units.json");
  assert.equal(rows.identity.contentDigest, unitsContentDigest(capped));
});

/** A `CrossRepoScan` with every required field, so a fixture states only what it is about. */
function scanWith(overrides: Partial<CrossRepoScan>): CrossRepoScan {
  return {
    version: "crossrepo-links-v1",
    modules: [],
    clients: ["httpClient"],
    links: [],
    unresolved: [],
    ambiguous: [],
    candidates: [],
    routeRecovery: [],
    registrations: [],
    unrecoveredRoutes: [],
    summary: { calls: 0, static: 0, framework: 0, unresolved: 0, ambiguous: 0, weak: 0, routes: 0 },
    warnings: [],
    ...overrides
  };
}

test("module-relative paths become target-relative, including a module rooted at the target", () => {
  assert.equal(targetRelative("web", "src/page.ts"), "web/src/page.ts");
  assert.equal(targetRelative("", "src/page.ts"), "src/page.ts");
  assert.equal(targetRelative("web", "./src/page.ts"), "web/src/page.ts");
  assert.equal(targetRelative("web", ""), "web");
});
