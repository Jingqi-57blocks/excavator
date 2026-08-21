import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { AuditFinding, EvidenceItem } from "../src/base/types.ts";
import { auditRun, freezeRun, prepareRun } from "../src/run/run.ts";
import { appendTimeline } from "../src/base/timeline.ts";
import { disposeAllWorkItems, manifestOf } from "./helpers.ts";
import { unitRequest } from "./unit-fixture.ts";
import { assembleUnits } from "../src/run/stages/unit-assemble-stage.ts";
import { collectedRun } from "./unit-assembly-fixture.ts";
import type { PlannedRun } from "./unit-fixture.ts";

/**
 * The RUN-WIDE half of `audit`, scaffolded on the unit path.
 *
 * Three of `audit`'s checks say nothing about chapters: the evidence catalog's own source ranges, the snapshot the
 * whole run was prepared against, and the timeline's hash chain. Every fixture that exercised them drove the
 * SECTION commands to reach an audited state first (`tests/run.test.ts`, `tests/assurance-workflow.test.ts`), so
 * the checks read as if they were part of the section path. They are not, and this file is that claim made
 * falsifiable: a run whose only authoring is `checkpoint --unit` and `assemble --units` still gets all three.
 *
 * Each test asserts the finding is ABSENT first and present after one named mutation. Without the before-half a
 * check that had stopped running would still look covered, because the assertion only ever wanted a match.
 *
 * The unit-path run does carry two section-path errors of its own here — the section document is planned and never
 * authored — so these tests scope to the finding under test rather than to an empty error list. That is the honest
 * scope while both paths exist; it is also why the assertions name their message rather than counting.
 */

async function auditedUnitRun(): Promise<PlannedRun> {
  const run = await collectedRun();
  await assembleUnits(run.runDir, "write");
  return run;
}

/** The pre-v3 stamp both freeze-gate files use: not the current ASSURANCE_VERSION, so the gates grandfather it. */
const LEGACY_VERSION = "assurance-v2-redaction-v4";

/**
 * A prepared, UNFROZEN run carrying one authoring-stage timeline event.
 *
 * The event is appended through `appendTimeline` — the same writer `collectUnits` uses (`unit-collect.ts:162`
 * appends `stage: "authoring"`), so the chain stays valid and this is not a forged timeline. It has to be built
 * this way because no unit COMMAND can produce the ordering: `draftUnit` and `collectUnits` both call the epoch
 * gate unconditionally, so authoring-before-freeze is unreachable from the CLI on this path. Reachability is
 * therefore NOT claimed here; what is claimed is that the audit rule still fires on the ordering it is about.
 */
async function unfrozenRunWithAuthoringEvent(): Promise<{ runDir: string; documentId: string }> {
  const { runDir, manifest } = await prepareRun(await unitRequest());
  const documentId = manifest.documents[0]!.id;
  await appendTimeline(runDir, manifest.id, { stage: "authoring", action: "unit.checkpoint", documentId });
  // `documentId` is returned because the scoped-audit case below audits THAT document by name.
  return { runDir, documentId };
}

function matching(findings: readonly AuditFinding[], pattern: RegExp): AuditFinding[] {
  return findings.filter((finding) => pattern.test(finding.message));
}

test("a unit-path run's audit rejects an invalid source range even when its evidence id exists", async () => {
  const run = await auditedUnitRun();
  const pattern = /invalid source range/i;
  assert.deepEqual(matching((await auditRun(run.runDir)).findings, pattern), [], "the fixture's evidence ranges are valid to begin with");

  const evidencePath = join(run.runDir, "evidence.json");
  const catalog = JSON.parse(await readFile(evidencePath, "utf8")) as { evidence: EvidenceItem[] };
  const source = catalog.evidence.find((item) => item.kind === "source");
  assert.ok(source, "the fixture run records at least one source window");
  source.endLine = 999_999;
  await writeFile(evidencePath, JSON.stringify(catalog, null, 2));

  const after = await auditRun(run.runDir);
  assert.ok(matching(after.findings, pattern).some((finding) => finding.level === "error" && finding.message.includes(source.id)),
    JSON.stringify(after.findings, null, 2));
});

test("a unit-path run's audit rejects stale source evidence after the target changes", async () => {
  const run = await auditedUnitRun();
  const pattern = /source snapshot changed/;
  assert.deepEqual(matching((await auditRun(run.runDir)).findings, pattern), [], "the target is untouched to begin with");

  await writeFile(join(run.manifest.request.target, "src", "server.ts"), "export const changed = true;\n");

  const after = await auditRun(run.runDir);
  assert.ok(matching(after.findings, pattern).some((finding) => finding.level === "error"), JSON.stringify(after.findings, null, 2));
});

