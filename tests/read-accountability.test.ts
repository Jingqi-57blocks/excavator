import test from "node:test";
import assert from "node:assert/strict";
import { readObligations, READ_OBLIGATIONS_VERSION, normalizeObligationPath, type ReadObligation } from "../src/obligation/read-obligations.ts";
import { auditReadAccountability, citesOverlappingWindow, reconcileReadCoverage } from "../src/investigation/read-coverage.ts";
import { LOGIC_WORKITEM_DIMENSION } from "../src/obligation/logic-workitems.ts";
import type { EvidenceItem, FactPackItem, FeatureFactPack, InvestigationWorkItem } from "../src/base/types.ts";
import { v2Item, v2Pack } from "./factpack-v2-fixture.ts";

const KEY = "leave-abc123";
const SERVICE = "svc/internal/handlers/leave/service.go";

function logic(name: string, line: number, endLine?: number, extra: Partial<FactPackItem> = {}): FactPackItem {
  return v2Item({ category: "logic", name, filePath: SERVICE, line, ...(endLine !== undefined ? { endLine } : {}), source: "graph", ...extra });
}

/** A pack mirroring the real WCP leave shape: single-line declarations, a nested span, two real functions. */
function pack(items: FactPackItem[] = [
  logic("Approve", 30, 30),                       // interface method signature — declaration-only
  logic("leaveService", 46, 46),                   // struct declaration — declaration-only
  logic("Approve", 362, 739),                      // the real function (holds the thresholds)
  logic("innerHelper", 400, 420),                  // nested inside Approve — contained
  logic("Reject", 810, 922, { signal: "branch-heavy" }), // rescued → tier 0
  logic("spanless", 1000),                         // no endLine → cannot-determine
]): FeatureFactPack {
  return v2Pack(items, { snapshotId: "snap1", featureKey: KEY });
}

function workItem(name: string, line: number, overrides: Partial<InvestigationWorkItem> = {}): InvestigationWorkItem {
  return {
    id: `feature:${KEY}:logic:${name}@${SERVICE}:${line}`,
    dimension: LOGIC_WORKITEM_DIMENSION,
    scope: `feature:${KEY}`,
    hypothesis: "h",
    status: "found",
    material: true,
    requiredFor: [`feature-${KEY}-engineering`],
    evidenceIds: [],
    traceIds: [],
    reportSection: undefined,
    origin: "default",
    ...overrides,
  };
}

function window(id: string, startLine: number, endLine: number, path = SERVICE): EvidenceItem {
  return { id, snapshotId: "snap1", kind: "source", title: id, path, startLine, endLine, reason: "r", digest: "d" };
}

test("obligations curate declaration-only and contained spans, keeping them visible", () => {
  const artifact = readObligations([pack()]);
  assert.equal(artifact.version, READ_OBLIGATIONS_VERSION);
  const byName = (name: string, line: number): ReadObligation =>
    artifact.obligations.find((o) => o.name === name && o.startLine === line)!;

  // Nothing is dropped — every logic item is present, excluded ones carry a reason.
  assert.equal(artifact.obligations.length, 6);
  assert.equal(byName("Approve", 30).excluded, "declaration-only");
  assert.equal(byName("leaveService", 46).excluded, "declaration-only");
  assert.equal(byName("innerHelper", 400).excluded, "contained");
  assert.equal(byName("Approve", 362).excluded, undefined);
  assert.equal(byName("Reject", 810).excluded, undefined);

  assert.equal(artifact.summary.total, 6);
  assert.equal(artifact.summary.counted, 3); // Approve(362), Reject(810), spanless(1000)
  assert.equal(artifact.summary.excludedDeclarationOnly, 2);
  assert.equal(artifact.summary.excludedContained, 1);
  assert.equal(artifact.summary.noSpan, 1);
  assert.equal(artifact.summary.lines, 378 + 113); // the span-less item contributes no lines
});

