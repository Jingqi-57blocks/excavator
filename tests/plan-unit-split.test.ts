import test from "node:test";
import assert from "node:assert/strict";
import { stableJson } from "../src/base/util.ts";
import { buildFixturePlan } from "../src/report/fixture-plan.ts";
import { PLAN_BUDGET_TABLE, type PlanBudgetTable } from "../src/report/plan-budget.ts";
import { measurePlanPackets, type UnitPacketMeasureInputs } from "../src/report/plan-packet-measure.ts";
import { FIRST_PLAN_REVISION, derivePlanArtifacts } from "../src/report/plan-artifacts.ts";
import { documentBudgetRow } from "../src/report/plan-budget.ts";
import { documentOwnership, materialObligationTopics } from "../src/report/plan-obligation-conservation.ts";
import { renderUnitPacket, topicDossier } from "../src/report/unit-packet.ts";
import { scopePartitionProblems, scopeIncludes, type ScopePartitionUnit } from "../src/report/obligation-scope.ts";
import { accountPlanObligations, deriveObligationOwnership, ownershipUnitsOfProposal, unitTopicRole } from "../src/report/plan-obligation-conservation.ts";
import { parsePlanProposal, unitTopics, type PlanProposal, type ProposedUnit } from "../src/report/plan-proposal.ts";
import {
  SPLIT_LEVELS,
  packByWeight,
  parseUnitIdentity,
  planThroughBudgetRefinement,
  refinePlanForBudget,
  renderUnitId
} from "../src/report/plan-unit-split.ts";
import { validatePlan } from "../src/report/plan-validation.ts";
import { REPORT_POLICY_REGISTRY } from "../src/report/report-policy-registry.ts";
import { parsedDispositionIndex } from "../src/report/topic-disposition.ts";
import { assertUsableUnitId, unitPathKey } from "../src/report/unit-paths.ts";
import { MINI_DOCUMENTS, miniRun, type MiniRun } from "./plan-fixture.ts";

// THE DIVISION LADDER, AND ITS TWO EXITS (57B-434 R5b).
//
// A splitter is the most dangerous thing in this slice: it is the one component whose job is to change a plan, so
// it is the one place a row could go missing while every count downstream still balanced. The whole design is
// therefore "divide, or fail by name" — and the tests below are organised around proving there is no third exit:
//
//   * a division PARTITIONS: the four obligation buckets and the per-unit ownership counts are byte-identical
//     before and after, and the partition law over the divided plan reports nothing;
//   * the ladder is tried in order and the rung is recorded, so a division is readable rather than magic;
//   * a unit that cannot be divided further is a NAMED failure carrying the obligation id, its dimension and its
//     evidence ids — never a narrowed scope, never a dropped topic;
//   * the same inputs divide to the same bytes, twice;
//   * a part id is derived from its own CONTENT at every rung, and a rung REPLACES its own component rather than
//     chaining one, so a re-divided bucket does not grow an id past the path-segment cap.

let mini: MiniRun | null = null;
async function fixture(): Promise<MiniRun> {
  return (mini ??= await miniRun());
}

function measureInputs(run: MiniRun, budgetTable: PlanBudgetTable): UnitPacketMeasureInputs {
  return {
    catalog: run.catalog,
    requests: run.requests,
    registry: REPORT_POLICY_REGISTRY,
    budgetTable,
    evidence: run.evidenceById,
    reach: run.reach
  };
}

/**
 * A table whose numbers are the real ladder's, scaled down so a small fixture catalog overflows it.
 *
 * `perUnitSummaryBytes` is a separate argument rather than a fraction of the input bound, because a synthesis's
 * bound is `fixed + children x summary` and on this fixture the fixed part alone is ~6.4 KB: a summary allowance
 * derived from a small input bound would make the SYNTHESIS the thing that fails, and these tests are about the
 * division of leaves. Stating it is the honest way to keep one variable at a time.
 */
