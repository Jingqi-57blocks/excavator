// Unit cache identity readings of the two R0 baselines (57B-434 R6a).
//
// `eval/golden/unit-cache-identity-readings-{wcp,cebreo}.json` are produced by
// `npm run eval -- unit-cache-identity-readings --run <dir> --out <file>` against the archival run directories (which are
// NOT in this repository). They are records, not assertions about a run this suite can re-derive — so what is
// asserted here is their INTERNAL consistency plus the readings this slice exists to produce:
//
// THE LAW ABOUT DIGESTS IN A GOLDEN, and it was written in blood (57B-434 R6c). A digest may be checked in only if
// CI can recompute it from an input that is in this repository, OR the contract version it was minted under is
// recorded beside it and pinned to the code's own constant. A digest with neither is 64 characters nothing asserts:
// R6b bumped the receipt schema while that version was in the identity key, all 37 `identityDigest` values below
// became numbers this code cannot produce, and the suite stayed green because this file checked only their SHAPE.
// The `contract` field asserted below is the second half of the law for these two records; the first half — a whole
// reading recomputed byte for byte — is `unit-cache-identity-fixture-readings.test.ts`, over the mini fixture, whose
// input is in the repository. Neither replaces the other: this one covers a real corpus, that one covers the code.
//
//   * THE SAME-SOURCE TRIPWIRE, per unit: the identity view and the packet an author reads are ONE composition and
//     they disagree on exactly the three declared plan-global digest lines. The extractor throws on a fourth, and
//     the per-unit label list is recorded here so the safety argument for excluding those three is readable rather
//     than asserted once and forgotten. The byte delta is arithmetic: three 64-character digests replaced by the
//     31-character placeholder is 99 bytes, every unit, both targets;
//   * THE SECOND-AUDIENCE READING, which is the epic's own acceptance: adding a document to the recorded requests
//     rebuilds NOTHING of the documents already planned (wcp: 36 reusable, 0 rebuild, 14 new). That is only
//     satisfiable because the three digest lines are normalized — the un-normalized packets of every existing
//     document differ the moment `requestsDigest` moves;
//   * THE TWO PERTURBATION SHAPES, measured on ONE topic so the difference is attributable. A binding-preserving
//     content change on wcp's `feature:28bd6c37c830540a` rebuilds the 8 units that name it and retires nothing. A
//     binding-SET change to the same topic rebuilds 12 — including the coverage and dimension leaves of every
//     document, which never named it and whose plan rows did not move — and turns 4 parts into new + retired,
//     because a part id is derived from the dimension bucket it carries. The epic's literal ("rebuild the leaf and
//     its ancestors") holds for the first shape and NOT for the second, and that is the finding rather than a bug;
//   * a synthesis unit is NAMED as unidentifiable on an archival run (no collected child summary exists), never
//     silently absent, and therefore reads as `new` in every scenario rather than as reusable;
//   * cebreo's zero-material shape reads as itself: 2 units, one identifiable, and both topic perturbations
//     `not-applicable` BY NAME with the reason, rather than as a zero that looks like a measurement.
//
// A hand-edited number in either file breaks one of those identities.
//
// =================================================================================================================
// WHAT THE THREE NAILS OVER THESE TWO FILES DO AND DO NOT COVER (57B-434, items #3 and #4 of the R8 pre-cleanup).
// Read this before approving a diff to either golden.
//
// The nails:
//   1. THE CONTRACT PIN (below): every reading records the `contract` its digests were minted under, and it is
//      asserted against the code's own constants (`UNIT_IDENTITY_KEY_VERSIONS`). A schema bump that would make
//      these digests unproducible turns this test red instead of leaving 37 stale numbers looking fine.
//   2. THE FUNCTION NAIL: `unit-cache-identity-fixture-readings.test.ts` recomputes a WHOLE reading byte for byte
//      over `tests/fixtures/unit-cache-identity-mini`, whose input IS in this repository, plus a formula witness
//      over the identity composition. A change to the derivation moves that, in CI, with no archive needed.
//   3. THE INTERNAL IDENTITIES (this file): the arithmetic and set relations between the numbers in each record.
//
// THE RESIDUAL EXPOSURE, NAMED: a hand edit of ONE `identityDigest` (or one `bytes` figure) in these two files
// that leaves `contract`, the formula witness and the per-section projection untouched is invisible to all three.
// Closing it would take either checking the archived runs into the repository (their size is not acceptable) or a
// corpus-scale in-repo fixture; the mini fixture already closes the FUNCTION side, and no fixture can close the
// "someone typed a different number for a real run" side. So the residual is a REVIEW obligation, not a covered
// case, and it must not be read as closed.
//
// WHAT A REVIEWER CHECKS ON A GOLDEN DIFF HERE: a digest that moved must move TOGETHER with something that
// explains it — the `contract` version, the formula witness, or the per-section projection of the unit it belongs
// to. An isolated digest change, with the contract and the witness and the section rows all unchanged, is the
// exact shape of a hand edit and is suspect on its face. And a digest that moved must have been RE-DERIVED from
// the archived run by whoever holds it, not adjusted to match: two derivations, byte-identical, stated in the PR.
//
// AND WHEN A READING CAN NO LONGER BE RE-DERIVED AT ALL (item #4): the rule is RETIRE, never label. A golden that
// its contract version made unreproducible is re-derived from the archive (57B-434 R6c's rule). If the ARCHIVE
// itself is gone, the golden is DELETED and the deletion is named in the PR that does it. It is never kept with a
// "stale" marker: a stale label is a fourth state in a file whose whole purpose is to be a measurement, and every
// reader downstream would go on reading it as one.
// =================================================================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AUTHORING_UNIT_KINDS } from "../../src/report/plan-proposal.ts";
import { UNIT_PACKET_FORBIDDEN_INPUT_PREFIXES } from "../../src/report/unit-packet-source.ts";
import { IDENTITY_NORMALIZED_HEADER_LABELS, IDENTITY_NORMALIZED_VALUE } from "../../src/report/unit-packet.ts";
import { UNIT_IDENTITY_KEY_VERSIONS } from "../../src/report/unit-cache-identity.ts";
import { UNIT_CACHE_IDENTITY_READINGS_VERSION, type ScenarioReading, type UnitIdentityReadings } from "../unit-cache-identity-readings.ts";