test("tier marks a structurally rescued item, and gated marks hard-gate reach only", () => {
  // Only `Reject` is promoted to a work item; `Approve` is in the denominator but OUTSIDE the gate —
  // the real WCP case, where the thresholds live in a non-rescued function.
  const artifact = readObligations([pack()], [workItem("Reject", 810)]);
  const approve = artifact.obligations.find((o) => o.name === "Approve" && o.startLine === 362)!;
  const reject = artifact.obligations.find((o) => o.name === "Reject")!;
  assert.equal(reject.tier, 0);
  assert.equal(reject.gated, true);
  assert.equal(reject.workItemId, reject.id);
  assert.equal(approve.tier, 1);
  assert.equal(approve.gated, false, "a non-promoted decision function is visible but not gated");
  assert.equal(artifact.summary.gated, 1);
});

test("reconciliation reports covered, partial with exact uncovered ranges, and not-opened", () => {
  const artifact = readObligations([pack()], [workItem("Reject", 810)]);
  const report = reconcileReadCoverage({
    obligations: artifact.obligations,
    evidence: [window("S-1", 505, 612), window("S-2", 810, 922)],
  });
  // Excluded obligations never enter the report.
  assert.equal(report.items.length, 3);

  const approve = report.items.find((item) => item.name === "Approve")!;
  assert.equal(approve.status, "partial");
  assert.equal(approve.openedLines, 108);
  assert.deepEqual(approve.uncovered, [{ start: 362, end: 504 }, { start: 613, end: 739 }]);
  assert.equal(approve.uncoveredLines, 270);
  assert.deepEqual(approve.openedWindows, ["S-1"]);

  const reject = report.items.find((item) => item.name === "Reject")!;
  assert.equal(reject.status, "covered");
  assert.equal(reject.uncoveredLines, 0);

  const spanless = report.items.find((item) => item.name === "spanless")!;
  assert.equal(spanless.status, "cannot-determine", "an obligation with no end line is never counted as covered");

  assert.equal(report.summary.covered, 1);
  assert.equal(report.summary.partial, 1);
  assert.equal(report.summary.cannotDetermine, 1);
  assert.equal(report.summary.notOpened, 0);
});

test("a never-opened obligation reports its whole span as the residual", () => {
  const artifact = readObligations([pack()]);
  const report = reconcileReadCoverage({ obligations: artifact.obligations, evidence: [] });
  const approve = report.items.find((item) => item.name === "Approve")!;
  assert.equal(approve.status, "not-opened");
  assert.deepEqual(approve.uncovered, [{ start: 362, end: 739 }]);
  assert.equal(approve.uncoveredLines, 378);
  assert.equal(report.summary.notOpened, 2); // Approve + Reject
});

test("overlapping windows merge instead of double-counting covered lines", () => {
  const artifact = readObligations([pack()]);
  const report = reconcileReadCoverage({
    obligations: artifact.obligations,
    // Two overlapping windows plus one adjacent: 362-500 and 480-600 merge, 601-739 closes the span.
    evidence: [window("S-a", 362, 500), window("S-b", 480, 600), window("S-c", 601, 739)],
  });
  const approve = report.items.find((item) => item.name === "Approve")!;
  assert.equal(approve.status, "covered");
  assert.equal(approve.openedLines, 378, "merged cover equals the span, never more");
  assert.deepEqual(approve.uncovered, []);
});

test("a window on a different file never covers the obligation", () => {
  const artifact = readObligations([pack()]);
  const report = reconcileReadCoverage({
    obligations: artifact.obligations,
    evidence: [window("S-x", 362, 739, "svc/internal/handlers/other/service.go")],
  });
  assert.equal(report.items.find((item) => item.name === "Approve")!.status, "not-opened");
});

test("path identity normalizes separators and a leading ./ on both sides", () => {
  assert.equal(normalizeObligationPath("./a\\b/c.go"), "a/b/c.go");
  const artifact = readObligations([{ ...pack([logic("Fn", 10, 20)]), items: [{ ...logic("Fn", 10, 20), filePath: "./svc\\x.go" }] }]);
  const report = reconcileReadCoverage({
    obligations: artifact.obligations,
    evidence: [window("S-1", 10, 20, "svc/x.go")],
  });
  assert.equal(report.items[0].status, "covered", "an obligation and a window naming the same file must agree");
});