function tableWith(perUnitInputBytes: number, perUnitSummaryBytes: number): PlanBudgetTable {
  return {
    version: `plan-budget-test-${perUnitInputBytes}-${perUnitSummaryBytes}`,
    allowances: Object.fromEntries(Object.entries(PLAN_BUDGET_TABLE.allowances).map(([key]) => [key, {
      perUnitInputBytes,
      totalInputBytes: perUnitInputBytes * 64,
      perUnitOutputBytes: Math.max(perUnitSummaryBytes + 1, Math.floor(perUnitInputBytes / 4)),
      perUnitSummaryBytes
    }]))
  };
}

/**
 * The per-unit bound these tests divide against, and the summary allowance that keeps the syntheses inside theirs.
 *
 * 9,200 is chosen against MEASURED numbers on this fixture, not picked: its three leaves render 9,464 / 9,589 /
 * 10,643 bytes so all three must divide, and a part down to ONE obligation renders ~8.5 KB — the packet's header,
 * grounding rules and ownership prose are an irreducible floor of about that size — so the parts fit. A bound below
 * that floor would make every division end in the named failure instead, which is what the monster fixture below
 * exercises deliberately.
 */
const DIVIDING_TABLE = tableWith(9_200, 64);

/**
 * The fixture plan with its APPENDIX units dropped.
 *
 * Not a convenience: an appendix renders the run's whole unbound-evidence census and the facet census, ~13 KB on
 * this fixture whatever its topics are, so no per-unit bound both overflows a 9.5 KB leaf and admits a divided
 * appendix. Dropping them isolates the variable these tests are about — the division of a unit whose cost is its
 * obligations — and the appendix's own floor behaviour is exercised by the root test below.
 */
function leafOnlyPlan(run: MiniRun, table: PlanBudgetTable): PlanProposal {
  const base = buildFixturePlan(run.catalog, run.requests, table);
  const dropped = new Set(base.units.filter((unit) => unit.kind === "appendix").map((unit) => unit.unitId));
  const units = base.units
    .filter((unit) => !dropped.has(unit.unitId))
    .map((unit) => unit.kind === "synthesis"
      ? { ...unit, childUnitIds: unit.childUnitIds.filter((childUnitId) => !dropped.has(childUnitId)) }
      : unit);
  const parsed = parsePlanProposal(JSON.parse(stableJson({ ...base, units })));
  assert.equal(parsed.proposal !== null, true, parsed.problems.join("; "));
  return parsed.proposal!;
}

function refine(run: MiniRun, budgetTable: PlanBudgetTable, proposal?: PlanProposal): ReturnType<typeof refinePlanForBudget> {
  const inputs = measureInputs(run, budgetTable);
  const plan = proposal ?? buildFixturePlan(run.catalog, run.requests, budgetTable);
  return refinePlanForBudget(inputs, plan, measurePlanPackets(inputs, plan));
}

/** Every (topic, obligation) pair one plan's units hold in scope, as a sorted multiset of strings. */
function scopedPairs(run: MiniRun, proposal: PlanProposal): string[] {
  const pairs: string[] = [];
  for (const unit of proposal.units) {
    if (unitTopicRole(unit.kind) !== "owning") continue;
    for (const reference of unitTopics(unit)) {
      const topic = run.catalog.topics.find((row) => row.topicId === reference.topicId)!;
      for (const binding of topic.bindings) {
        if (scopeIncludes(reference.obligationScope, binding.workItemId)) pairs.push(`${unit.documentId} ${reference.topicId} ${binding.workItemId}`);
      }
    }
  }
  return pairs.sort((a, b) => a.localeCompare(b));
}

function partitionUnits(proposal: PlanProposal): ScopePartitionUnit[] {
  return proposal.units
    .filter((unit) => unitTopicRole(unit.kind) !== "topic-free")
    .map((unit) => ({
      unitId: unit.unitId,
      documentId: unit.documentId,
      owning: unitTopicRole(unit.kind) === "owning",
      topics: unitTopics(unit)
    }));
}

// --- (1) the ladder divides, and the division conserves ------------------------------------------------