const HERE = import.meta.dirname;
const READINGS = ["wcp", "cebreo"].map((target) => ({ target, path: join(HERE, "..", "golden", `unit-cache-identity-readings-${target}.json`) }));

/** Three 64-character digests replaced by the placeholder: the whole difference between the two views. */
const NORMALIZED_BYTE_DELTA = IDENTITY_NORMALIZED_HEADER_LABELS.length * (64 - IDENTITY_NORMALIZED_VALUE.length);

const SCENARIOS = [
  "first-run",
  "unchanged",
  "second-audience-document",
  "content-change-smallest-topic",
  "content-change-owner-topic",
  "binding-dropped-owner-topic"
] as const;

const REBUILD_CAUSES = ["identity-changed", "child-not-reusable", "children-unavailable"];

async function readings(path: string): Promise<UnitIdentityReadings> {
  return JSON.parse(await readFile(path, "utf8")) as UnitIdentityReadings;
}

function scenarioOf(row: UnitIdentityReadings, name: string): ScenarioReading {
  const scenario = row.scenarios.find((entry) => entry.scenario === name);
  assert.ok(scenario, `the reading must hold the ${name} scenario`);
  return scenario!;
}

test("every checked-in unit identity reading is internally consistent", async () => {
  for (const { target, path } of READINGS) {
    const row = await readings(path);
    assert.equal(row.version, UNIT_CACHE_IDENTITY_READINGS_VERSION, `${target}: version`);
    // THE VERSION NAIL. The digests below were minted under these versions, and this is the assertion that goes red
    // the next time one of them moves: a bump to the identity formula or to a schema in the key makes this file the
    // batch's own problem instead of leaving 37 unproducible numbers checked in behind a green suite.
    assert.deepEqual(row.contract, UNIT_IDENTITY_KEY_VERSIONS,
      `${target}: this reading's identity digests were minted under ${JSON.stringify(row.contract)}; the current build keys on ${JSON.stringify(UNIT_IDENTITY_KEY_VERSIONS)}, so the reading must be re-generated from its run directory (it is archival and not in this repository) rather than edited`);
    assert.match(row.authorship, /^model-free generator /, `${target}: a deterministic projection is not a model family`);

    // Every planned unit is either identified or named as unidentifiable. No unit is simply absent.
    assert.equal(row.identified.length + row.unidentified.length, row.units, `${target}: every unit is accounted for`);
    assert.deepEqual(row.unitsByKind.map((entry) => entry.kind), [...AUTHORING_UNIT_KINDS], `${target}: one row per unit kind`);
    assert.equal(row.unitsByKind.reduce((total, entry) => total + entry.units, 0), row.units, `${target}: the kinds sum to the unit count`);
    for (const entry of row.unidentified) assert.ok(entry.reason.trim() !== "", `${target}: ${entry.unitId} must say why`);
    assert.equal(row.unidentified.length, row.unitsByKind.find((entry) => entry.kind === "synthesis")!.units,
      `${target}: exactly the synthesis units are unidentifiable on an archival run — nothing else may be`);

    const digests = new Set<string>();
    for (const unit of row.identified) {
      assert.match(unit.identityDigest, /^[0-9a-f]{64}$/, `${target}: ${unit.unitId}`);
      digests.add(unit.identityDigest);
      // THE TRIPWIRE: the two views differ in exactly the three declared lines, and in nothing else.
      assert.deepEqual([...unit.normalizedLabels], [...IDENTITY_NORMALIZED_HEADER_LABELS],
        `${target}: ${unit.unitId} - the identity view may normalize only the three declared plan-global digests`);
      assert.equal(unit.packetBytes - unit.viewBytes, NORMALIZED_BYTE_DELTA,
        `${target}: ${unit.unitId} - the normalization is three digests replaced in place, and nothing else`);
      assert.equal(unit.sections, unit.sectionHeadings.length, `${target}: ${unit.unitId}`);
      assert.equal(unit.sectionHeadings[0], "(packet header)", `${target}: ${unit.unitId}`);
      assert.ok(unit.sections >= 5, `${target}: ${unit.unitId} - a packet has more than four sections; a collapsed split would make every rebuild reason useless`);
      assert.notEqual(unit.kind, "synthesis", `${target}: a synthesis identity cannot be computed from an archival run`);
    }
    assert.equal(digests.size, row.identified.length,
      `${target}: two units with one identity is the collapse this slice exists to prevent`);

    assert.deepEqual(row.scenarios.map((scenario) => scenario.scenario), [...SCENARIOS], `${target}: the scenario set is fixed`);
    for (const scenario of row.scenarios) {
      assert.ok(scenario.perturbation.trim() !== "", `${target}: ${scenario.scenario} must state what it changed`);
      const outcome = scenario.outcome;
      if (outcome.state === "not-applicable") {
        assert.ok(outcome.reason.trim() !== "", `${target}: ${scenario.scenario} must say why it does not apply`);
        continue;
      }
      // Both conservation equations, read from the outside.
      assert.equal(outcome.reusable.length + outcome.rebuild.length + outcome.new.length, outcome.plannedUnits,
        `${target}: ${scenario.scenario} - a planned unit in no bucket is a unit nothing would write`);
      assert.equal(outcome.reusable.length + outcome.rebuild.length + outcome.retired.length, outcome.candidateUnits,
        `${target}: ${scenario.scenario} - a candidate in no bucket is a verified draft nobody decided about`);
      assert.deepEqual(outcome.conservation, [
        `planned = reusable + rebuild + new: ${outcome.plannedUnits} = ${outcome.reusable.length} + ${outcome.rebuild.length} + ${outcome.new.length}`,
        `candidates = reusable + rebuild + retired: ${outcome.candidateUnits} = ${outcome.reusable.length} + ${outcome.rebuild.length} + ${outcome.retired.length}`
      ], `${target}: ${scenario.scenario}`);
      const named = [...outcome.reusable, ...outcome.rebuild.map((entry) => entry.unitId), ...outcome.new];
      assert.equal(new Set(named).size, named.length, `${target}: ${scenario.scenario} - one unit, one bucket`);
      for (const entry of outcome.rebuild) {
        assert.ok(REBUILD_CAUSES.includes(entry.cause), `${target}: ${scenario.scenario} - ${entry.cause} is not a rebuild cause`);
        if (entry.cause !== "identity-changed") continue;
        assert.ok(entry.changedSections.length + entry.changedTerms.length > 0,
          `${target}: ${scenario.scenario} - ${entry.unitId} rebuilt for a changed identity with neither a section nor a term naming what moved`);
        assert.deepEqual([...entry.changedTerms], [],
          `${target}: ${scenario.scenario} - ${entry.unitId}: this projection perturbs the CATALOG, so no term it was written under may move`);
      }
      // Every synthesis is unidentifiable here, so no scenario may ever call one reusable.
      for (const unitId of outcome.reusable) {
        assert.equal(row.unidentified.some((entry) => entry.unitId === unitId), false,
          `${target}: ${scenario.scenario} - ${unitId} has no identity and cannot be reused`);
      }
    }

    // The first run reads as itself: no candidate, everything new, and the reason the set is empty.
    const first = scenarioOf(row, "first-run").outcome;
    if (first.state !== "derived") throw new Error(`${target}: the first-run scenario always applies`);
    assert.equal(first.candidateUnits, 0, `${target}`);
    assert.equal(first.new.length, first.plannedUnits, `${target}: a first run writes every unit`);
    assert.match(first.candidateStatement, /^0 prior verified units: /, `${target}: the empty set is declared, with its reason`);

    // The unchanged plan against its own identities: nothing is rebuilt, ever.
    const unchanged = scenarioOf(row, "unchanged").outcome;
    if (unchanged.state !== "derived") throw new Error(`${target}: the unchanged scenario always applies`);
    assert.deepEqual(unchanged.rebuild, [], `${target}: the same inputs must produce the same identity`);
    assert.equal(unchanged.reusable.length, row.identified.length, `${target}`);
    assert.equal(unchanged.new.length, row.unidentified.length, `${target}: only the unidentifiable units are new`);
    assert.deepEqual(unchanged.retired, [], `${target}`);

    // THE EPIC'S ACCEPTANCE: a document added to the request set rebuilds nothing that was already planned.
    const second = scenarioOf(row, "second-audience-document").outcome;
    if (second.state === "derived") {
      assert.deepEqual(second.rebuild, [], `${target}: a second audience must not rewrite the first one's documents`);
      assert.deepEqual(second.retired, [], `${target}: nor retire any of them`);
      assert.equal(second.reusable.length, row.identified.length, `${target}: every identifiable unit is reused`);
      assert.ok(second.plannedUnits > unchanged.plannedUnits, `${target}: the added document brings its own units`);
    }

    for (const readPath of row.readPaths) {
      for (const prefix of UNIT_PACKET_FORBIDDEN_INPUT_PREFIXES) {
        assert.ok(!readPath.startsWith(prefix), `${target}: ${readPath} is an authoring-side input`);
      }
    }
  }
});

