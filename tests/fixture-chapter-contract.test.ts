/**
 * THE CHAPTER CONTRACT, ASSERTED OVER THE FIXTURES' OWN DELIVERABLES.
 *
 * WHY IT EXISTS. Every report template states that its `##` chapters are the fixed contract of the deliverable, and
 * `contract/requirements.json` materializes one requirement row per template section before any producer runs — so
 * "how many numbered chapters does this document owe" is a fact the run itself records. The model-free fixtures
 * used to write one unnumbered heading per unit, which put every fixture deliverable outside that contract without
 * anything saying so. `tests/fixture-chapters.ts` moved them inside it; this file is what proves they got there and
 * stays red if they ever drift back out.
 *
 * IT IS THE OTHER HALF OF A CHANGE THAT WOULD OTHERWISE BE UNMEASURED. Editing the canned prose without an
 * assertion over the result would be "a lot of strings moved and nobody said what they moved to".
 *
 * THE DENOMINATOR IS READ FROM THE RUN, never written down here. A literal 10 would go GREEN on the day a template
 * gained a chapter — the fixture would be checking the chapters it wrote against the chapters it wrote — which is
 * the failure mode a fixture can least afford, because it is silent.
 *
 * IT COVERS EVERY PLANNED DOCUMENT OF BOTH CHAINS, not just the first. Both fixtures are asked for TWO audiences,
 * so each run carries more than one planned document and a rule that only ever held for `overview-product` cannot
 * pass here.
 *
 * THE EXTRACTOR BELOW IS LOCAL ON PURPOSE, and it is the narrow form: a level-two ATX heading whose title opens
 * with digits and a period. `## Contents` and `## Companions` — written by the assembler itself — carry no number
 * and fall outside it, which is why the ordinals can be compared against `1..N` directly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { unitDocumentReportPath } from "../src/report/unit-assembly-paths.ts";
import { assembleUnits } from "../src/run/stages/unit-assemble-stage.ts";
import { chapterAllocation, plannedChapterCounts } from "./fixture-chapters.ts";
import { assembledConsistencyRun } from "./unit-consistency-fixture.ts";
import { collectedRun } from "./unit-assembly-fixture.ts";

/** The ordinals of one document's numbered chapters, in document order. */
function chapterOrdinals(markdown: string): readonly number[] {
  return [...markdown.matchAll(/^##[ \t]+(\d+)\./gmu)].map((match) => Number.parseInt(match[1]!, 10));
}

/** `1..count`, the sequence a conforming deliverable prints. */
function ascending(count: number): readonly number[] {
  return Array.from({ length: count }, (_unused, index) => index + 1);
}

test("the extractor this file checks with reads a numbered chapter and skips the assembler's own headings", () => {
  // The instrument first: an extractor that returned nothing would make every assertion below pass for the wrong
  // reason on a document with no chapters at all, since `[]` would then be compared against `[]`.
  const sample = "## Contents\n\n## Companions\n\n## 1. 概述\n\n### 1.1 不是章\n\n## 2. 规则\n";
  assert.deepEqual(chapterOrdinals(sample), [1, 2]);
  assert.deepEqual(chapterOrdinals("## Contents\n"), []);
  assert.notDeepEqual(chapterOrdinals(sample), ascending(3));
});

test("chapter allocation deals every ordinal exactly once, ascending, however many units share a document", () => {
  for (const [units, chapters] of [[1, 10], [2, 10], [4, 10], [3, 3], [5, 3], [13, 13]] as const) {
    const unitIds = Array.from({ length: units }, (_unused, index) => `u${index}`);
    const allocation = chapterAllocation(unitIds, chapters);
    const dealt = unitIds.flatMap((unitId) => [...(allocation.get(unitId) ?? [])]);
    assert.deepEqual(dealt, ascending(chapters), `${units} unit(s) over ${chapters} chapter(s)`);
  }
  // A count a planned document cannot have is refused rather than allocated as an empty deal.
  assert.throws(() => chapterAllocation(["u0"], 0), /at least one requirement row/);
});

test("every planned document of the model-free chains numbers its chapters 1..N for the N rows the run recorded", async () => {
  const assembled = await collectedRun(["product", "engineering"]);
  await assembleUnits(assembled.runDir, "write");
  const runDirs = [assembled.runDir, (await assembledConsistencyRun({}, ["product", "engineering"])).runDir];

  for (const runDir of runDirs) {
    const counts = await plannedChapterCounts(runDir);
    assert.ok(counts.size >= 2, `a one-document run cannot show that this holds per document: ${[...counts.keys()].join(", ")}`);
    for (const [documentId, expected] of counts) {
      assert.ok(expected >= 1, `${documentId} recorded ${expected} template-section requirement row(s)`);
      const markdown = await readFile(join(runDir, unitDocumentReportPath(documentId)), "utf8");
      assert.deepEqual(
        chapterOrdinals(markdown),
        ascending(expected),
        `${documentId} owes ${expected} numbered chapter(s) by this run's requirement rows`
      );
    }
  }
});