test("a unit-path run's audit detects timeline tampering", async () => {
  const run = await auditedUnitRun();
  const timelinePath = join(run.runDir, "timeline.jsonl");
  const before = await auditRun(run.runDir);
  assert.deepEqual(before.findings.filter((finding) => finding.document === "timeline"), [],
    "the unit path's own appends leave a chain that audits clean");

  const lines = (await readFile(timelinePath, "utf8")).trim().split("\n");
  const first = JSON.parse(lines[0]!) as { action: string };
  first.action = "tampered";
  lines[0] = JSON.stringify(first);
  await writeFile(timelinePath, `${lines.join("\n")}\n`);

  // The HASH CHAIN specifically. Editing an event also trips "does not start with run.prepared" and the byte
  // offset, so a pattern that accepted any timeline finding would stay green with the digest recomputation
  // deleted — which is the one check this test is named after.
  const after = await auditRun(run.runDir);
  assert.ok(after.findings.some((finding) => finding.document === "timeline" && finding.message.includes("timeline event 1 digest is invalid")),
    JSON.stringify(after.findings, null, 2));
});

// --- migrated: the two run-wide audit rules whose only coverage sat on the section chain ---------------

/**
 * MIGRATED FROM `tests/freeze-hard-gate.test.ts` ③④ AND `tests/freeze.test.ts:310` (57B-480 batch 2e).
 *
 * All three of those drove `checkpointSection` + `assembleRun`, so all three go with the section chain — and
 * `auditFreezeOrder` (`freeze.ts`, wired run-wide at `run.ts:883`) would have been left with ZERO coverage while
 * still being applied to every audited run, unit runs included: its key is `event.stage === "authoring"`, which
 * is exactly what `collectUnits` writes.
 *
 * This covers all THREE of its branches, where the section tests covered one each: never-frozen, frozen-late,
 * and the pre-v3 grandfather. The sentences are asserted verbatim, because "an error was reported" would pass
 * on a different rule firing for a different reason.
 */
test("a unit-path run's audit fires the freeze-order gate on each of its three branches", async () => {
  const { runDir } = await unfrozenRunWithAuthoringEvent();
  // Read off the run's OWN stamp before touching it: restoring from a value this test carries (or from an
  // audit's returned manifest) would make the restore depend on something other than what prepare wrote.
  const currentStamp = (await manifestOf(runDir)).assuranceVersion;
  const stampAs = async (version: string | undefined): Promise<void> => {
    const manifest = await manifestOf(runDir);
    manifest.assuranceVersion = version;
    await writeFile(join(runDir, "run.json"), JSON.stringify(manifest, null, 2));
  };
  const orderFindings = async (): Promise<readonly AuditFinding[]> =>
    matching((await auditRun(runDir)).findings, /never frozen|authored before the investigation was frozen/);

  // Branch 1: authoring activity, no `investigation.frozen` event at all.
  const neverFrozen = matching((await auditRun(runDir)).findings, /^run has authoring activity but was never frozen; the current assurance version requires freeze before authoring$/);
  assert.deepEqual(neverFrozen.map((finding) => finding.level), ["error"]);
  // The `document` key is part of the rule's stated contract (`freeze.ts`: "distinct from the frozen-knowledge
  // reconciliation, which uses `knowledge`"), so the same sentence under the wrong key must not pass.
  assert.deepEqual(neverFrozen.map((finding) => finding.document), ["freeze"]);

  // Branch 2: the pre-v3 grandfather, on that same timeline.
  await stampAs(LEGACY_VERSION);
  assert.deepEqual(await orderFindings(), [], "a run stamped before the gate existed is held to the contract it was written under");

  // Branch 3: freeze LATE. With the current stamp restored, freezing leaves the authoring event ahead of
  // `investigation.frozen` in the chain, which is the ordering the gate exists for.
  await stampAs(currentStamp);
  await disposeAllWorkItems(runDir);
  assert.equal((await freezeRun(runDir)).frozen, true);
  const frozenLate = matching((await auditRun(runDir)).findings, /^run was authored before the investigation was frozen \(first authoring event precedes investigation\.frozen\)$/);
  assert.deepEqual(frozenLate.map((finding) => finding.level), ["error"]);
  assert.deepEqual(frozenLate.map((finding) => finding.document), ["freeze"]);

  // And the grandfather again, now against the FROZEN-LATE ordering rather than the never-frozen one. Branch 2
  // above only ever asked it about a timeline with no freeze event at all, so a generation gate that leaked on
  // the ordering it is hardest to reason about would have passed. Both orderings, one stamp.
  await stampAs(LEGACY_VERSION);
  assert.deepEqual(await orderFindings(), [], "the grandfather covers the frozen-late ordering too, not only the never-frozen one");
});