test("the wcp reading: 36 identities, a reused second audience, and two perturbation shapes that differ", async () => {
  const row = await readings(READINGS[0]!.path);
  assert.equal(row.units, 40);
  assert.equal(row.identified.length, 36);
  assert.deepEqual(row.unidentified.map((entry) => entry.unitId).sort(), [
    "feature-晋升管理-01e5065d19-engineering::synthesis::document",
    "feature-请假管理-8c2d685d81-product::synthesis::document",
    "overview-engineering::synthesis::document",
    "overview-product::synthesis::document"
  ]);

  // The second audience: 36 of 36 reused, 14 new (the added document's 10 units and the four document roots, which
  // have no identity on an archival run at all).
  const second = scenarioOf(row, "second-audience-document").outcome;
  if (second.state !== "derived") throw new Error("wcp can express a second audience for one of its features");
  assert.equal(second.plannedUnits, 50);
  assert.equal(second.reusable.length, 36);
  assert.equal(second.new.length, 14);

  // (a) A BINDING-PRESERVING content change on the topic that owns 327 obligations: the eight units that NAME it,
  // and nothing else. No part id moves, so nothing is retired.
  const content = scenarioOf(row, "content-change-owner-topic");
  assert.match(content.perturbation, /^binding-preserving: the title of topic feature:28bd6c37c830540a /);
  if (content.outcome.state !== "derived") throw new Error("wcp holds an owning topic with two bindings");
  assert.equal(content.outcome.rebuild.length, 8);
  assert.equal(content.outcome.reusable.length, 28);
  assert.deepEqual(content.outcome.retired, [], "a content change cannot rename a part: the ids are derived from the obligations, not the title");
  assert.ok(content.outcome.rebuild.every((entry) => entry.unitId.includes("#t-28bd6c37c830540a#")),
    `only the parts of that topic: ${content.outcome.rebuild.map((entry) => entry.unitId).join(", ")}`);

  // (b) A BINDING-SET change to THE SAME topic: strictly more, and of a different shape. Twelve rebuilt — the
  // coverage and work-item-dimension leaves of all four documents among them, which never named this topic — and
  // four parts replaced rather than rebuilt, because the dropped obligation was the whole `api-entrypoints`
  // dimension bucket that part id was derived from. "Rebuild the leaf and its ancestors" does not describe this.
  const bindings = scenarioOf(row, "binding-dropped-owner-topic");
  assert.match(bindings.perturbation, /^binding-set: topic feature:28bd6c37c830540a /);
  if (bindings.outcome.state !== "derived") throw new Error("wcp holds an owning topic with two bindings");
  assert.equal(bindings.outcome.rebuild.length, 12);
  assert.equal(bindings.outcome.reusable.length, 20);
  assert.deepEqual(bindings.outcome.retired.map((unitId) => unitId.split("::").slice(1).join("::")).sort(), [
    "leaf::feature#t-28bd6c37c830540a#d-api-entrypoints",
    "leaf::feature#t-28bd6c37c830540a#d-api-entrypoints",
    "leaf::feature#t-28bd6c37c830540a#d-api-entrypoints",
    "leaf::feature#t-28bd6c37c830540a#d-api-entrypoints"
  ], "one retired part per document: a part id is derived from the dimension bucket it carries");
  assert.equal(bindings.outcome.new.filter((unitId) => unitId.includes("#d-authorization")).length, 4,
    "and the replacement part is named by the dimension the bucket now leads with");
  // The siblings that never named the topic: their OWNERSHIP environment moved, so their packets moved.
  for (const documentId of ["overview-product", "overview-engineering", "feature-请假管理-8c2d685d81-product", "feature-晋升管理-01e5065d19-engineering"]) {
    for (const suffix of ["leaf::coverage", "leaf::work-item-dimension"]) {
      const entry = bindings.outcome.rebuild.find((row) => row.unitId === `${documentId}::${suffix}`);
      assert.ok(entry, `${documentId}::${suffix} must be rebuilt: the obligation it used to stub is now owned elsewhere`);
      assert.ok(entry!.changedSections.some((section) => section.includes("Ownership and scope") || section.includes("Obligations bound")),
        `${documentId}::${suffix}: ${entry!.changedSections.join(" | ")}`);
    }
  }
  // The two shapes are not the same reading, and the difference is ownership plus part identity.
  assert.ok(bindings.outcome.rebuild.length + bindings.outcome.retired.length > content.outcome.rebuild.length + content.outcome.retired.length,
    "a binding-set change invalidates strictly more than a content change on the same topic");

  // The cheapest possible change, for contrast: one non-owning dimension topic's title moves four units.
  const smallest = scenarioOf(row, "content-change-smallest-topic");
  if (smallest.outcome.state !== "derived") throw new Error("wcp holds a material topic");
  assert.match(smallest.perturbation, /owner of an obligation somewhere: no/);
  assert.equal(smallest.outcome.rebuild.length, 4);
  assert.ok(smallest.outcome.rebuild.every((entry) => entry.unitId.endsWith("::leaf::work-item-dimension")),
    smallest.outcome.rebuild.map((entry) => entry.unitId).join(", "));
});