test("consumption is reported separately from reading (the opened-not-consumed signal)", () => {
  const artifact = readObligations([pack()], [workItem("Reject", 810)]);
  const evidence = [window("S-1", 505, 612), window("S-2", 810, 922)];
  const driveBy = reconcileReadCoverage({ obligations: artifact.obligations, evidence });
  assert.equal(driveBy.summary.openedNotConsumed, 2, "opened windows with no citing claim are counted");

  const consumed = reconcileReadCoverage({
    obligations: artifact.obligations,
    evidence,
    claims: [{ ref: "doc#claim-1", evidenceIds: ["S-1"] }],
  });
  const approve = consumed.items.find((item) => item.name === "Approve")!;
  assert.deepEqual(approve.consumedBy, ["doc#claim-1"]);
  assert.equal(consumed.summary.openedNotConsumed, 1, "only the still-uncited obligation remains");
});

test("citesOverlappingWindow is the hard-gate predicate: overlap passes, non-overlap fails", () => {
  const artifact = readObligations([pack()]);
  const approve = artifact.obligations.find((o) => o.name === "Approve" && o.startLine === 362)!;
  const spanless = artifact.obligations.find((o) => o.name === "spanless")!;
  const evidenceById = new Map([
    ["S-in", window("S-in", 505, 612)],
    ["S-out", window("S-out", 1, 70)],
    ["S-other", window("S-other", 362, 739, "svc/other.go")],
    ["S-graph", { ...window("S-g", 362, 739), id: "S-graph", kind: "graph" } as EvidenceItem],
  ]);
  assert.equal(citesOverlappingWindow(approve, ["S-in"], evidenceById), true);
  assert.equal(citesOverlappingWindow(approve, ["S-out"], evidenceById), false, "a window elsewhere in the file does not touch the function");
  assert.equal(citesOverlappingWindow(approve, ["S-other"], evidenceById), false, "same lines in another file never count");
  assert.equal(citesOverlappingWindow(approve, ["S-graph"], evidenceById), false, "only source windows count");
  assert.equal(citesOverlappingWindow(approve, [], evidenceById), false);
  assert.equal(citesOverlappingWindow(spanless, [], evidenceById), true, "an unjudgeable obligation never fails the gate");
});

test("hard gate errors on a found disposition whose citations miss the function", () => {
  const item = workItem("Reject", 810, { evidenceIds: ["S-out"] });
  const artifact = readObligations([pack()], [item]);
  const evidence = [window("S-out", 1, 70)];
  const report = reconcileReadCoverage({ obligations: artifact.obligations, evidence });
  const findings = auditReadAccountability({
    obligations: artifact.obligations,
    workItems: [item],
    evidenceById: new Map(evidence.map((e) => [e.id, e])),
    report,
  });
  const errors = findings.filter((finding) => finding.level === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /disposed found/);
  assert.match(errors[0].message, /810-922/);
  assert.equal(errors[0].document, "read-coverage");
});

test("hard gate passes once an overlapping window is cited, and skips items it must not judge", () => {
  const cited = workItem("Reject", 810, { evidenceIds: ["S-in"] });
  const pending = workItem("Reject", 810, { evidenceIds: [], status: "pending" });
  const immaterial = workItem("Reject", 810, { evidenceIds: [], material: false });
  const otherDimension = workItem("Reject", 810, { evidenceIds: [], dimension: "decision-flow" });
  const evidence = [window("S-in", 850, 900)];
  const evidenceById = new Map(evidence.map((e) => [e.id, e]));
  for (const item of [cited, pending, immaterial, otherDimension]) {
    const artifact = readObligations([pack()], [item]);
    const report = reconcileReadCoverage({ obligations: artifact.obligations, evidence });
    const errors = auditReadAccountability({ obligations: artifact.obligations, workItems: [item], evidenceById, report })
      .filter((finding) => finding.level === "error");
    assert.deepEqual(errors, [], `no error expected for ${item.status}/${item.dimension}/material=${item.material}`);
  }
});