/**
 * MIGRATED FROM `tests/run.test.ts` `audit fails when claims and checklist dispositions are missing`.
 *
 * That case asserted two findings: `no claims file` (section-shaped, retiring) and `checklist item was not
 * dispositioned` — which is `assurance.ts`'s own checklist rule and has nothing to do with sections. R8a's list
 * recorded the second one as already covered by "freeze.test.ts's disposition family", and that turned out to be
 * a family resemblance rather than the same sentence: `git grep "not dispositioned" -- tests` returned that one
 * line and nothing else. The freeze tests assert freeze REFUSALS for undisposed items; nobody asserted that the
 * AUDIT reports them.
 */
test("a unit-path run's audit reports a checklist item nobody dispositioned", async () => {
  const { runDir } = await prepareRun(await unitRequest());
  const audit = await auditRun(runDir);
  const pending = matching(audit.findings, /^checklist item was not dispositioned: /);
  assert.ok(pending.length > 0, "a prepared run's checklist starts undispositioned, and the audit has to say so");
  assert.deepEqual([...new Set(pending.map((finding) => finding.level))], ["error"]);
  assert.deepEqual([...new Set(pending.map((finding) => finding.document))], ["checklist"]);
});

/**
 * MIGRATED (57B-480 batch 2e, added after `/code-review` found a third gap the first pass missed).
 *
 * TWO THINGS, both with every existing assertion on the section chain:
 *
 * 1. THE SCOPED DOWNGRADE. `auditRun(runDir, { documentId })` keeps run-wide certifications advisory
 *    (`run.ts:600`'s `runWide = toAdvisory`), because a partial scope cannot certify the whole run. `audit
 *    --document <id>` is a LIVE CLI arm, but every assertion of the downgrade sat on `checkpointSection`-driven
 *    cases (`freeze-hard-gate` ⑤, `freeze.test.ts:355`, `assurance-workflow.test.ts:371`); the one surviving
 *    scoped call, `read-accountability-wiring.test.ts:170`, asserts a non-write rather than a level. Deleting
 *    the downgrade so scoped audits hard-fail would have gone green everywhere.
 * 2. THE RULE'S SILENT PATHS. `auditFreezeOrder` has five outcomes, not three: it also returns nothing when
 *    there is NO authoring event, and when the freeze correctly precedes the authoring. A regression that fired
 *    on a correctly ordered run would have passed the whole unit chain, because no `unit-*` test asserted a
 *    clean freeze-order verdict — the pattern-scoped `deepEqual(..., [])` assertions elsewhere in this file all
 *    happen to be about other rules.
 */
test("the freeze-order gate is silent when the order is right, and advisory when the audit is scoped", async () => {
  const ORDER = /never frozen|authored before the investigation was frozen/;

  // Silent path 1: a frozen, planned, collected unit run — freeze precedes every authoring event by construction.
  const clean = await collectedRun();
  assert.deepEqual(matching((await auditRun(clean.runDir)).findings, ORDER), [],
    "a run whose freeze precedes its authoring must draw no freeze-order finding at all");

  // Silent path 2: an unfrozen run with NO authoring event. The rule is about ordering, so a run that has not
  // begun writing is legitimately un-gated — and this is the branch a "fire whenever unfrozen" regression trips.
  const { runDir: untouched } = await prepareRun(await unitRequest());
  assert.deepEqual(matching((await auditRun(untouched)).findings, ORDER), [],
    "a run that never authored anything is not out of order");

  // The scoped downgrade, on the same fixture the run-wide case uses: same finding, warning instead of error.
  const { runDir, documentId } = await unfrozenRunWithAuthoringEvent();
  const wide = matching((await auditRun(runDir)).findings, ORDER);
  assert.deepEqual(wide.map((finding) => finding.level), ["error"], "run-wide, the order violation is an error");
  const scoped = matching((await auditRun(runDir, { documentId })).findings, ORDER);
  assert.deepEqual(scoped.map((finding) => finding.message), wide.map((finding) => finding.message),
    "the scope changes the level, never which rule fired");
  assert.deepEqual(scoped.map((finding) => finding.level), ["warning"],
    "a partial scope cannot certify the whole run, so its run-wide findings are advisory");
});
