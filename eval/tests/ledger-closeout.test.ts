// Transcribed close-out (57B-441 R0). The numbers and the reason strings below are hand-written from the fixture's
// own `investigation/results.json`, not read back off the tool.
//
// The fixture is built so that every way a transcription can be REFUSED has exactly one item: no settledBy at all,
// a settledBy naming no execution, an execution that delivered source and therefore records no cause, an
// execution citing no limitation evidence, an execution with no disposition, and an execution whose disposition is
// `fulfilled`. Two items are transcribable, with two DIFFERENT causes so the `causes` tally cannot pass by
// accident, and one item is already `found` so the "never touch a terminal item" rule has a witness.
//
// The load-bearing assertion is the last one: after the tool's updates are merged, `auditWorkItems` — the very
// function `freezePreconditions` calls — reports exactly the refused ids as not completed. That is what makes this
// a close-out tool rather than a report.

import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLedgerCloseout, type LedgerCloseout } from "../ledger-closeout.ts";
import { auditWorkItems, mergeWorkItems } from "../../src/investigation/assurance.ts";
import type { EvidenceItem, InvestigationPlan } from "../../src/base/types.ts";
import { stableJson } from "../../src/base/util.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "closeout-budget-exhausted");
const closeout = buildLedgerCloseout(FIXTURE);

/** The six ids the fixture makes untranscribable, one per refusal reason. */
const REFUSED = [
  "feature:leave:logic:fulfilledDisp@src/v.ts:1",
  "feature:leave:logic:noCause@src/y.ts:1",
  "feature:leave:logic:noDisposition@src/w.ts:1",
  "feature:leave:logic:noEvidence@src/z.ts:1",
  "feature:leave:logic:unknownExec@src/x.ts:1",
  "project:literal-secrets"
];

async function copyFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ledger-closeout-"));
  await cp(FIXTURE, dir, { recursive: true });
  return dir;
}

// --- ① the census: what was closed, what was left alone ---

test("the close-out reports every unsettled item as either transcribed or named, and nothing else", () => {
  // 9 items: 1 already `found`, 8 unsettled (7 pending + 1 in_progress).
  assert.equal(closeout.items, 9);
  assert.equal(closeout.terminal, 1);
  assert.equal(closeout.unsettled, 8);
  assert.equal(closeout.transcribed, 2);
  assert.equal(closeout.untranscribable, 6);
  // Conservation: the two buckets exhaust the unsettled population, and the terminal item is in neither.
  assert.equal(closeout.rows.length + closeout.gaps.length, closeout.unsettled);
  assert.equal(closeout.terminal + closeout.unsettled, closeout.items);
  const touched = new Set([...closeout.rows.map((row) => row.update.id), ...closeout.gaps.map((gap) => gap.id)]);
  assert.equal(touched.has("feature:leave:already-found"), false, "an item that already holds a terminal status must not appear at all");
  assert.equal(touched.size, 8);
});

test("the transcribed causes are tallied from the records, not assumed to be one cause", () => {
  assert.deepEqual(closeout.causes, { "authorized-span-past-end-of-file": 1, "source-window-budget-exceeded": 1 });
  assert.deepEqual(closeout.untranscribableByDimension, {
    "coverage-accounting": 2,
    "literal-secrets": 1,
    "logic-disposition": 3
  });
});

// --- ② the reason is a transcription: every substring comes off the record ---

test("each reason quotes its own execution's id, span, outcome and cause verbatim", () => {
  const row = closeout.rows.find((entry) => entry.update.id === "feature:leave:logic:mixConsume@src/leave.ts:10");
  assert.ok(row, "mixConsume must be transcribed");
  assert.equal(row.update.reason,
    'The authorized read was not completed: execution EXEC-1 of src/leave.ts:10-90 recorded outcome "unavailable" '
    + 'with cause "source-window-budget-exceeded" (transcribed from investigation/results.json).');
  assert.equal(row.update.settledBy, "EXEC-1");
  assert.deepEqual(row.update.evidenceIds, ["LEDGER-READ-1"]);
  assert.equal(row.update.status, "cannot-determine");

  // The second row carries the OTHER cause and the other execution's own evidence, so no field is shared frame.
  const other = closeout.rows.find((entry) => entry.update.id === "feature:leave:logic:approve@src/approve.ts:5");
  assert.ok(other);
  assert.equal(other.update.reason,
    'The authorized read was not completed: execution EXEC-2 of src/approve.ts:5-40 recorded outcome "unavailable" '
    + 'with cause "authorized-span-past-end-of-file" (transcribed from investigation/results.json).');
  assert.deepEqual(other.update.evidenceIds, ["LEDGER-READ-2", "LEDGER-READ-3"]);
});

