import test from "node:test";
import assert from "node:assert/strict";
import { exists } from "../src/base/util.ts";
import { documentBudgetRow, detailBudgetAllowance, type PlanDocumentBudget } from "../src/report/plan-budget.ts";
import { draftUnit } from "../src/report/unit-draft.ts";
import { measureUnitOutput, unitOutputBudgetProblems } from "../src/report/unit-output-budget.ts";
import { childSummaryBlockBytes, outputBoundSentence, renderChildSummaryBlock } from "../src/report/unit-packet.ts";
import { UNIT_SUMMARY_VERSION, unitContentDigest, validateUnitClaims, type UnitSummary } from "../src/report/unit-output.ts";
import { normalizeSection } from "../src/report/checkpoint.ts";
import { unitPaths } from "../src/report/unit-paths.ts";
import { plannedRun, unitDraftFor } from "./unit-fixture.ts";

// THE OUTPUT BUDGET (57B-434 R5b): declared by the allowance table, printed by every packet, enforced at DRAFT.
//
// R4b printed "output budget: NONE DECLARED" into every packet and deferred the number here, honestly — nothing
// declared one, and a synthesis's input is unbounded until its children's summaries are bounded. This slice
// declares both numbers and enforces them at the one moment the real bytes exist.
//
// THE THING THIS MUST NEVER BECOME is an incentive to delete content. An upper bound that an author satisfies by
// dropping an unknown or a terminology entry buys bytes with exactly the silence the whole epic exists to remove,
// and Core deleting content on an author's behalf would be the truncation every other file here refuses. So the
// refusal says "REWRITE IT MORE TIGHTLY" in as many words, the packet prints the same sentence before the author
// starts, and both are asserted below.

const OVERSIZE = 200_000;

function budgetRow(perUnitOutputBytes: number, perUnitSummaryBytes: number): PlanDocumentBudget {
  return { documentId: "doc", detailBudget: "standard", perUnitInputBytes: 1_000_000, totalInputBytes: 4_000_000, perUnitOutputBytes, perUnitSummaryBytes };
}

function summaryWith(keyStatements: readonly string[]): UnitSummary {
  return {
    version: UNIT_SUMMARY_VERSION,
    unitId: "doc::leaf::x",
    documentId: "doc",
    kind: "leaf",
    coveredTopicIds: [],
    keyStatements,
    unknowns: [],
    terminology: [],
    contentDigest: "0".repeat(64),
    claimsDigest: "0".repeat(64),
    childSummaryDigests: []
  };
}

// --- (1) the two bounds, as pure functions ------------------------------------------------------------

