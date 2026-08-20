import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { COVERAGE_STATEMENT_PREFIXES } from "../src/investigation/coverage-statement.ts";
import { readingExposure, renderReadingBoundary, renderReadingCheck, type ReadingExposureInput } from "../src/investigation/read-residual-exposure.ts";
import { anchorHitFor } from "../src/obligation/relevance-annotation.ts";
import type { ReadCoverageItem } from "../src/investigation/read-coverage.ts";
import type { ReadObligation } from "../src/obligation/read-obligations.ts";

// This block reaches an author who cannot cheaply act on it (every post-freeze window costs a supplement)
// and a pre-freeze investigator who can. Both readings come from one grouping, so these tests pin the
// grouping against REAL adjudicated data first, then pin the two renderings' characters separately: the
// console must answer an empty query out loud, the packet must stay silent, and neither may ask for a
// sentence per entry — the shape that produced measurable garbage when the condition inventory did it.

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, "..", "eval", "golden", "read-attribution-wcp-leave.json");
const ANCHORS = ["请假管理", "leave", "请假", "leaves"];
const FEATURE = "请假管理-970cf024db";

interface GoldenItem { path: string; name: string; startLine: number; endLine: number; lines: number; kind: string }

/**
 * Build the module's two inputs from the hand-adjudicated golden — the same 225 never-opened obligations
 * the attribution gate is judged against, so one adjudication serves both consumers and they can never
 * drift. A never-opened obligation has its whole span unread, which is why `lines` is `uncoveredLines`.
 */
function fromGolden(overrides: Partial<ReadingExposureInput> = {}): ReadingExposureInput {
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as { items: GoldenItem[] };
  const obligations: ReadObligation[] = [];
  const items: ReadCoverageItem[] = [];
  for (const entry of golden.items) {
    const id = `${entry.path}:${entry.startLine}`;
    obligations.push({
      id,
      kind: entry.kind as ReadObligation["kind"],
      featureKey: FEATURE,
      name: entry.name,
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      lines: entry.lines,
      tier: 1,
      gated: false,
      anchorHit: anchorHitFor({ name: entry.name, path: entry.path }, ANCHORS),
    });
    items.push({
      id,
      name: entry.name,
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      tier: 1,
      gated: false,
      status: "not-opened",
      openedWindows: [],
      openedLines: 0,
      uncovered: [{ start: entry.startLine, end: entry.endLine }],
      uncoveredLines: entry.lines,
      consumedBy: [],
    });
  }
  return { obligations, items, annotated: true, ...overrides };
}

function obligation(over: Partial<ReadObligation> & { id: string; name: string; path: string }): ReadObligation {
  return { kind: "boundary-decision-function", featureKey: FEATURE, startLine: 10, endLine: 40, lines: 31, tier: 2, gated: false, ...over };
}

function item(over: Partial<ReadCoverageItem> & { id: string; name: string; path: string }): ReadCoverageItem {
  return {
    startLine: 10, endLine: 40, tier: 2, gated: false, status: "not-opened", openedWindows: [], openedLines: 0,
    uncovered: [{ start: 10, end: 40 }], uncoveredLines: 31, consumedBy: [], ...over,
  };
}

// --- the grouping, against real adjudicated data ---

test("the grouping reproduces the real run's strong partition exactly", () => {
  const exposure = readingExposure(fromGolden());
  assert.deepEqual(exposure.totals, { functions: 99, files: 25, unreadLines: 4121, retained: 54, named: 7, inDirectory: 38 });
  assert.equal(exposure.unclassified.count, 126);
  assert.equal(exposure.unclassified.unreadLines, 5503);
  assert.equal(exposure.totals.functions + exposure.unclassified.count, 225, "every adjudicated obligation lands in exactly one of the two");
});

test("files are ranked by unread weight, and the two heaviest are the clusters a human judged real", () => {
  const exposure = readingExposure(fromGolden());
  assert.deepEqual(
    exposure.files.slice(0, 2).map((file) => [file.path, file.functions.length, file.unreadLines]),
    [
      ["wcp-service-v2/internal/handlers/leave/notification.go", 28, 1111],
      ["wcp-service/services/leaveService.js", 25, 806],
    ],
  );
});

