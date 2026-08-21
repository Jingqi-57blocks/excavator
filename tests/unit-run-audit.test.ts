import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { AuditFinding, EvidenceItem } from "../src/base/types.ts";
import { auditRun } from "../src/run/run.ts";
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