test("a divided plan holds exactly the obligations the undivided one did, per document and per topic", async () => {
  const run = await fixture();
  const table = DIVIDING_TABLE;
  const before = leafOnlyPlan(run, table);
  const refinement = refine(run, table, before);
  assert.equal(refinement.state, "refined", refinement.state === "indivisible" ? refinement.problems.join("; ") : "");
  if (refinement.state !== "refined") return;
  const after = refinement.proposal;
  assert.ok(after.units.length > before.units.length, "the fixture must actually be divided at this budget");
  assert.ok(refinement.divisions.length > 0);

  // (a) the (topic, obligation) pairs an owning unit holds in scope are EXACTLY the same set, before and after.
  assert.deepEqual(scopedPairs(run, after), scopedPairs(run, before),
    "a division redistributes obligations; it neither drops nor duplicates one");

  // (b) the partition law reports nothing over the divided plan.
  const bindingIds = new Map(run.catalog.topics.map((topic) => [topic.topicId, topic.bindings.map((binding) => binding.workItemId)]));
  assert.deepEqual(scopePartitionProblems(bindingIds, partitionUnits(after)), []);

  // (c) gate 1b's four buckets are byte-identical, and so is the per-unit ownership TOTAL per document.
  const dispositions = parsedDispositionIndex(before.dispositions);
  assert.equal(stableJson(accountPlanObligations(run.catalog, after.units, dispositions.byTopic)),
    stableJson(accountPlanObligations(run.catalog, before.units, dispositions.byTopic)),
    "the division moves no obligation between the four buckets");
  const ownedTotals = (proposal: PlanProposal): string => stableJson(deriveObligationOwnership(run.catalog, ownershipUnitsOfProposal(proposal.units))
    .documents.map((document) => ({
      documentId: document.documentId,
      reached: document.reachedObligations,
      owned: document.ownedByUnit.reduce((total, row) => total + row.owned, 0),
      unowned: document.unowned.length
    })));
  assert.equal(ownedTotals(after), ownedTotals(before),
    "Sigma owned per document is what it was undivided: the parts own between them exactly what the whole owned");

  // (d) every unit of the divided plan fits its own bound, measured.
  assert.deepEqual([...refinement.measurement.overBudgetUnitIds], []);
  // (e) and every part id is still a legal path segment, with a distinct directory.
  const keys = new Set<string>();
  for (const unit of after.units) {
    assertUsableUnitId(unit.unitId);
    const key = unitPathKey(unit.unitId);
    assert.equal(keys.has(key), false, `${unit.unitId} collides on directory ${key}`);
    keys.add(key);
  }
});

/**
 * THE STRONGEST STATEMENT THE DIVISION HAS TO MAKE, and the one no count would catch.
 *
 * Every conservation reading in this slice is about SETS and OWNERS: the four buckets, the per-unit owned counts,
 * the partition of scopes. All of them stay balanced if ownership and scope disagree — an obligation whose owner is
 * a part that scopes it OUT would be stubbed by the part that has it and skipped by the part that owns it, and
 * nothing that counts rows would notice, because both units accounted for it. So this test renders every packet of
 * a divided document and asserts the thing an author actually depends on: each material obligation is rendered IN
 * FULL, with its evidence, in exactly one packet.
 */