test("content-plus-claims and the summary block are two independent bounds, reported independently", () => {
  const summary = summaryWith(["short"]);
  const claims = validateUnitClaims("doc::leaf::x", "doc", []);
  const inside = measureUnitOutput("# x\n", claims, summary);
  assert.ok(inside.contentBytes > 0 && inside.claimsBytes > 0 && inside.summaryBytes > 0, "all three are measured, none assumed");
  assert.equal(inside.summaryBytes, childSummaryBlockBytes(summary), "the summary is measured as the block a PARENT reads");
  assert.deepEqual(unitOutputBudgetProblems("doc::leaf::x", budgetRow(100_000, 8_192), inside), []);

  // Content over, summary inside: one problem, and it names both numbers.
  const fat = measureUnitOutput("x".repeat(OVERSIZE), claims, summary);
  const contentProblems = unitOutputBudgetProblems("doc::leaf::x", budgetRow(1_000, 8_192), fat);
  assert.equal(contentProblems.length, 1, contentProblems.join(" | "));
  assert.match(contentProblems[0]!, /^unit "doc::leaf::x" writes \d+ bytes \(\d+ of content plus \d+ of canonical claims\), \d+ over the 1000-byte output budget its document's standard detail budget declares\./);
  assert.match(contentProblems[0]!, /REWRITE IT MORE TIGHTLY — do not drop an obligation, an unknown or a terminology entry to fit/);
  assert.match(contentProblems[0]!, /nothing here shortens content on your behalf/);

  // Summary over, content inside: the OTHER problem, on its own. Folding the two into one number would let a long
  // summary be excused by short prose, and it is the summary alone that decides whether a parent synthesis fits.
  const talkative = measureUnitOutput("# x\n", claims, summaryWith(["y".repeat(20_000)]));
  const summaryProblems = unitOutputBudgetProblems("doc::leaf::x", budgetRow(100_000, 4_096), talkative);
  assert.equal(summaryProblems.length, 1, summaryProblems.join(" | "));
  assert.match(summaryProblems[0]!, /^the summary of unit "doc::leaf::x" renders to \d+ bytes for a parent synthesis, \d+ over the 4096-byte summary budget/);
  assert.match(summaryProblems[0]!, /This is the number a synthesis's own input budget is computed from, so it is not negotiable per unit\./);
  assert.match(summaryProblems[0]!, /keep every unknown and every term, and say each one in fewer words/);

  // Both over: both reported. Neither hides the other.
  assert.equal(unitOutputBudgetProblems("doc::leaf::x", budgetRow(1_000, 100), measureUnitOutput("x".repeat(OVERSIZE), claims, summaryWith(["y".repeat(20_000)]))).length, 2);
});

test("the summary bound and the plan-time synthesis bound measure the SAME bytes", () => {
  // One spelling of "how big is a child summary": the block a parent packet renders. If the draft gate bounded the
  // canonical JSON instead, the author would be graded against a number the plan did not budget.
  const summary = summaryWith(["a statement", "another statement"]);
  assert.equal(childSummaryBlockBytes(summary), Buffer.byteLength(renderChildSummaryBlock(summary), "utf8"));
  assert.ok(renderChildSummaryBlock(summary).includes("### doc::leaf::x (leaf)"));
});

test("the sentence the packet prints is the rule the draft gate applies, and it forbids deleting content", () => {
  const sentence = outputBoundSentence(budgetRow(131_072, 8_192));
  assert.match(sentence, /^output budget \(plan, per unit for doc\): 131072 bytes of `content\.md` plus canonical claims, and 8192 bytes for the summary block a parent unit reads\./);
  assert.match(sentence, /Both are ENFORCED when this unit is drafted/);
  assert.match(sentence, /WRITE MORE TIGHTLY — never to drop an obligation, an unknown or a terminology entry\. Core does not delete content to fit\./);
});

// --- (2) the two bounds, enforced at draft over a real planned run --------------------------------------

test("a draft over its output budget is a NAMED refusal that writes nothing, and the retightened draft succeeds", async () => {
  const run = await plannedRun();
  // The sample-target fixture holds no material topic, so its plan is an appendix under a synthesis. The appendix
  // is the unit with topics and no children, which is what a draft-time output gate needs to be exercised on.
  const unitId = run.view.units.find((unit) => unit.kind === "appendix")!.unitId;
  const paths = unitPaths(run.runDir, unitId);
  const legal = await unitDraftFor(run, unitId);
  const allowance = documentBudgetRow(run.view.planCatalog.budget, run.view.byId.get(unitId)!.documentId);
  assert.equal(allowance.perUnitOutputBytes, detailBudgetAllowance("standard").perUnitOutputBytes,
    "the bound comes from the plan's own row for this document, not from a number this test picked");

  // Content past the bound: refused by name, and NOTHING was written — the gate stands before the archive-and-write
  // sequence, exactly where the claims and summary gates already stood. The summary's digests are recomputed for
  // the oversized bytes on purpose: an inconsistent summary would fail one gate earlier and prove nothing here.
  const title = run.view.byId.get(unitId)!.title;
  const oversizeContent = `## ${title}\n\n${"y".repeat(allowance.perUnitOutputBytes + 1)}\n`;
  const oversize = await unitDraftFor(run, unitId, { contentDigest: unitContentDigest(normalizeSection(oversizeContent, title)) });
  await assert.rejects(
    () => draftUnit(run.runDir, { ...oversize, content: oversizeContent }),
    /is over its declared output budget: unit .* writes \d+ bytes \(\d+ of content plus \d+ of canonical claims\), \d+ over the 131072-byte output budget/
  );
  assert.equal(await exists(paths.content), false, "a refused draft leaves no content on disk");
  assert.equal(await exists(paths.receipt), false, "and no receipt for collect to believe");

  // A summary whose rendered block is past the bound: the other refusal, with its own words.
  const talkative = await unitDraftFor(run, unitId, { keyStatements: ["y".repeat(allowance.perUnitSummaryBytes + 1)] });
  await assert.rejects(
    () => draftUnit(run.runDir, talkative),
    /the summary of unit .* renders to \d+ bytes for a parent synthesis, \d+ over the 8192-byte summary budget/
  );
  assert.equal(await exists(paths.content), false);

  // Retightened, the same unit drafts: the bound is satisfiable by writing tighter, which is the whole claim.
  const receipt = await draftUnit(run.runDir, legal);
  assert.equal(receipt.unitId, unitId);
  assert.equal(await exists(paths.content), true);
  assert.equal(await exists(paths.receipt), true);
});
