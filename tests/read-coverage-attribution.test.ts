import test from "node:test";
import assert from "node:assert/strict";
import { auditReadAccountability, reconcileReadCoverage } from "../src/investigation/read-coverage.ts";
import type { ReadObligation } from "../src/obligation/read-obligations.ts";
import type { EvidenceItem } from "../src/base/types.ts";

// The split exists because ONE number misdirected: measured on a real run, 225 not-opened obligations
// ranked by unread lines put three noise-dominated files in the top five, so the funnel would have spent
// the next slice on a service unrelated to the feature. These tests pin that the split reports rather than
// judges — nothing leaves the denominator, and the partition nobody could place stays loud.

function obligation(overrides: Partial<ReadObligation> & { name: string }): ReadObligation {
  return {
    id: `o:${overrides.name}`,
    kind: "boundary-decision-function",
    featureKey: "k",
    path: "svc/x.go",
    startLine: 10,
    endLine: 40,
    lines: 31,
    tier: 2,
    gated: false,
    ...overrides,
  };
}

const NOTHING_OPENED: EvidenceItem[] = [];

test("the four partitions sum to notOpened — the split reports, it never drops", () => {
  const obligations = [
    obligation({ name: "a", kind: "decision-function", tier: 1 }),
    obligation({ name: "b", anchorHit: "name" }),
    obligation({ name: "c", anchorHit: "path" }),
    obligation({ name: "d" }),
    obligation({ name: "e" }),
  ];
  const report = reconcileReadCoverage({ obligations, evidence: NOTHING_OPENED, annotated: true });
  const counts = report.summary.notOpenedByAttribution;
  assert.deepEqual(counts, { retained: 1, anchorName: 1, anchorPath: 1, unclassified: 2 });
  assert.equal((counts?.retained ?? 0) + (counts?.anchorName ?? 0) + (counts?.anchorPath ?? 0) + (counts?.unclassified ?? 0), report.summary.notOpened);
  assert.equal(report.summary.counted, 5, "every obligation is still counted");
});

test("lines are partitioned the same way, so a reader can rank files by the right number", () => {
  const report = reconcileReadCoverage({
    obligations: [obligation({ name: "a", kind: "decision-function", tier: 1 }), obligation({ name: "b" })],
    evidence: NOTHING_OPENED,
    annotated: true,
  });
  assert.deepEqual(report.summary.notOpenedLinesByAttribution, { retained: 31, anchorName: 0, anchorPath: 0, unclassified: 31 });
});

// A run frozen before the labels existed must read exactly as it did then.
test("a run that was never annotated produces no partition and the original single advisory", () => {
  const obligations = [obligation({ name: "a" }), obligation({ name: "b" })];
  const report = reconcileReadCoverage({ obligations, evidence: NOTHING_OPENED });
  assert.equal(report.summary.notOpenedByAttribution, undefined, "absent, not an all-zero block");
  assert.equal(report.summary.notOpenedLinesByAttribution, undefined);

  const findings = auditReadAccountability({ obligations, workItems: [], evidenceById: new Map(), report });
  const residual = findings.filter((finding) => /read residual \(advisory/.test(finding.message));
  assert.equal(residual.length, 1, "one line, the wording it always had");
  assert.doesNotMatch(residual[0].message, /feature-associated|unclassified/);
});

test("labelled obligations split the advisory in two, and neither line reads as a verdict", () => {
  const obligations = [
    obligation({ name: "a", kind: "decision-function", tier: 1 }),
    obligation({ name: "b", anchorHit: "path" }),
    obligation({ name: "c" }),
  ];
  const report = reconcileReadCoverage({ obligations, evidence: NOTHING_OPENED, annotated: true });
  const findings = auditReadAccountability({ obligations, workItems: [], evidenceById: new Map(), report });
  const associated = findings.find((finding) => /feature-associated/.test(finding.message));
  const unclassified = findings.find((finding) => /advisory, unclassified/.test(finding.message));

  assert.ok(associated, "the partition to steer by is reported first");
  assert.match(associated.message, /2 of 3 counted read obligations were never opened/);
  assert.match(associated.message, /retained 1, named 0, in-directory 1/);

  assert.ok(unclassified, "and what the labelling could not place stays loud");
  assert.match(unclassified.message, /a further 1 obligations/);
  assert.match(unclassified.message, /a meaningful share of it WAS real misses/, "it must not invite dismissal");
  assert.doesNotMatch(unclassified.message, /\d+%|a quarter|a third|half of/, "no fraction: one target's number would be printed with authority on every other target");
  assert.equal(unclassified.level, "warning");
});

test("no unclassified obligations means no second line — an empty advisory trains people to ignore advisories", () => {
  const report = reconcileReadCoverage({
    obligations: [obligation({ name: "a", anchorHit: "name" })],
    evidence: NOTHING_OPENED,
  });
  const findings = auditReadAccountability({ obligations: [obligation({ name: "a", anchorHit: "name" })], workItems: [], evidenceById: new Map(), report });
  assert.equal(findings.filter((finding) => /advisory, unclassified/.test(finding.message)).length, 0);
});

test("an opened obligation leaves every partition, because partitions describe what was NOT opened", () => {
  const opened: EvidenceItem[] = [
    { id: "S-1", snapshotId: "s", kind: "source", title: "t", path: "svc/x.go", startLine: 1, endLine: 100, content: "x", reason: "r", digest: "d" },
  ];
  const report = reconcileReadCoverage({ obligations: [obligation({ name: "a", anchorHit: "name" })], evidence: opened, annotated: true });
  assert.equal(report.summary.notOpened, 0);
  assert.deepEqual(report.summary.notOpenedByAttribution, { retained: 0, anchorName: 0, anchorPath: 0, unclassified: 0 });
});

// "annotated and nothing matched" is a finding about the vocabulary, not a reason to fall back silently.
test("annotation that matched nothing still reports partitions — silence would hide a bad vocabulary", () => {
  const obligations = [obligation({ name: "a" }), obligation({ name: "b" })];
  const report = reconcileReadCoverage({ obligations, evidence: NOTHING_OPENED, annotated: true });
  assert.deepEqual(report.summary.notOpenedByAttribution, { retained: 0, anchorName: 0, anchorPath: 0, unclassified: 2 });
});