// The whole reason the partition exists: the old undivided reading put noise-dominated files at the top.
// "Noise-dominated" is the honest claim, not "noise": one of this file's functions IS prune-retained, so
// the partition demotes the file's weight rather than erasing the file. That is the whole difference
// between labelling and filtering.
test("the files that misdirected the old reading are below the fold, not deleted", () => {
  const exposure = readingExposure(fromGolden());
  const noise = "wcp-service-v2/internal/handlers/management/service.go";
  assert.ok(!exposure.files.slice(0, 5).some((file) => file.path === noise), "the file that headed the old top-5 is out of the new one");
  const strongWeight = exposure.files.find((file) => file.path === noise)?.unreadLines ?? 0;
  const unplacedWeight = exposure.unclassified.files.find((file) => file.path === noise)?.unreadLines ?? 0;
  assert.equal(strongWeight, 28, "one retained function keeps the file present, at its real weight");
  assert.ok(unplacedWeight > strongWeight * 50, `and the other ${unplacedWeight} lines are reported as unplaceable rather than as something to steer by`);
  assert.equal(exposure.unclassified.files[0]?.path, noise, "which is where the old reading's heaviest file actually belongs");
  const leaked = exposure.unclassified.files.find((file) => file.path.endsWith("retiredSummaryReportService.js"));
  assert.ok(leaked, "the real miss this signal is measured to leak stays visible — that is why the partition is reported at all");
});

// --- the grouping's character ---

test("kind beats vocabulary, and vocabulary is only consulted when kind does not decide", () => {
  const exposure = readingExposure({
    annotated: true,
    obligations: [
      obligation({ id: "a", name: "OrderSheet", path: "svc/mgmt/x.go", kind: "decision-function" }),
      obligation({ id: "b", name: "approveLeave", path: "svc/mgmt/x.go", anchorHit: "name" }),
      obligation({ id: "c", name: "Recipients", path: "svc/leave/x.go", anchorHit: "path" }),
      obligation({ id: "d", name: "OrderSheet", path: "svc/mgmt/y.go" }),
    ],
    items: ["a", "b", "c", "d"].map((id) => item({ id, name: id, path: id === "c" ? "svc/leave/x.go" : id === "d" ? "svc/mgmt/y.go" : "svc/mgmt/x.go" })),
  });
  assert.deepEqual(exposure.totals, { functions: 3, files: 2, unreadLines: 93, retained: 1, named: 1, inDirectory: 1 });
  assert.equal(exposure.unclassified.count, 1);
});

test("an obligation that was opened is in no partition — these describe what was NOT read", () => {
  const exposure = readingExposure({
    annotated: true,
    obligations: [obligation({ id: "a", name: "f", path: "p.go", kind: "decision-function" })],
    items: [item({ id: "a", name: "f", path: "p.go", status: "covered", uncoveredLines: 0 })],
  });
  assert.equal(exposure.totals.functions, 0);
});

test("one feature's residual never appears under another's key", () => {
  const input: ReadingExposureInput = {
    annotated: true,
    obligations: [
      obligation({ id: "a", name: "f", path: "leave.go", kind: "decision-function" }),
      obligation({ id: "b", name: "g", path: "billing.go", kind: "decision-function", featureKey: "billing" }),
    ],
    items: [item({ id: "a", name: "f", path: "leave.go" }), item({ id: "b", name: "g", path: "billing.go" })],
  };
  assert.equal(readingExposure({ ...input, featureKey: FEATURE }).totals.functions, 1);
  assert.equal(readingExposure({ ...input, featureKey: "billing" }).files[0]?.path, "billing.go");
  assert.equal(readingExposure(input).totals.functions, 2, "with no key the whole run is in scope, which is what the console asks for");
});

// A run frozen before the labels existed has no partition; inventing one from `kind` alone would report a
// different reading than that run's own residual carries.
test("an unannotated run yields no partition, in either rendering", () => {
  const input = fromGolden({ annotated: false });
  const exposure = readingExposure(input);
  assert.equal(renderReadingBoundary(exposure), "");
  assert.match(renderReadingCheck(exposure, { frozen: false }), /no anchor labels/);
});

// --- the packet block ---