test("every row's provenance points back at the record its reason was read from", () => {
  const results = JSON.parse(readFileSync(join(FIXTURE, "investigation", "results.json"), "utf8")) as
    { value: { executions: Array<{ id: string; cause?: string; outcome: string; path: string; declarationId: string; readSpecId: string; requestedSpan: { startLine: number; endLine: number } }> } };
  const byId = new Map(results.value.executions.map((execution) => [execution.id, execution]));
  for (const row of closeout.rows) {
    const execution = byId.get(row.source.executionId);
    assert.ok(execution, `${row.source.executionId} must be an execution in the fixture`);
    assert.equal(row.source.cause, execution.cause);
    assert.equal(row.source.outcome, execution.outcome);
    assert.equal(row.source.path, execution.path);
    assert.equal(row.source.declarationId, execution.declarationId);
    assert.equal(row.source.readSpecId, execution.readSpecId);
    assert.equal(row.source.span, `${execution.requestedSpan.startLine}-${execution.requestedSpan.endLine}`);
    // The reason must be re-derivable from the record alone: both quoted fields appear in it verbatim.
    assert.ok(row.update.reason.includes(`"${execution.cause}"`));
    assert.ok(row.update.reason.includes(`"${execution.outcome}"`));
    assert.ok(row.update.reason.includes(execution.id));
  }
});

test("an applied update carries only work-item fields, so provenance cannot leak into workitems.json", () => {
  // `mergeWorkItems` spreads the update onto the item, so an extra key here would be written into the run.
  for (const row of closeout.rows) {
    assert.deepEqual(Object.keys(row.update).sort(), ["evidenceIds", "id", "reason", "settledBy", "status"]);
  }
});

// --- ③ refusal: named, never filled in ---

test("every unsettled item without a transcribable cause is named, with the structural fact that stops it", () => {
  assert.deepEqual(closeout.gaps.map((gap) => gap.id), REFUSED, "gaps must be sorted by id");
  const why = new Map(closeout.gaps.map((gap) => [gap.id, gap.why]));
  assert.match(why.get("project:literal-secrets")!, /carries no settledBy, so investigation\/results\.json links no read execution to it/);
  assert.match(why.get("feature:leave:logic:unknownExec@src/x.ts:1")!, /settledBy EXEC-NOT-IN-RESULTS matches no execution id/);
  assert.match(why.get("feature:leave:logic:noCause@src/y.ts:1")!, /execution EXEC-NO-CAUSE records no cause, so there is no reason to transcribe/);
  assert.match(why.get("feature:leave:logic:noEvidence@src/z.ts:1")!, /execution EXEC-NO-EVIDENCE cites no evidence, and a cannot-determine work item requires limitation evidence/);
  assert.match(why.get("feature:leave:logic:noDisposition@src/w.ts:1")!, /execution EXEC-NO-DISPOSITION has no disposition/);
  assert.match(why.get("feature:leave:logic:fulfilledDisp@src/v.ts:1")!, /the disposition for execution EXEC-FULFILLED is "fulfilled", not "pending"/);
  // The in_progress item is in the population too: the freeze gate treats it exactly like pending.
  assert.equal(closeout.gaps.find((gap) => gap.id === "feature:leave:logic:noEvidence@src/z.ts:1")!.status, "in_progress");
  // No gap ever acquires a reason. The refusal is the whole output for these items.
  for (const gap of closeout.gaps) assert.equal("reason" in gap, false);
});

test("a refused item's cause is never borrowed from another item that does have one", () => {
  // Both transcribable rows use `source-window-budget-exceeded`-family causes, and three refused executions carry
  // that same cause on disk. If the tool ever fell back to "the run's cause", these six would be closed.
  const reasons = closeout.rows.map((row) => row.update.reason);
  for (const gap of closeout.gaps) {
    assert.equal(reasons.some((reason) => reason.includes(gap.id)), false);
  }
  assert.equal(closeout.rows.some((row) => REFUSED.includes(row.update.id)), false);
});

// --- ④ the point of the tool: after applying, freeze's own gate names exactly the refused ids ---

