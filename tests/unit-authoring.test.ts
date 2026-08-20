import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TimelineEvent } from "../src/base/types.ts";
import { auditTimeline, readTimeline } from "../src/base/timeline.ts";
import { exists } from "../src/base/util.ts";
import { freezeRun, searchSourceEvidence } from "../src/run/run.ts";
import { planRun } from "../src/run/stages/plan-stage.ts";
import { checkpointUnit } from "../src/report/unit-checkpoint.ts";
import { collectUnits } from "../src/report/unit-collect.ts";
import { draftUnit } from "../src/report/unit-draft.ts";
import { readUnitLedger } from "../src/report/unit-ledger.ts";
import { unitPaths } from "../src/report/unit-paths.ts";
import { loadUnitPlanView, unitCollectionOrder } from "../src/report/unit-plan-view.ts";
import { resumeUnits, unitStatus } from "../src/report/unit-status.ts";
import { UNIT_SUMMARY_VERSION } from "../src/report/unit-output.ts";
import {
  frozenRun, manifestOf, planWithLeaf, planWithRenamedUnits, plannedRun, unitDraftFor, type PlannedRun
} from "./unit-fixture.ts";

/**
 * R4a - the authoring-unit execution path, end to end and model-free.
 *
 * The chain is prepare -> freeze -> plan (deterministic fixture plan) -> concurrent unit draft -> collect ->
 * status/resume. It is the unit twin of `parallel-authoring.test.ts`, and it makes the same safety argument the
 * section path makes: `draft` is provably isolated from the shared ledger (so any number run concurrently), and
 * `collect` is the single-writer barrier whose serial appends produce a chain that passes the same hash audit.
 * What is NEW here is the primary key: everything is keyed by `AuthoringUnitId` instead of
 * `(documentId, sectionIndex)`, and every unit carries a REQUIRED summary.
 *
 * The tests on the shared run are ordered - draft isolation before the barrier, revision after it - because that
 * is the sequence a run actually goes through, and each one asserts the state the previous one left.
 *
 * The sample target's catalog holds no material topic, which makes its fixture plan the ZERO-MATERIAL shape the
 * epic's second baseline target has: one appendix plus one synthesis per document, no leaf at all. That shape is
 * asserted rather than worked around, and the leaf path gets its own plan below.
 */

let shared: Promise<PlannedRun> | null = null;
function sharedRun(): Promise<PlannedRun> { return (shared ??= plannedRun(["product", "engineering"])); }

function unitEvents(events: TimelineEvent[]): TimelineEvent[] {
  return events.filter((event) => event.action === "unit.checkpoint" || event.action === "unit.revised");
}

function unitIdOf(event: TimelineEvent): string {
  return (event.data as Record<string, unknown>).unitId as string;
}

function unitsOfKind(run: PlannedRun, kind: string): string[] {
  return run.view.collectionOrder.filter((unitId) => run.view.byId.get(unitId)!.kind === kind);
}

// --- (0) the collection order, as a pure function -----------------------------------------------------