test("in a divided plan every material obligation is rendered in full by exactly ONE unit of its document", async () => {
  const run = await fixture();
  const table = DIVIDING_TABLE;
  const refinement = refine(run, table, leafOnlyPlan(run, table));
  assert.equal(refinement.state, "refined", refinement.state === "indivisible" ? refinement.problems.join("; ") : "");
  if (refinement.state !== "refined") return;
  const proposal = refinement.proposal;
  const artifacts = derivePlanArtifacts({ catalog: run.catalog, requests: run.requests, proposal, budgetTable: table , revision: FIRST_PLAN_REVISION });
  const ownership = deriveObligationOwnership(run.catalog, ownershipUnitsOfProposal(proposal.units));
  const topicsById = new Map(run.catalog.topics.map((topic) => [topic.topicId, topic]));
  const obligations = materialObligationTopics(run.catalog);

  for (const documentId of [...new Set(proposal.units.map((unit) => unit.documentId))].sort((a, b) => a.localeCompare(b))) {
    const fullBy = new Map<string, string[]>();
    const evidenceBy = new Map<string, string[]>();
    for (const unit of artifacts.planCatalog.units.filter((row) => row.documentId === documentId && row.kind !== "synthesis")) {
      const packet = renderUnitPacket({
        planCatalog: artifacts.planCatalog,
        facets: run.catalog.facets,
        dag: artifacts.dag,
        requests: run.requests,
        registry: REPORT_POLICY_REGISTRY,
        unitId: unit.unitId,
        dossier: topicDossier(unit, topicsById, run.evidenceById),
        ownership: documentOwnership(ownership, documentId),
        reach: run.reach,
        byteLimit: documentBudgetRow(artifacts.planCatalog.budget, documentId).perUnitInputBytes,
        overBudget: "refuse"
      });
      for (const workItemId of packet.obligationIds) {
        const list = fullBy.get(workItemId);
        if (list) list.push(unit.unitId);
        else fullBy.set(workItemId, [unit.unitId]);
      }
      for (const evidenceId of packet.renderedEvidenceIds) {
        const list = evidenceBy.get(evidenceId);
        if (list) list.push(unit.unitId);
        else evidenceBy.set(evidenceId, [unit.unitId]);
      }
    }
    const reached = obligations.filter((row) => row.topicIds.some((topicId) =>
      artifacts.planCatalog.units.some((unit) => unit.documentId === documentId && unit.topics.some((reference) => reference.topicId === topicId))));
    assert.ok(reached.length > 0, `${documentId}: the fixture must reach material obligations`);
    for (const row of reached) {
      const carriers = fullBy.get(row.workItemId) ?? [];
      assert.equal(carriers.length, 1,
        `${documentId}: material obligation ${row.workItemId} is rendered in full by ${carriers.length} unit(s) (${carriers.join(", ") || "none"}); exactly one must carry it`);
      // And that unit is the OWNER the audit will hold responsible: the packet an author reads and the denominator
      // the audit applies have to name the same unit, or one of them is asking for work the other does not check.
      assert.equal(carriers[0], documentOwnership(ownership, documentId).ownerByObligation.get(row.workItemId)!.ownerUnitId, row.workItemId);
      // Its own evidence travels with it, into that unit and no other.
      for (const evidenceId of row.binding.evidenceIds) {
        assert.ok((evidenceBy.get(evidenceId) ?? []).includes(carriers[0]!),
          `${documentId}: evidence ${evidenceId} of ${row.workItemId} must be rendered by ${carriers[0]}`);
      }
    }
  }
});

/**
 * THE SAME STATEMENT, over a MATERIAL topic divided INSIDE itself — the case the previous test cannot reach.
 *
 * On this fixture the natural division of a multi-topic leaf stops at the `topic` rung, so every scope stays `all`
 * and ownership's scope-awareness is never load-bearing. Here the leaf names ONE material topic whose two
 * obligations share a dimension and carry 20 KB evidence records, so the ladder runs past `dimension` to `items`
 * and each part gets an explicit scope. That is the shape where ownership and scope can disagree: if the owner of an obligation were the
 * lowest-id part rather than the part whose scope holds it, the holder would stub it and the owner would skip it,
 * and NOBODY would render it — with every count still balanced.
 */