test("the packet block states a boundary and asks for nothing countable", () => {
  const block = renderReadingBoundary(readingExposure(fromGolden()));
  assert.match(block, /^## Reading boundary/);
  assert.match(block, /99 functions across 25 files, 4121 unread lines — retained 54, named 7, in-directory 38\./);
  assert.match(block, /Do not answer this list item by item/);
  assert.match(block, /do not open windows merely to shorten it/);
  // "do not reproduce it" forbids dumping the list; an earlier draft said "do not mention it in the report",
  // which a careful author could read as "do not disclose what went unread" — the opposite of the honesty
  // this block exists to serve, and it would suppress legitimate `unavailable` claims.
  assert.match(block, /do not reproduce it in the report/);
  assert.doesNotMatch(block, /do not mention it in the report/);
  assert.match(block, /state what was verified rather than speculating about what was never read/);
  assert.match(block, /no audit counts anything in this block/);
  assert.doesNotMatch(block, /State every|state every one/, "the condition inventory's wording is what produced sentences written for the counter");
  assert.doesNotMatch(block, /\d+%|a quarter|a third|half of/, "one target's fraction would be printed with authority on every other target");
});

test("the packet block caps both levels and says what it cut, after stating the full size", () => {
  const block = renderReadingBoundary(readingExposure(fromGolden()));
  const headline = block.indexOf("99 functions across 25 files");
  const firstCut = block.indexOf("… 23 more in this file");
  assert.ok(headline > 0 && firstCut > headline, "the totals precede any truncation, so a capped list still states what it was cut from");
  assert.ok(block.includes("  - … 23 more in this file, in coverage/read-residual.json"), "notification.go's 28 functions show 5");
  assert.match(block, /A further 126 never-opened functions \(5503 line\(s\)\) carry none of this feature's vocabulary and are not listed here/);
});

test("more files than the cap leaves a remainder line carrying the count and the weight", () => {
  const obligations: ReadObligation[] = [];
  const items: ReadCoverageItem[] = [];
  for (let index = 0; index < 33; index += 1) {
    const path = `svc/f${String(index).padStart(2, "0")}.go`;
    obligations.push(obligation({ id: `o${index}`, name: `fn${index}`, path, kind: "decision-function" }));
    items.push(item({ id: `o${index}`, name: `fn${index}`, path, uncoveredLines: 100 - index }));
  }
  const block = renderReadingBoundary(readingExposure({ obligations, items, annotated: true }));
  assert.match(block, /33 functions across 33 files/);
  assert.match(block, /- … 3 more file\(s\) \(\d+ unread lines\) in coverage\/read-residual\.json/);
});

// An advisory block that renders when it has nothing to say teaches people to skip advisory blocks.
test("nothing to say means no block at all — including the unclassified line", () => {
  const exposure = readingExposure({
    annotated: true,
    obligations: [obligation({ id: "a", name: "f", path: "p.go" })],
    items: [item({ id: "a", name: "f", path: "p.go" })],
  });
  assert.equal(exposure.totals.functions, 0);
  assert.ok(exposure.unclassified.count > 0, "there IS unclassified residual");
  assert.equal(renderReadingBoundary(exposure), "", "but no strong partition means no block, so the unclassified line has nowhere to appear");
});

// --- the console rendering ---

test("the console says which price the reader is being quoted", () => {
  const exposure = readingExposure(fromGolden());
  assert.match(renderReadingCheck(exposure, { frozen: false }), /not frozen: opening a window is still ordinary investigation/);
  assert.match(renderReadingCheck(exposure, { frozen: true }), /frozen: .*requires --supplement-reason and --supplement-workitem/);
});

test("the console frames an investment, never a quota", () => {
  const report = renderReadingCheck(readingExposure(fromGolden()), { frozen: false });
  assert.match(report, /investment\s+aid, not a quota/);
  assert.match(report, /leaving the rest unread\s+is the normal outcome/);
  assert.match(report, /nothing counts how many entries you clear/);
});

// The opposite rule to the packet's: a direct question answered with silence reads as a malfunction. So an
// empty result is printed — but 57B-449 is which empty result. An empty DENOMINATOR and an empty RESIDUAL are
// two facts, and the old code printed the second sentence for both.
test("an empty console result is printed out loud, and an empty denominator is not the covered one", () => {
  const empty = renderReadingCheck(readingExposure({ obligations: [], items: [], annotated: true }), { frozen: false });
  // THE 449 REGRESSION GUARD. Measured on the cebreo baseline: 2,142 counted files, `obligations: []`, 22 usable
  // windows, and the sentence below asserting every obligation had a window. Restoring either wording reddens.
  assert.ok(!empty.includes(COVERAGE_STATEMENT_PREFIXES.complete), `an empty denominator must not read as covered:\n${empty}`);
  assert.doesNotMatch(empty, /No feature-associated read residual/, "the true-over-the-empty-set sentence needs a denominator to be about");
  assert.ok(empty.includes(`${COVERAGE_STATEMENT_PREFIXES.vacuous}ledger-empty)`), empty);
  assert.match(empty, /requested no feature has none by construction/, "and it says what produces an empty denominator");

  // The positive half, which is what stops this from being a test that only ever passes: with a real denominator
  // and every row covered by a window, the covered wording IS printed, along with the strong-partition sentence.
  const golden = fromGolden();
  const allCovered = readingExposure({
    ...golden,
    items: golden.items.map((row) => ({ ...row, status: "covered" as const, uncovered: [], uncoveredLines: 0, openedLines: row.endLine! - row.startLine + 1 }))
  });
  const covered = renderReadingCheck(allCovered, { frozen: false });
  assert.ok(covered.includes(COVERAGE_STATEMENT_PREFIXES.complete), covered);
  assert.match(covered, /No feature-associated read residual/);
  assert.ok(!covered.includes("vacuous ("), "a present, non-empty ledger is never vacuous");

  // AND THE MIS-FOLD GUARD (found by review, verified red before the fix): "covered" is the WINDOWED bucket, never
  // `rows - notOpened`. A ledger-excluded row and an unreconcilable row are neither read nor unread, and folding
  // either into the covered count is how 27 of wcp's 946 rows would print as covered.
  const mixed = readingExposure({
    obligations: [
      { ...golden.obligations[0]!, id: "covered-1" },
      { ...golden.obligations[1]!, id: "excluded-1", excluded: "declaration-only" },
      { ...golden.obligations[2]!, id: "nospan-1", endLine: undefined }
    ],
    items: [
      { ...golden.items[0]!, id: "covered-1", status: "covered", uncovered: [], uncoveredLines: 0 },
      { ...golden.items[2]!, id: "nospan-1", status: "cannot-determine", uncovered: [], uncoveredLines: 0 }
    ],
    annotated: true
  });
  assert.deepEqual(
    { ...mixed.denominator },
    { rows: 3, withWindowRows: 1, notOpened: 0, unreconcilableRows: 1, ledgerExcludedRows: 1 },
    "the four buckets partition the ledger's rows; `rows - notOpened` would have called all three covered"
  );
  const mixedReport = renderReadingCheck(mixed, { frozen: true });
  assert.ok(!mixedReport.includes(COVERAGE_STATEMENT_PREFIXES.complete), mixedReport);
  assert.ok(mixedReport.includes("declaration-only or contained in another obligation"), mixedReport);
  assert.ok(mixedReport.includes("no end line"), mixedReport);
});

test("the console keeps every span but lists the unplaceable partition per file only", () => {
  const report = renderReadingCheck(readingExposure(fromGolden()), { frozen: false });
  const notification = report.split("\n").filter((line) => line.startsWith("  ") && /lines \d+-\d+/.test(line));
  assert.equal(notification.length, 99, "every strong obligation keeps its span: the console is where windows get opened");
  assert.match(report, /wcp-service-v2\/internal\/handlers\/management\/service\.go — 40 functions, 2156 unread lines/);
  assert.doesNotMatch(report, /OrderSheetMember — lines/, "unclassified files are counted, never expanded");
  assert.match(report, /… 4 more file\(s\) \(133 unread lines\) not shown\./);
});

test("ordering is total, so two runs of the same denominator render the same bytes", () => {
  const input = fromGolden();
  assert.equal(renderReadingBoundary(readingExposure(input)), renderReadingBoundary(readingExposure(input)));
  const shuffled = { ...input, obligations: [...input.obligations].reverse(), items: [...input.items].reverse() };
  assert.equal(renderReadingBoundary(readingExposure(shuffled)), renderReadingBoundary(readingExposure(input)), "input order cannot change the reading");
});