test("residual advisories name the unread ranges and stay warnings", () => {
  const item = workItem("Reject", 810, { evidenceIds: ["S-in"] });
  const artifact = readObligations([pack()], [item]);
  const evidence = [window("S-in", 810, 850)];
  const report = reconcileReadCoverage({ obligations: artifact.obligations, evidence });
  const findings = auditReadAccountability({
    obligations: artifact.obligations,
    workItems: [item],
    evidenceById: new Map(evidence.map((e) => [e.id, e])),
    report,
  });
  assert.deepEqual(findings.filter((f) => f.level === "error"), [], "the residual never blocks in this generation");
  const warnings = findings.filter((finding) => finding.level === "warning").map((finding) => finding.message);
  assert.ok(warnings.some((message) => /promoted decision function Reject/.test(message) && /851-922/.test(message)));
  assert.ok(warnings.some((message) => /never opened/.test(message)), "ungated residual is one aggregate line");
  assert.ok(warnings.some((message) => /never means "nothing was missed"/.test(message)), "the honest boundary is stated");
});

test("the consumption advisory is suppressed until claims exist, then fires", () => {
  const item = workItem("Reject", 810, { evidenceIds: ["S-in"] });
  const artifact = readObligations([pack()], [item]);
  const evidence = [window("S-in", 810, 922)];
  const evidenceById = new Map(evidence.map((e) => [e.id, e]));
  const consumptionMessages = (claims?: Array<{ ref: string; evidenceIds: string[] }>): string[] => {
    const report = reconcileReadCoverage({ obligations: artifact.obligations, evidence, ...(claims ? { claims } : {}) });
    return auditReadAccountability({ obligations: artifact.obligations, workItems: [item], evidenceById, report })
      .filter((finding) => /no claim cites it/.test(finding.message))
      .map((finding) => finding.message);
  };
  // At freeze no claim can exist, so "opened but uncited" is trivially true for everything — reporting it
  // there would be an advisory that always fires, which is how authors learn to ignore advisories.
  assert.deepEqual(consumptionMessages(undefined), []);
  assert.equal(consumptionMessages([]).length, 1, "once claims are evaluated, an uncited opened window is reported");
});

test("a contained obligation that is promoted is still held to the hard gate", () => {
  // `innerHelper` is nested inside Approve, so it is excluded from the counted denominator — but its span is
  // judgeable, so a `found` disposition citing a window elsewhere must still fail.
  const item = workItem("innerHelper", 400, { evidenceIds: ["S-out"] });
  const artifact = readObligations([pack()], [item]);
  assert.equal(artifact.obligations.find((o) => o.name === "innerHelper")?.excluded, "contained");
  const evidence = [window("S-out", 1, 70)];
  const report = reconcileReadCoverage({ obligations: artifact.obligations, evidence });
  const errors = auditReadAccountability({
    obligations: artifact.obligations,
    workItems: [item],
    evidenceById: new Map(evidence.map((e) => [e.id, e])),
    report,
  }).filter((finding) => finding.level === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /400-420/);
});

test("obligations and reconciliation are byte-stable across derivations", () => {
  const items = pack().items;
  const shuffled = [...items].reverse();
  const a = readObligations([{ ...pack(), items }], [workItem("Reject", 810)]);
  const b = readObligations([{ ...pack(), items: shuffled }], [workItem("Reject", 810)]);
  assert.equal(JSON.stringify(a), JSON.stringify(b), "input order never changes the frozen denominator");
  const evidence = [window("S-1", 505, 612)];
  assert.equal(
    JSON.stringify(reconcileReadCoverage({ obligations: a.obligations, evidence })),
    JSON.stringify(reconcileReadCoverage({ obligations: b.obligations, evidence })),
  );
});