test("a material topic divided inside itself still has every obligation rendered in full by exactly one part", async () => {
  // ONE requested document, so the bound below is about the leaf being divided and not about the other documents'
  // syntheses: a per-unit bound that divides a 68 KB leaf is also a bound six child summaries would exceed, and
  // that would make the SYNTHESIS the thing that fails. One variable at a time.
  const run = await miniRun([MINI_DOCUMENTS[0]!]);
  const topic = run.catalog.topics.find((row) => row.facet === "feature" && row.bindings.filter((binding) => binding.material).length >= 2)!;
  const inflated = new Map(run.evidenceById);
  for (const binding of topic.bindings) {
    for (const evidenceId of binding.evidenceIds) {
      const record = inflated.get(evidenceId)!;
      inflated.set(evidenceId, { ...record, content: "z".repeat(20_000) });
    }
  }
  const documentId = MINI_DOCUMENTS[0]!.documentId;
  const leafId = `${documentId}::leaf::solo`;
  // MEASURED, not picked. The topic's two obligations bind disjoint evidence — one record and two — so at 20 KB a
  // record the parts cost ~28 KB and ~48 KB while the undivided leaf costs ~68 KB. A 55,000-byte bound therefore
  // divides the leaf and admits both parts, with margin on each side.
  const table = tableWith(55_000, 4_096);
  const base = buildFixturePlan(run.catalog, run.requests, table);
  const solo = parsePlanProposal({
    ...JSON.parse(stableJson(base)) as Record<string, unknown>,
    units: [
      ...base.units.filter((unit) => unit.documentId !== documentId).map((unit) => JSON.parse(stableJson(unit)) as unknown),
      { kind: "leaf", unitId: leafId, documentId, title: "the one material topic", topics: [{ topicId: topic.topicId, obligationScope: { kind: "all" } }] },
      { kind: "synthesis", unitId: `${documentId}::synthesis::document`, documentId, title: "root", childUnitIds: [leafId] }
    ].sort((a, b) => String((a as { unitId: string }).unitId).localeCompare(String((b as { unitId: string }).unitId)))
  });
  assert.equal(solo.proposal !== null, true, solo.problems.join("; "));

  const inputs: UnitPacketMeasureInputs = { ...measureInputs(run, table), evidence: inflated };
  const refinement = refinePlanForBudget(inputs, solo.proposal!, measurePlanPackets(inputs, solo.proposal!));
  assert.equal(refinement.state, "refined", refinement.state === "indivisible" ? refinement.problems.join("; ") : "");
  if (refinement.state !== "refined") return;
  const parts = refinement.proposal.units.filter((unit) => unit.documentId === documentId && unit.unitId.startsWith(leafId));
  assert.ok(parts.length >= 2, `the topic must be divided inside itself: ${parts.map((unit) => unit.unitId).join(", ")}`);
  for (const part of parts) {
    const reference = unitTopics(part)[0]!;
    assert.equal(reference.obligationScope.kind, "work-items", `${part.unitId} must carry an explicit scope`);
  }

  const artifacts = derivePlanArtifacts({ catalog: run.catalog, requests: run.requests, proposal: refinement.proposal, budgetTable: table , revision: FIRST_PLAN_REVISION });
  const ownership = deriveObligationOwnership(run.catalog, ownershipUnitsOfProposal(refinement.proposal.units));
  const topicsById = new Map(run.catalog.topics.map((row) => [row.topicId, row]));
  const fullBy = new Map<string, string[]>();
  for (const unit of artifacts.planCatalog.units.filter((row) => row.documentId === documentId && row.kind !== "synthesis")) {
    const packet = renderUnitPacket({
      planCatalog: artifacts.planCatalog,
      facets: run.catalog.facets,
      dag: artifacts.dag,
      requests: run.requests,
      registry: REPORT_POLICY_REGISTRY,
      unitId: unit.unitId,
      dossier: topicDossier(unit, topicsById, inflated),
      ownership: documentOwnership(ownership, documentId),
      reach: run.reach,
      byteLimit: documentBudgetRow(artifacts.planCatalog.budget, documentId).perUnitInputBytes,
      overBudget: "refuse"
    });
    for (const workItemId of packet.obligationIds) {
      const list = fullBy.get(workItemId);
      if (list) list.push(unit.unitId);
      else fullBy.set(workItemId, [unit.unitId]);
    }
  }
  for (const binding of topic.bindings.filter((row) => row.material)) {
    const carriers = fullBy.get(binding.workItemId) ?? [];
    assert.equal(carriers.length, 1,
      `${binding.workItemId} is rendered in full by ${carriers.length} part(s) (${carriers.join(", ") || "none"}); exactly one must carry it`);
    assert.equal(carriers[0], ownership.byDocument.get(documentId)!.ownerByObligation.get(binding.workItemId)!.ownerUnitId,
      `${binding.workItemId}: the part that renders it must be the part the audit will hold responsible`);
  }
});