test("the collection order is documents ascending then each document's authoring order, and it covers every unit", () => {
  const documents = [
    { documentId: "overview-product", authoringOrder: ["op::leaf", "op::root"] },
    { documentId: "overview-engineering", authoringOrder: ["oe::leaf", "oe::root"] }
  ];
  assert.deepEqual(unitCollectionOrder(["oe::leaf", "oe::root", "op::leaf", "op::root"], documents),
    ["oe::leaf", "oe::root", "op::leaf", "op::root"]);
  // A unit missing from the order would be skipped by collect with every count still adding up.
  assert.throws(() => unitCollectionOrder(["oe::leaf", "oe::root", "op::leaf", "op::root", "op::extra"], documents),
    /covers 4 of this plan's 5 unit\(s\); a unit missing from the order would be skipped by collect without anything saying so/);
  assert.throws(() => unitCollectionOrder(["oe::leaf", "oe::root", "op::leaf"], documents),
    /covers 4 of this plan's 3 unit\(s\)/);
  assert.throws(() => unitCollectionOrder(["oe::leaf", "oe::root", "op::leaf", "op::other"], documents),
    /names "op::root", which is not a unit of this plan/);
});

// --- (1) the plan shape this target yields, stated rather than assumed ---------------------------------

test("the fixture plan on a zero-material catalog is appendix plus synthesis, and the order puts children first", async () => {
  const run = await sharedRun();
  assert.deepEqual(run.view.units.map((unit) => unit.kind).sort(), ["appendix", "appendix", "synthesis", "synthesis"],
    "the sample target has no material topic, so the fixture plan mints no leaf - the cebreo-shaped plan");
  assert.deepEqual(run.view.collectionOrder, [
    "overview-engineering::appendix::coverage", "overview-engineering::synthesis::document",
    "overview-product::appendix::coverage", "overview-product::synthesis::document"
  ], "documents ascending, then each document's authoring order");
  assert.equal(run.view.knowledgeEpoch, 0);
  // Before any draft: an empty barrier records nothing and does not even create the ledger it owns.
  assert.deepEqual((await collectUnits(run.runDir)).collected, []);
  assert.equal(await exists(join(run.runDir, "units", "collected.json")), false,
    "a collect with nothing pending must not write the ledger");
});

// --- (2) draft isolation: the shared ledger is byte-unchanged; the four per-unit artifacts land --------

test("concurrent unit drafts write only their own artifacts and leave timeline/run/metrics byte-identical", async () => {
  const run = await sharedRun();
  const before = {
    timeline: await readFile(join(run.runDir, "timeline.jsonl")),
    run: await readFile(join(run.runDir, "run.json")),
    metrics: await readFile(join(run.runDir, "metrics.json"))
  };
  const appendices = unitsOfKind(run, "appendix");
  assert.equal(appendices.length, 2);

  const receipts = await Promise.all(appendices.map(async (unitId) => draftUnit(run.runDir, await unitDraftFor(run, unitId))));

  assert.ok((await readFile(join(run.runDir, "timeline.jsonl"))).equals(before.timeline), "draft must not touch timeline.jsonl");
  assert.ok((await readFile(join(run.runDir, "run.json"))).equals(before.run), "draft must not touch run.json");
  assert.ok((await readFile(join(run.runDir, "metrics.json"))).equals(before.metrics), "draft must not touch metrics.json");
  assert.equal(await exists(join(run.runDir, "units", "collected.json")), false, "draft must not write the collect-owned ledger");

  for (const [index, unitId] of appendices.entries()) {
    const paths = unitPaths(run.runDir, unitId);
    for (const path of [paths.content, paths.claims, paths.summary, paths.receipt]) assert.ok(await exists(path), path);
    assert.equal(receipts[index]!.unitId, unitId);
    assert.equal(receipts[index]!.revision, false);
    assert.equal(receipts[index]!.knowledgeEpoch, 0);
    assert.equal(receipts[index]!.planCatalogDigest, run.view.planCatalogDigest);
  }
  // A synthesis may not be drafted while its children are uncollected: its only input does not exist yet.
  const synthesis = unitsOfKind(run, "synthesis")[0]!;
  await assert.rejects(async () => draftUnit(run.runDir, await unitDraftFor(run, synthesis)),
    /cannot be drafted yet: its child .* has not been collected, and a synthesis writes from child summaries only/);
});

// --- (3) collect: plan order, contiguous chain, ledger rows -------------------------------------------

test("collect records the drafted units in plan order with a contiguous, valid hash chain", async () => {
  const run = await sharedRun();
  const expected = unitsOfKind(run, "appendix");
  const { collected, ledger } = await collectUnits(run.runDir);
  assert.deepEqual(collected.map((receipt) => receipt.unitId), expected, "collection order comes from the plan, not from draft completion");

  const events = unitEvents(await readTimeline(run.runDir));
  assert.deepEqual(events.map(unitIdOf), expected);
  const sequences = events.map((event) => event.sequence);
  for (let index = 1; index < sequences.length; index += 1) {
    assert.equal(sequences[index], sequences[index - 1]! + 1, "collected unit events are contiguous");
  }
  assert.deepEqual(await auditTimeline(run.runDir, run.manifest.id), [], "collect produces a chain that passes auditTimeline");
  for (const event of events) {
    assert.equal(event.action, "unit.checkpoint");
    assert.equal((event.data as Record<string, unknown>).collected, true);
    assert.equal((event.data as Record<string, unknown>).kind, "appendix");
  }
  assert.deepEqual(ledger.units.map((unit) => unit.unitId), expected);
  assert.deepEqual(ledger.units.map((unit) => unit.timelineSequence), sequences);
  // The receipt is consumed; the artifacts stay.
  for (const unitId of expected) {
    assert.equal(await exists(unitPaths(run.runDir, unitId).receipt), false);
    assert.ok(await exists(unitPaths(run.runDir, unitId).content));
  }
  // The section world is untouched: no section is complete, and the manifest's own state has not moved.
  const manifest = await manifestOf(run.runDir);
  assert.deepEqual(manifest.documents.flatMap((document) => document.sections.filter((section) => section.complete)), []);
  assert.equal(manifest.state, "prepared");
});

test("an empty collect is a pure no-op: nothing pending, nothing appended", async () => {
  const run = await sharedRun();
  const timeline = await readFile(join(run.runDir, "timeline.jsonl"));
  const ledger = await readFile(join(run.runDir, "units", "collected.json"));
  const result = await collectUnits(run.runDir);
  assert.deepEqual(result.collected, []);
  assert.ok((await readFile(join(run.runDir, "timeline.jsonl"))).equals(timeline));
  assert.ok((await readFile(join(run.runDir, "units", "collected.json"))).equals(ledger));
});

// --- (4) the synthesis half: children collected, so the parents can be written ------------------------

test("with its children collected a synthesis drafts, collects, and references their summary digests", async () => {
  const run = await sharedRun();
  const synthesisUnits = unitsOfKind(run, "synthesis");
  const drafts = await Promise.all(synthesisUnits.map((unitId) => unitDraftFor(run, unitId)));
  await Promise.all(drafts.map((draft) => draftUnit(run.runDir, draft)));
  const { collected, ledger } = await collectUnits(run.runDir);
  assert.deepEqual(collected.map((receipt) => receipt.unitId), synthesisUnits);
  assert.deepEqual(await auditTimeline(run.runDir, run.manifest.id), []);
  assert.deepEqual(ledger.units.map((unit) => unit.unitId).sort(), [...run.view.collectionOrder].sort());

  // The parent's summary names its child at the digest the ledger recorded for it - the only input it may read.
  const parent = JSON.parse(await readFile(unitPaths(run.runDir, synthesisUnits[0]!).summary, "utf8")) as { childSummaryDigests: Array<{ childUnitId: string; summaryDigest: string }>; coveredTopicIds: string[] };
  const child = parent.childSummaryDigests[0]!;
  assert.equal(child.summaryDigest, ledger.units.find((unit) => unit.unitId === child.childUnitId)!.summaryDigest);
  assert.deepEqual(parent.coveredTopicIds, [], "a synthesis hangs no topic, so it covers none directly");

  const status = await unitStatus(run.runDir);
  assert.equal(status.census.collected, 4);
  assert.deepEqual(status.pending, []);
  assert.equal(status.next, null);
  assert.deepEqual(status.superseded, []);
  // Zero pending is a full view with a plan digest - not the refusal a run with no plan gets.
  assert.equal(status.planCatalogDigest, run.view.planCatalogDigest);
  assert.equal(status.units.length, 4);
  assert.deepEqual((await resumeUnits(run.runDir)).pending, []);
});

// --- (5) revision and retry: one unit re-drawn, the others untouched ----------------------------------

test("re-drafting a collected unit archives the version it replaces and collects as a revision", async () => {
  const run = await sharedRun();
  const unitId = unitsOfKind(run, "appendix")[0]!;
  const paths = unitPaths(run.runDir, unitId);
  const others = (await readUnitLedger(run.runDir, run.manifest.id)).units.filter((unit) => unit.unitId !== unitId);

  const draft = await unitDraftFor(run, unitId);
  const receipt = await draftUnit(run.runDir, { ...draft, unitId });
  assert.equal(receipt.revision, true);
  const history = await readdir(paths.historyDir);
  assert.equal(history.length, 3, `content, claims and summary are archived as the set they were written as: ${history.join(", ")}`);

  // Precedence: this unit is BOTH in the ledger and holding a receipt. Uncollected work is the fact to act on.
  const midRevision = await unitStatus(run.runDir);
  assert.equal(midRevision.units.find((row) => row.unitId === unitId)!.state, "drafted");
  assert.deepEqual(midRevision.toCollect, [unitId]);
  assert.deepEqual(midRevision.pending, [unitId]);

  const { collected, ledger } = await collectUnits(run.runDir);
  assert.deepEqual(collected.map((item) => item.unitId), [unitId]);
  const event = unitEvents(await readTimeline(run.runDir)).at(-1)!;
  assert.equal(event.action, "unit.revised");
  assert.equal(unitIdOf(event), unitId);
  // Every other unit's ledger row is byte-identical: a revision touches one row.
  assert.deepEqual(ledger.units.filter((unit) => unit.unitId !== unitId), others);
  assert.equal(ledger.units.find((unit) => unit.unitId === unitId)!.revision, true);
  assert.deepEqual(await auditTimeline(run.runDir, run.manifest.id), []);
});

// --- (6) checkpoint = draft + collect ------------------------------------------------------------------

test("checkpoint is draft plus collect: the event it leaves is the one the two commands leave", async () => {
  const run = await sharedRun();
  const [first, second] = unitsOfKind(run, "appendix");
  const stepwise = unitEvents(await readTimeline(run.runDir)).filter((event) => unitIdOf(event) === first).at(-1)!;

  const result = await checkpointUnit(run.runDir, await unitDraftFor(run, second!));
  assert.deepEqual(result.collected.collected.map((receipt) => receipt.unitId), [second]);
  const combined = unitEvents(await readTimeline(run.runDir)).at(-1)!;

  const project = (event: TimelineEvent): Record<string, unknown> => ({
    stage: event.stage,
    action: event.action,
    evidenceIds: event.evidenceIds,
    traceIds: event.traceIds,
    collected: (event.data as Record<string, unknown>).collected,
    kind: (event.data as Record<string, unknown>).kind
  });
  assert.deepEqual(project(combined), project(stepwise), "a checkpointed unit and a drafted-then-collected unit record the same event");
  assert.deepEqual(await auditTimeline(run.runDir, run.manifest.id), []);
});

// --- (7) bad units fail at draft time, each by its own name -------------------------------------------

test("a bad unit is refused at draft time, and each refusal names what is wrong", async () => {
  const run = await sharedRun();
  const unitId = unitsOfKind(run, "appendix")[0]!;
  const good = await unitDraftFor(run, unitId);

  await assert.rejects(() => draftUnit(run.runDir, { ...good, unitId: "overview-product::leaf::absent" }),
    /Unknown authoring unit "overview-product::leaf::absent"; this run's validated plan holds 4 unit\(s\)/);
  await assert.rejects(() => draftUnit(run.runDir, { ...good, unitId: "overview-product::appendix::COVERAGE" }),
    /Unknown authoring unit "overview-product::appendix::COVERAGE"/);
  await assert.rejects(() => draftUnit(run.runDir, { ...good, claims: [{ id: "C-1", marker: "fact", statement: "" }] }),
    new RegExp(`Invalid claim in unit ${unitId}`));
  await assert.rejects(() => draftUnit(run.runDir, { ...good, summary: undefined }),
    /is not a valid unit summary: is undefined, not a summary object/);
  await assert.rejects(() => draftUnit(run.runDir, { ...good, summary: { ...(good.summary as object), keyStatements: [] } }),
    /is not a valid unit summary: keyStatements holds 0 entr\(ies\)/);
  await assert.rejects(() => draftUnit(run.runDir, { ...good, summary: { ...(good.summary as object), coveredTopicIds: [] } }),
    /disagrees with this run: covers topic\(s\) \[\] but the plan gives this unit \[coverage:/);
  await assert.rejects(() => draftUnit(run.runDir, { ...good, summary: { ...(good.summary as object), contentDigest: "f".repeat(64) } }),
    /disagrees with this run: records contentDigest f{64} but the content beside it digests to [0-9a-f]{64}/);
  await assert.rejects(() => draftUnit(run.runDir, { ...good, content: "   " }), /Section content is empty/);
});

// --- (8) three states, and what would have been a fourth ----------------------------------------------

test("a leaf plan gives all three unit states at once, and the leaf covers exactly its plan topics", async () => {
  const base = await frozenRun();
  const leafId = await planWithLeaf(base.runDir, base.workdir, "work-item-dimension", 3);
  const run: PlannedRun = { ...base, view: await loadUnitPlanView(base.runDir) };
  assert.equal(run.view.units.length, 3);
  assert.deepEqual(run.view.byId.get(leafId)!.topics.length, 3);

  const leafDraft = await unitDraftFor(run, leafId);
  assert.equal((leafDraft.summary as { coveredTopicIds: string[] }).coveredTopicIds.length, 3);
  await draftUnit(run.runDir, leafDraft);
  await collectUnits(run.runDir);
  const appendixId = run.view.collectionOrder.find((unitId) => run.view.byId.get(unitId)!.kind === "appendix")!;
  await draftUnit(run.runDir, await unitDraftFor(run, appendixId));

  const status = await unitStatus(run.runDir);
  assert.deepEqual(status.units.map((row) => [row.unitId, row.state]), [
    [appendixId, "drafted"],
    [leafId, "collected"],
    [run.view.collectionOrder.at(-1)!, "unwritten"]
  ]);
  assert.deepEqual(status.census, { collected: 1, drafted: 1, unwritten: 1 });
  assert.deepEqual(status.toCollect, [appendixId]);
  assert.deepEqual(status.toDraft, [], "the only unwritten unit is a synthesis whose child is not collected yet");
  assert.equal(status.next, null);
  assert.deepEqual(status.pending, [appendixId, run.view.collectionOrder.at(-1)!]);

  // Collect the appendix and the synthesis becomes draftable: `next` is derived, never recorded.
  await collectUnits(run.runDir);
  const after = await unitStatus(run.runDir);
  assert.equal(after.next, run.view.collectionOrder.at(-1)!);
  assert.deepEqual(after.census, { collected: 2, drafted: 0, unwritten: 1 });

  /*
   * What would have been the fourth state. A receipt from a superseded epoch, and one naming a unit this plan
   * does not hold, are bytes on disk that are not a state of any current unit. Both are written by hand here -
   * that is exactly the shape a re-freeze or a re-plan leaves behind - and both come back in `superseded` with
   * the reason, while the unit they sit next to still reads `unwritten`.
   */
  const synthesisId = run.view.collectionOrder.at(-1)!;
  const stale = {
    version: "unit-receipt-v1", runId: run.manifest.id, knowledgeEpoch: 99,
    planCatalogDigest: run.view.planCatalogDigest, unitId: synthesisId, documentId: run.view.byId.get(synthesisId)!.documentId,
    kind: "synthesis", draftedAt: "2026-08-20T00:00:00.000Z", revision: false,
    contentDigest: "a".repeat(64), claimsDigest: "a".repeat(64), summaryDigest: "a".repeat(64), evidenceIds: [], traceIds: []
  };
  const stalePaths = unitPaths(run.runDir, synthesisId);
  await mkdir(stalePaths.dir, { recursive: true });
  await writeFile(stalePaths.receipt, `${JSON.stringify(stale, null, 2)}\n`);
  const orphanId = `${run.view.byId.get(synthesisId)!.documentId}::leaf::dropped-by-a-later-plan`;
  const orphanPaths = unitPaths(run.runDir, orphanId);
  await mkdir(orphanPaths.dir, { recursive: true });
  await writeFile(orphanPaths.receipt, `${JSON.stringify({ ...stale, knowledgeEpoch: run.view.knowledgeEpoch, unitId: orphanId, kind: "leaf" }, null, 2)}\n`);

  // A receipt filed under a directory that is not its own unit's: the shape a path-collapse bug would take.
  const misfiled = unitPaths(run.runDir, `${orphanId}::misfiled`);
  await mkdir(misfiled.dir, { recursive: true });
  await writeFile(misfiled.receipt, `${JSON.stringify({ ...stale, knowledgeEpoch: run.view.knowledgeEpoch, unitId: orphanId, kind: "leaf" }, null, 2)}\n`);
  await assert.rejects(() => collectUnits(run.runDir),
    /records unit ".*::leaf::dropped-by-a-later-plan", which belongs in ".*" and not in ".*"/);
  await rm(misfiled.dir, { recursive: true });

  const withSuperseded = await unitStatus(run.runDir);
  assert.deepEqual(withSuperseded.superseded.map((record) => [record.unitId, record.source, record.reason]), [
    [orphanId, "receipt", "not-in-plan"],
    [synthesisId, "receipt", "epoch"]
  ]);
  assert.equal(withSuperseded.units.find((row) => row.unitId === synthesisId)!.state, "unwritten",
    "a receipt from another epoch is not a draft of this one");
  assert.deepEqual(withSuperseded.census, { collected: 2, drafted: 0, unwritten: 1 });
  // And the barrier refuses them rather than recording either: the stale one by epoch, the orphan by name.
  await assert.rejects(() => collectUnits(run.runDir), /was written from knowledge epoch 99; re-draft it from current epoch 0/);
});

// --- (9) the epoch tripwires ---------------------------------------------------------------------------

test("an unsealed supplement stops collect, and a superseded epoch stops the receipt by name", async () => {
  const run = await plannedRun();
  const appendixId = unitsOfKind(run, "appendix")[0]!;
  await draftUnit(run.runDir, await unitDraftFor(run, appendixId));

  const plan = JSON.parse(await readFile(join(run.runDir, "workitems.json"), "utf8")) as { items: Array<{ id: string }> };
  await searchSourceEvidence(run.runDir, ["Leave requests"], "epoch barrier fixture", { maxResults: 5 }, {
    reason: "the draft's epoch lacks this search",
    workItemId: plan.items[0]!.id
  });
  await assert.rejects(() => collectUnits(run.runDir), /unsealed supplements/);
  assert.equal((await freezeRun(run.runDir)).frozen, true);
  await assert.rejects(() => collectUnits(run.runDir),
    /Unit draft receipt for .* was written from knowledge epoch 0; re-draft it from current epoch 1/);
  assert.ok(await exists(unitPaths(run.runDir, appendixId).receipt), "the refused receipt stays, so a re-draw can replace it");

  /*
   * WHERE THIS FIXTURE STOPS, AND WHY IT IS NOT A GAP IN THIS SLICE.
   *
   * The epic's acceptance asks for "re-plan after the re-freeze, re-draw, whole chain green". It is not
   * reachable: `loadTopicCatalogSource` reads `knowledge.json`, and `knowledgeEpochRelativePath`
   * (`src/freeze/freeze.ts:223`) keeps epoch 0 there while every later epoch lives under
   * `knowledge/epochs/epoch-N.json`. So after a re-freeze the Topic Catalog still projects EPOCH 0, a re-plan
   * records epoch 0 again (write-once sees identical bytes and no-ops), and no plan of epoch 1 can be produced
   * at all. Measured on this fixture, not inferred: the assertion below is the recorded plan's own epoch.
   *
   * The unit path's answer to that is a NAMED refusal rather than authoring against a superseded projection,
   * which is the only fail-closed answer available. When the catalog source starts reading the manifest's
   * epoch, these three refusals turn into the green chain the epic asks for - and this test goes red, which is
   * the right way for it to ask to be finished.
   */
  await planRun(run.runDir, { mode: "fixture" });
  const recorded = JSON.parse(await readFile(join(run.runDir, "plan", "catalog.json"), "utf8")) as { knowledgeEpoch: number };
  assert.equal(recorded.knowledgeEpoch, 0, "upstream: the Topic Catalog projects knowledge.json, which is epoch 0");
  const epochRefusal = /The recorded plan projects knowledge epoch 0 but the run manifest is at epoch 1; re-plan this run before authoring units/;
  await assert.rejects(async () => draftUnit(run.runDir, await unitDraftFor(run, appendixId)), epochRefusal);
  await assert.rejects(() => unitStatus(run.runDir), epochRefusal);
  // The barrier still answers with the RECEIPT's epoch first, which is the order this file's header argues for:
  // the draft in hand belongs to superseded knowledge, and that is the fact the operator acts on.
  await assert.rejects(() => collectUnits(run.runDir),
    /Unit draft receipt for .* was written from knowledge epoch 0; re-draft it from current epoch 1/);
});

// --- (10) fail closed, and never permanently ----------------------------------------------------------

test("collect refuses a receipt whose artifacts are missing or edited, keeps it, and a re-draft closes it", async () => {
  const run = await plannedRun();
  const unitId = unitsOfKind(run, "appendix")[0]!;
  const paths = unitPaths(run.runDir, unitId);
  await draftUnit(run.runDir, await unitDraftFor(run, unitId));

  const content = await readFile(paths.content, "utf8");
  await rm(paths.content);
  await assert.rejects(() => collectUnits(run.runDir), /promises content that is not on disk/);
  assert.ok(await exists(paths.receipt), "the unconsumed receipt stays, so a corrected rerun can pick it up");

  await writeFile(paths.content, `${content}\n edited after the draft\n`);
  await assert.rejects(() => collectUnits(run.runDir), /has content digesting to [0-9a-f]{64}, but its receipt promises [0-9a-f]{64}; re-draft the unit/);

  await rm(paths.summary);
  await assert.rejects(() => collectUnits(run.runDir), /promises summary that is not on disk/);

  // No permanent write-off: re-drafting the unit makes the same barrier succeed.
  await draftUnit(run.runDir, await unitDraftFor(run, unitId));
  assert.deepEqual((await collectUnits(run.runDir)).collected.map((receipt) => receipt.unitId), [unitId]);
  assert.deepEqual(await auditTimeline(run.runDir, run.manifest.id), []);
});

// --- (11) a plan whose unit id is a path, and a run with no plan at all -------------------------------

test("a run with no plan cannot report a unit view, and a plan carrying a traversal id cannot write anything", async () => {
  const base = await frozenRun();
  await assert.rejects(() => unitStatus(base.runDir),
    /plan\/topics\.json is missing from .*; authoring cannot start without a validated plan/);

  // The hostile id comes in the way a real one would: through a proposal that passes plan validation, which asks
  // only that a unit id be a non-empty string.
  await planWithRenamedUnits(base.runDir, base.workdir, (unitId) => unitId.includes("appendix") ? "../../escaped" : unitId);
  const recorded = JSON.parse(await readFile(join(base.runDir, "plan", "catalog.json"), "utf8")) as { units: Array<{ unitId: string }> };
  assert.ok(recorded.units.some((unit) => unit.unitId === "../../escaped"), "the plan really does record the hostile id");

  const before = await readFile(join(base.runDir, "run.json"));
  await assert.rejects(() => unitStatus(base.runDir), /contains a path separator; a unit id is one path segment, never a path/);
  await assert.rejects(() => draftUnit(base.runDir, { unitId: "../../escaped", content: "## x\n\nbody\n", claims: [], summary: {} }),
    /contains a path separator; a unit id is one path segment, never a path/);
  await assert.rejects(() => collectUnits(base.runDir), /contains a path separator/);
  assert.equal(await exists(join(base.runDir, "units")), false, "nothing was created for the refused unit");
  assert.equal(await exists(join(base.runDir, "..", "..", "escaped")), false);
  assert.ok((await readFile(join(base.runDir, "run.json"))).equals(before));
});

// --- (12) the summary is required output, not an option ------------------------------------------------

test("a draft with no summary is one of the ways a bad unit fails, and the failure is about the summary", async () => {
  const run = await sharedRun();
  const unitId = unitsOfKind(run, "appendix")[0]!;
  const draft = await unitDraftFor(run, unitId);
  const { version, ...withoutVersion } = draft.summary as { version: string };
  await assert.rejects(() => draftUnit(run.runDir, { ...draft, summary: withoutVersion }),
    /is not a valid unit summary: .*is missing field "version"/);
  await assert.rejects(() => draftUnit(run.runDir, { ...draft, summary: { ...(draft.summary as object), version: "unit-summary-v0" } }),
    new RegExp(`version "unit-summary-v0" is not ${UNIT_SUMMARY_VERSION}`));
});