test("merging the updates leaves auditWorkItems naming exactly the refused ids as not completed", () => {
  const plan = JSON.parse(readFileSync(join(FIXTURE, "workitems.json"), "utf8")) as InvestigationPlan;
  const evidenceById = new Map<string, EvidenceItem>(
    ["LEDGER-READ-1", "LEDGER-READ-2", "LEDGER-READ-3", "LEDGER-READ-4", "LEDGER-READ-5", "LEDGER-READ-6"]
      .map((id) => [id, { id, kind: "ledger", summary: id, data: {} } as unknown as EvidenceItem])
  );

  const before = auditWorkItems(plan, plan, evidenceById, new Set<string>())
    .filter((finding) => finding.message.startsWith("work item was not completed:"));
  assert.equal(before.length, 8, "all eight unsettled items must be errors before the close-out");

  const merged = mergeWorkItems(plan, closeout.rows.map((row) => row.update));
  const after = auditWorkItems(merged, plan, evidenceById, new Set<string>());
  const notCompleted = after
    .filter((finding) => finding.message.startsWith("work item was not completed:"))
    .map((finding) => finding.message.replace("work item was not completed: ", ""))
    .sort();
  assert.deepEqual(notCompleted, REFUSED);
  // And the transcribed items pass the full cannot-determine contract, not just the status check: no finding of
  // any kind mentions them.
  for (const row of closeout.rows) {
    assert.equal(after.some((finding) => finding.message.includes(row.update.id)), false, `${row.update.id} must be audit-clean after the close-out`);
  }
});

// --- ⑤ determinism and named failure ---

test("the same run directory projects to the same bytes twice", () => {
  assert.equal(stableJson(buildLedgerCloseout(FIXTURE)), stableJson(closeout));
});

test("an unusable input fails by name, with no empty close-out", async () => {
  const cases: Array<[string, RegExp, (dir: string) => Promise<void>]> = [
    ["run.json", /ledger closeout: run.json is missing/, async (dir) => rm(join(dir, "run.json"))],
    ["workitems.json", /ledger closeout: workitems.json is missing/, async (dir) => rm(join(dir, "workitems.json"))],
    ["results.json", /ledger closeout: investigation\/results.json is missing/, async (dir) => rm(join(dir, "investigation", "results.json"))],
    ["unparseable results", /ledger closeout: investigation\/results.json is not valid JSON/, async (dir) => writeFile(join(dir, "investigation", "results.json"), "{ not json")],
    ["unavailable stage", /ledger closeout: investigation\/results.json is "unavailable", not "built"/, async (dir) =>
      writeFile(join(dir, "investigation", "results.json"), JSON.stringify({ status: "unavailable", cause: "no reader" }))],
    ["no executions array", /ledger closeout: investigation\/results.json has no executions array/, async (dir) =>
      patch(dir, (results) => { delete results.value.executions; })],
    ["no dispositions array", /ledger closeout: investigation\/results.json has no dispositions array/, async (dir) =>
      patch(dir, (results) => { delete results.value.dispositions; })],
    ["duplicate execution id", /ledger closeout: investigation\/results.json has two executions with id EXEC-1/, async (dir) =>
      patch(dir, (results) => { results.value.executions.push({ ...results.value.executions[0] }); })],
    ["execution with no id", /ledger closeout: investigation\/results.json has an execution with no id/, async (dir) =>
      patch(dir, (results) => { delete results.value.executions[0].id; })],
    ["item with no status", /ledger closeout: work item project:literal-secrets has no status/, async (dir) => {
      const path = join(dir, "workitems.json");
      const plan = JSON.parse(readFileSync(path, "utf8")) as { items: Array<Record<string, unknown>> };
      delete plan.items.find((item) => item.id === "project:literal-secrets")!.status;
      await writeFile(path, JSON.stringify(plan));
    }],
    ["items array", /ledger closeout: workitems.json has no items array/, async (dir) => writeFile(join(dir, "workitems.json"), JSON.stringify({ version: 1 }))]
  ];
  for (const [label, expected, mutate] of cases) {
    const dir = await copyFixture();
    try {
      await mutate(dir);
      assert.throws(() => buildLedgerCloseout(dir), expected, `${label} must fail by name`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("a path that is not a run directory fails by name", () => {
  assert.throws(() => buildLedgerCloseout(join(FIXTURE, "no-such-directory")), /ledger closeout: .* is not a directory/);
});

async function patch(dir: string, mutate: (results: Record<string, any>) => void): Promise<void> {
  const path = join(dir, "investigation", "results.json");
  const results = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  mutate(results);
  await writeFile(path, JSON.stringify(results, null, 2));
}

// A typed handle on the report so a future field addition has to be read here too.
const _shape: LedgerCloseout = closeout;
void _shape;
