// Golden byte pin for `assemble --units` (57B-434 R7b), on the model-free unit chain: prepare -> freeze -> plan ->
// draft every unit -> collect -> assemble --units --mode write. Same discipline as `assemble-golden.test.ts`, one
// world over.
//
// WHY IT IS PINNED ON A SYNTHETIC FIXTURE AND SAYS SO. The epic's two R0 baselines hold SECTION drafts, not unit
// drafts — nothing has ever authored a unit into either of them — so there is no archival run whose unit-path bytes
// could be projected. That is not a gap in this nail: it is the same shape `assemble-golden.test.ts` has, whose
// golden is also a canned-draft chain over `tests/fixtures/sample-target`. The input is IN THIS REPOSITORY, so CI
// recomputes every byte below on every run, which is exactly the property the two archival identity readings cannot
// have (see `unit-cache-identity-fixture-readings.test.ts` for the general law).
//
// WHAT THE GOLDEN IS SENSITIVE TO, both directions:
//
//   * positive — two INDEPENDENT runs of the fixture write DIFFERENT raw bytes (their run id, plan digest and
//     knowledge digest all differ) and project to the SAME canonical bytes, which equal the golden; every
//     substitution rule that fires is asserted to fire and every rule that must NOT fire is asserted at zero.
//   * negative — re-drafting one unit with one character changed, and re-collecting and re-assembling, moves the
//     golden by exactly that one character. A byte a model wrote is never invisible to this pin.
//
// THE `iso-instant` RULE FIRING ZERO TIMES IS THE DETERMINISM ASSERTION, not an omission. Nothing the unit path
// writes into `reports/` carries a clock reading, so any timestamp injected into the deliverable would both fire
// that rule and move the golden.
//
// THE CANNED DRAFT THIS PINS is `unitContent` in `tests/unit-fixture.ts` — the shared model-free draft generator.
// Editing it moves this golden on purpose; the negative test below is what proves the sensitivity is real rather
// than assumed. That draft now writes the NUMBERED CHAPTERS the document owes (one per template-section
// requirement row this run recorded, dealt across the document's units in assembly order), because every report
// template states its `##` chapters are the fixed contract of the deliverable and a fixture whose deliverable
// ignored that contract was not shaped like the artifact it stands for.
//
// REGENERATING IT, when a reviewed change moves it (verified to reproduce the checked-in bytes exactly, from the
// repository root):
//
//   node --experimental-strip-types --input-type=module-typescript --eval '
//     import { writeFileSync } from "node:fs";
//     import { assembleUnits } from "./src/run/stages/unit-assemble-stage.ts";
//     import { collectedRun } from "./tests/unit-assembly-fixture.ts";
//     import { canonicalUnitAssembleProjection } from "./eval/unit-assemble-canonical.ts";
//     const run = await collectedRun();
//     await assembleUnits(run.runDir, "write");
//     writeFileSync("eval/golden/unit-assemble-canonical.txt", canonicalUnitAssembleProjection(run.runDir).text);
//   '

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assembleUnits } from "../../src/run/stages/unit-assemble-stage.ts";
import { unitDocumentReportPath } from "../../src/report/unit-assembly-paths.ts";
import { collectedRun, redraftUnit } from "../../tests/unit-assembly-fixture.ts";
import { chapterOrdinalsFor } from "../../tests/fixture-chapters.ts";
import { unitContent, type PlannedRun } from "../../tests/unit-fixture.ts";
import { canonicalUnitAssembleProjection } from "../unit-assemble-canonical.ts";

const GOLDEN = join(import.meta.dirname, "..", "golden", "unit-assemble-canonical.txt");
const DOCUMENT_ID = "overview-product";

/** The model-free chain, end to end. Returns the run it assembled. */
async function assembledRun(): Promise<PlannedRun> {
  const run = await collectedRun();
  await assembleUnits(run.runDir, "write");
  return run;
}

const golden = readFileSync(GOLDEN, "utf8");
const first = await assembledRun();
const second = await assembledRun();

test("two independent runs write different unit-path bytes and project to the same canonical bytes as the golden", async () => {
  const rawFirst = await readFile(join(first.runDir, "reports", `${DOCUMENT_ID}.md`), "utf8");
  const rawSecond = await readFile(join(second.runDir, "reports", `${DOCUMENT_ID}.md`), "utf8");
  assert.notEqual(rawFirst, rawSecond, "the raw documents must differ, otherwise the canonical projection proves nothing");

  const a = canonicalUnitAssembleProjection(first.runDir);
  const b = canonicalUnitAssembleProjection(second.runDir);
  assert.deepEqual(a.files, [
    `companions/${DOCUMENT_ID}.unit-claims.json`,
    `companions/${DOCUMENT_ID}.unit-traces.json`,
    "companions/unit-coverage.md",
    `${DOCUMENT_ID}.md`
  ], "the unit path writes exactly these four files; a section report in the same run would show up here");
  assert.deepEqual(a.files, b.files);
  assert.equal(a.text, b.text, "the same fixture must project to the same canonical bytes");
  assert.equal(a.text, golden, "the canonical projection must equal the checked-in golden");
  assert.equal(Buffer.compare(Buffer.from(a.text), Buffer.from(golden)), 0);
});

test("assembling the same run twice leaves the canonical projection byte-identical", async () => {
  const before = canonicalUnitAssembleProjection(first.runDir).text;
  await assembleUnits(first.runDir, "write");
  const after = canonicalUnitAssembleProjection(first.runDir).text;
  assert.equal(after, before, "a second assemble must not move a byte");
  assert.equal(after, golden);
});