test("the ladder is tried in order, and the rung each division used is recorded", async () => {
  const run = await fixture();
  const refinement = refine(run, DIVIDING_TABLE, leafOnlyPlan(run, DIVIDING_TABLE));
  assert.equal(refinement.state, "refined");
  if (refinement.state !== "refined") return;
  for (const division of refinement.divisions) {
    assert.ok((SPLIT_LEVELS as readonly string[]).includes(division.level), division.level);
    assert.ok(division.partUnitIds.length >= 2, "a division that made one part is not a division");
    assert.ok(division.measuredBytes > division.byteLimit, "only an over-budget unit is divided");
    assert.equal(new Set(division.partUnitIds).size, division.partUnitIds.length, "the parts have distinct ids");
  }
  // The first rung a multi-topic leaf can use is `topic` — the fixture's leaves name one facet each, so `facet`
  // never fires here, and that is a statement about this catalog rather than about the ladder.
  assert.ok(refinement.divisions.some((division) => division.level === "topic" || division.level === "items"),
    refinement.divisions.map((division) => division.level).join(", "));
});

test("the same inputs divide to the same bytes, twice", async () => {
  const run = await fixture();
  const table = DIVIDING_TABLE;
  const first = refine(run, table, leafOnlyPlan(run, table));
  const second = refine(run, table, leafOnlyPlan(run, table));
  assert.equal(first.state, "refined");
  assert.equal(second.state, "refined");
  if (first.state !== "refined" || second.state !== "refined") return;
  assert.equal(stableJson(first.proposal), stableJson(second.proposal));
  assert.equal(stableJson(first.divisions), stableJson(second.divisions));
  assert.equal(first.iterations, second.iterations);
});

// --- (2) the floor: a single obligation that still does not fit is a NAMED failure ----------------------