test("the cebreo reading is the zero-material shape: 2 units, 1 identity, both topic perturbations named", async () => {
  const row = await readings(READINGS[1]!.path);
  assert.equal(row.units, 2);
  assert.deepEqual(row.unitsByKind, [
    { kind: "appendix", units: 1 },
    { kind: "bridge", units: 0 },
    { kind: "leaf", units: 0 },
    { kind: "synthesis", units: 1 }
  ]);
  assert.equal(row.identified.length, 1);
  const appendix = row.identified[0]!;
  assert.equal(appendix.kind, "appendix");
  // The appendix is where cebreo's `ledger-absent` / `ledger-empty` sentences live, and its identity covers them:
  // the facet census and the unbound-evidence tail are sections of the view like any other.
  assert.ok(appendix.sectionHeadings.some((heading) => heading.includes("Facet census")), appendix.sectionHeadings.join(" | "));
  assert.ok(appendix.sectionHeadings.some((heading) => heading.includes("Evidence this run captured that no obligation binds")), appendix.sectionHeadings.join(" | "));
  assert.deepEqual(row.unidentified.map((entry) => entry.unitId), ["overview-product::synthesis::document"]);

  const first = scenarioOf(row, "first-run").outcome;
  if (first.state !== "derived") throw new Error("the first-run scenario always applies");
  assert.deepEqual([...first.new].sort(), ["overview-product::appendix::coverage", "overview-product::synthesis::document"]);
  assert.equal(first.candidateStatement, "0 prior verified units: this projection offers no prior verified unit: an archival run has authored none");

  // Zero material topics: the two topic perturbations do not apply, and they say so rather than reading as zero.
  for (const name of ["content-change-smallest-topic", "content-change-owner-topic", "binding-dropped-owner-topic"]) {
    const scenario = scenarioOf(row, name);
    assert.equal(scenario.outcome.state, "not-applicable", name);
    if (scenario.outcome.state !== "not-applicable") throw new Error(name);
    assert.match(scenario.outcome.reason, /no material topic|no owning topic|OWNS an obligation/, name);
  }
  // But the second audience still applies here, and it reuses the one identity this target has.
  const second = scenarioOf(row, "second-audience-document").outcome;
  if (second.state !== "derived") throw new Error("cebreo requests one overview, so the other audience is available");
  assert.deepEqual(second.reusable, ["overview-product::appendix::coverage"]);
  assert.deepEqual(second.rebuild, []);
  assert.equal(second.plannedUnits, 4);
});