test("every substitution rule that must fire fires, every rule that must not is zero, and nothing volatile survives", () => {
  const projection = canonicalUnitAssembleProjection(second.runDir);
  const fired = Object.fromEntries(projection.applied.map((rule) => [rule.name, rule.replacements]));
  for (const name of ["evidence-id", "run-id", "plan-catalog-digest", "knowledge-digest"]) {
    assert.ok((fired[name] ?? 0) > 0, `rule ${name} must fire (fired ${JSON.stringify(fired)})`);
  }
  // The unit path prints neither the snapshot id nor the target, and — the determinism assertion — no instant.
  assert.deepEqual(
    [fired["snapshot-id"], fired["target-path"], fired["target-name"], fired["iso-instant"]],
    [0, 0, 0, 0],
    `an assembled unit document carries no snapshot id, no target path and NO CLOCK READING: ${JSON.stringify(fired)}`
  );

  const { identity, digests } = projection;
  // The system temp area is reached through the FIXTURE's own target path rather than by naming the OS helper for
  // it: the fixture target is minted directly inside that area, so its parent IS that directory. Deriving it from
  // the run also keeps this file out of the per-file table in `tests/temp-dir-census.test.ts`, which counts every
  // mention of that helper — including one in a comment — because a text rule cannot tell prose from a call.
  for (const literal of [identity.runId, identity.snapshotId, identity.targetPath, identity.targetName, digests.planCatalogDigest, digests.knowledgeDigest, second.runDir, dirname(identity.targetPath)]) {
    assert.ok(!projection.text.includes(literal), `canonical projection must not contain ${literal}`);
  }
  for (const id of Object.keys(identity.evidencePlaceholders)) assert.ok(!projection.text.includes(id), `canonical projection must not contain evidence id ${id}`);
  // The front matter kept its lines — the values were replaced, the structure was not.
  assert.ok(projection.text.includes("run: \"<RUN-ID>\""));
  assert.ok(projection.text.includes("planCatalogDigest: <PLAN-CATALOG-DIGEST>"));
  assert.ok(projection.text.includes("knowledgeDigest: <KNOWLEDGE-DIGEST>"));
  assert.ok(projection.text.includes("knowledgeEpoch: 0"));
});

test("the projection refuses to describe the two digests with one placeholder", () => {
  // A construction guard, stated because it is the shape that would make the two rules lie: if a run ever produced
  // one value for both digests, one placeholder could not tell a swap between them apart.
  const projection = canonicalUnitAssembleProjection(first.runDir);
  assert.notEqual(projection.digests.planCatalogDigest, projection.digests.knowledgeDigest);
  assert.match(projection.digests.planCatalogDigest, /^[0-9a-f]{64}$/);
  assert.match(projection.digests.knowledgeDigest, /^[0-9a-f]{64}$/);
});

test("a one-character edit to a drafted unit moves the canonical projection off the golden", async () => {
  const unitId = second.view.collectionOrder.find((id) => id.includes("::synthesis::"))!;
  const original = await readFile(join(second.runDir, "reports", `${DOCUMENT_ID}.md`), "utf8");
  assert.ok(original.includes(`${unitId} 记录当前状态。`), "the canned draft must contain the byte this test flips");
  // Re-drafted and re-collected rather than edited on disk: the ledger row vouches for these bytes, so an edit
  // behind its back is refused by assemble (and that refusal is `tests/unit-assemble.test.ts`'s business). The
  // supported way to change a unit's prose is to write it again.
  // Built FROM the canned generator rather than typed out beside it, so this unit keeps the exact chapters the
  // document owes and the only difference from the golden is the one character. Spelling the prose here a second
  // time would make this test go red for a chapter that moved, which is not the sensitivity it is asserting.
  const redrafted = second.view.byId.get(unitId)!;
  const canned = unitContent(redrafted, await chapterOrdinalsFor(second.runDir, second.view, redrafted));
  // A string replacement hits the FIRST occurrence only, which is the one sentence this flip is aimed at.
  await redraftUnit(second, unitId, canned.replace("记录当前状态", "记录当時状态"));
  await assembleUnits(second.runDir, "write");

  const mutated = canonicalUnitAssembleProjection(second.runDir).text;
  assert.notEqual(mutated, golden, "a drafted byte must not be invisible to the golden");
  assert.equal(mutated.length, golden.length, "the edit replaced one character, so the length must not move");
  const differences = [...mutated].map((character, index) => ({ index, mutated: character, golden: golden[index] })).filter((entry) => entry.mutated !== entry.golden);
  assert.equal(differences.length, 1, JSON.stringify(differences));
  assert.deepEqual([differences[0]!.mutated, differences[0]!.golden], ["時", "前"]);
});

test("the golden is a document, not a stub: it holds the front matter, the contents table and both units' prose", () => {
  for (const fragment of [
    `===== file: ${DOCUMENT_ID}.md =====`,
    "assembly: unit-assembly-v1",
    "## Contents",
    "| # | unit | kind | parent |",
    "## Companions",
    "[contents](#contents)",
    "This document states no coverage figure of its own.",
    "===== file: companions/unit-coverage.md =====",
    // Gate 10 reaching the deliverable: an empty denominator says `vacuous`, not "complete".
    "vacuous (ledger-empty)"
  ]) {
    assert.ok(golden.includes(fragment), `the golden must contain ${JSON.stringify(fragment)}`);
  }
  assert.ok(!/\d+%/.test(golden), "no assembled unit-path artifact states a percentage");
  assert.equal(unitDocumentReportPath(DOCUMENT_ID), `reports/${DOCUMENT_ID}.md`);
});