test("a unit down to one obligation that still overflows fails BY NAME, with the obligation id and its evidence ids", async () => {
  const run = await fixture();
  // THE MONSTER FIXTURE. One evidence record is inflated to 2 MB, so the obligation that binds it cannot fit any
  // allowance in the real table however finely the topic is divided. The ladder therefore runs to its floor — one
  // topic, one dimension, one work item — and then REFUSES. This is the shape the epic's section 7 demands: "if the
  // smallest leaf is still over budget, the plan fails and names the offending topic; it may not truncate".
  const material = run.catalog.topics
    .flatMap((topic) => topic.bindings.filter((binding) => binding.material && binding.evidenceIds.length > 0))
    .sort((a, b) => a.workItemId.localeCompare(b.workItemId))[0]!;
  const monstrous = new Map(run.evidenceById);
  const record = monstrous.get(material.evidenceIds[0]!)!;
  monstrous.set(record.id, { ...record, content: "x".repeat(2_000_000) });

  const inputs: UnitPacketMeasureInputs = { ...measureInputs(run, PLAN_BUDGET_TABLE), evidence: monstrous };
  const proposal = buildFixturePlan(run.catalog, run.requests, PLAN_BUDGET_TABLE);
  const refinement = refinePlanForBudget(inputs, proposal, measurePlanPackets(inputs, proposal));
  assert.equal(refinement.state, "indivisible");
  if (refinement.state !== "indivisible") return;
  const named = refinement.problems.filter((problem) => /THE PLAN FAILS HERE RATHER THAN TRUNCATING/.test(problem));
  assert.ok(named.length > 0, refinement.problems.join(" | "));
  assert.ok(named.every((problem) => problem.includes(material.workItemId)),
    `the failure must name the offending obligation ${material.workItemId}: ${named.join(" | ")}`);
  assert.ok(named.every((problem) => problem.includes(`evidence: ${material.evidenceIds.join(" ")}`)),
    "and its evidence ids, because that is where a reader looks to see why one obligation is this expensive");
  assert.ok(named.every((problem) => /the only obligation\(s\) left in its scope are /.test(problem)));
  assert.ok(named.every((problem) => /renders a \d+-byte packet, \d+ byte\(s\) over the 786432-byte per-unit input budget/.test(problem)));
  assert.ok(named.every((problem) => /Nothing in this pipeline shortens a packet\.$/.test(problem)));
  // A real finding, reported as one: the message says to raise the allowance deliberately or reduce what the run
  // captured, never to cut the packet.
  assert.ok(named.every((problem) => /raise the detail budget's per-unit allowance deliberately, or reduce what the run captured for that obligation upstream/.test(problem)));
});

test("an over-budget unit that is a document ROOT fails by name: a splitter divides obligations, it does not invent a parent", async () => {
  const run = await fixture();
  const table = DIVIDING_TABLE;
  const base = buildFixturePlan(run.catalog, run.requests, table);
  // One document, one unit: the appendix alone, as its own root. Dividing it would leave the document with several
  // roots, and minting a synthesis to hang the parts off is not a division.
  const documentId = "overview-product";
  const appendix = base.units.find((unit) => unit.unitId === `${documentId}::appendix::coverage`)!;
  const leaf = base.units.find((unit) => unit.unitId === `${documentId}::leaf::feature`)!;
  const rootOnly = parsePlanProposal({
    ...JSON.parse(stableJson(base)) as Record<string, unknown>,
    units: [
      ...base.units.filter((unit) => unit.documentId !== documentId).map((unit) => JSON.parse(stableJson(unit)) as unknown),
      JSON.parse(stableJson({ ...appendix, topics: [...unitTopics(appendix), ...unitTopics(leaf)].sort((a, b) => a.topicId.localeCompare(b.topicId)) })) as unknown
    ].sort((a, b) => String((a as { unitId: string }).unitId).localeCompare(String((b as { unitId: string }).unitId)))
  });
  assert.equal(rootOnly.proposal !== null, true, rootOnly.problems.join("; "));
  const refinement = refine(run, table, rootOnly.proposal!);
  assert.equal(refinement.state, "indivisible");
  if (refinement.state !== "indivisible") return;
  assert.ok(refinement.problems.some((problem) =>
    /it is the document's only root, and dividing a root would leave the document with several\. A splitter divides obligations; it does not invent a synthesis to hang the parts off\./.test(problem)),
    refinement.problems.join(" | "));
});

// --- (3) the packing, and the id algebra ---------------------------------------------------------------

test("cost-balanced packing makes exactly N non-empty buckets, in the items' own order", () => {
  const items = ["a", "b", "c", "d", "e"];
  const weights = [10, 10, 10, 10, 10];
  for (const parts of [1, 2, 3, 5]) {
    const buckets = packByWeight(items, weights, parts);
    assert.equal(buckets.length, parts, `${parts} bucket(s)`);
    for (const bucket of buckets) assert.ok(bucket.length > 0, "a bucket scoped to nothing is what this refuses to produce");
    assert.deepEqual(buckets.flat(), items, "the order is the items' own; the packing never reorders them");
  }
  // One heavy item does not drag its neighbours with it: the split follows the weights, not the count.
  assert.deepEqual(packByWeight(["a", "b", "c"], [100, 1, 1], 2), [["a"], ["b", "c"]]);
  assert.throws(() => packByWeight(["a"], [1, 2], 1), /one weight per item, always/);
  assert.throws(() => packByWeight(["a"], [1], 0), /a division makes at least one/);
  assert.throws(() => packByWeight(["a"], [1], 2), /a bucket scoped to nothing is what this refuses to produce/);
});

test("a part id carries at most one component per rung, and a re-division REPLACES its own rather than chaining", () => {
  const root = "overview-product::leaf::feature";
  assert.deepEqual(parseUnitIdentity(root), { root, components: new Map() });
  const withTopic = renderUnitId({ root, components: new Map([["topic", "abc123"]]) });
  assert.equal(withTopic, `${root}#t-abc123`);
  const withBoth = renderUnitId({ root, components: new Map([["items", "0011"], ["topic", "abc123"]]) });
  assert.equal(withBoth, `${root}#t-abc123#w-0011`, "the components are emitted in ladder order, whatever order they were set in");
  const reparsed = parseUnitIdentity(withBoth);
  assert.equal(reparsed.root, root);
  assert.deepEqual([...reparsed.components.entries()].sort(), [["items", "0011"], ["topic", "abc123"]]);
  // Re-dividing at the same rung replaces the component: the id does not grow without bound.
  assert.equal(renderUnitId({ root: reparsed.root, components: new Map([...reparsed.components, ["items", "2233"]]) }),
    `${root}#t-abc123#w-2233`);
  // An id whose `#` segments are not all components is treated as one opaque ROOT: refusing to guess is the safe
  // direction, because misreading one would make two different units collide on the id this rebuilds.
  assert.deepEqual(parseUnitIdentity("weird#id#t-abc").components, new Map());
  assert.deepEqual(parseUnitIdentity(`${root}#t-a#t-b`).components, new Map(), "one component per rung, or it is not a component chain");
});

// --- (4) the one door: validate, divide, validate ------------------------------------------------------

test("the one door returns a plan every unit of which validates, or a rejection carrying the first report", async () => {
  const run = await fixture();
  const table = DIVIDING_TABLE;
  const planned = planThroughBudgetRefinement({ ...measureInputs(run, table), proposal: leafOnlyPlan(run, table) });
  assert.equal(planned.state, "planned", planned.state === "rejected" ? planned.problems.join("; ") : "");
  if (planned.state !== "planned") return;
  assert.notEqual(planned.report.overall.conclusion, "violations");
  assert.equal(planned.report.packets.state, "measured");
  if (planned.report.packets.state === "measured") assert.deepEqual([...planned.report.packets.measurement.overBudgetUnitIds], []);
  assert.ok(planned.iterations >= 2, "this budget forces at least one round of division and one confirming pass");

  // The undivided case takes exactly one pass and reports no division — an identity, stated rather than implied.
  const roomy = planThroughBudgetRefinement({
    ...measureInputs(run, PLAN_BUDGET_TABLE),
    proposal: buildFixturePlan(run.catalog, run.requests, PLAN_BUDGET_TABLE)
  });
  assert.equal(roomy.state, "planned");
  if (roomy.state !== "planned") return;
  assert.equal(roomy.iterations, 1);
  assert.deepEqual([...roomy.divisions], []);
  assert.equal(stableJson(roomy.proposal), stableJson(buildFixturePlan(run.catalog, run.requests, PLAN_BUDGET_TABLE)));

  // A structurally broken plan is REJECTED with the first report attached, and nothing was divided on the way.
  const base = buildFixturePlan(run.catalog, run.requests, PLAN_BUDGET_TABLE);
  const broken: ProposedUnit[] = base.units.filter((unit) => unit.documentId !== "overview-engineering");
  const rejected = planThroughBudgetRefinement({ ...measureInputs(run, PLAN_BUDGET_TABLE), proposal: { ...base, units: broken } });
  assert.equal(rejected.state, "rejected");
  if (rejected.state !== "rejected") return;
  assert.ok(rejected.problems.some((problem) => /is requested and no unit writes any part of it/.test(problem)), rejected.problems.join(" | "));
  assert.equal(rejected.report.packets.state, "not-measured");
});

test("a divided plan goes through the SAME validator, and the recorded one is the divided one", async () => {
  const run = await fixture();
  const table = DIVIDING_TABLE;
  const planned = planThroughBudgetRefinement({ ...measureInputs(run, table), proposal: leafOnlyPlan(run, table) });
  assert.equal(planned.state, "planned");
  if (planned.state !== "planned") return;
  const revalidated = validatePlan({ ...measureInputs(run, table), proposal: planned.proposal });
  assert.equal(stableJson(revalidated.problems), stableJson(planned.report.problems));
  assert.equal(revalidated.overall.conclusion, planned.report.overall.conclusion);
  // And the parsed round trip holds: the divided plan is bytes a model could have written, not an internal shape.
  const roundTrip = parsePlanProposal(JSON.parse(stableJson(planned.proposal)));
  assert.equal(roundTrip.proposal !== null, true, roundTrip.problems.join("; "));
  assert.equal(stableJson(roundTrip.proposal), stableJson(planned.proposal));
});
