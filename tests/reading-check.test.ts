import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { buildAuthoringPacket } from "../src/report/authoring-packet.ts";
import { freezeRun, prepareRun, readingCheck } from "../src/run/run.ts";
import { readTimeline } from "../src/base/timeline.ts";
import type { DocumentPlan, EvidenceItem, InvestigationPlan, ReportRequest, RunManifest, TraceCatalog } from "../src/base/types.ts";
import type { ReadObligation } from "../src/obligation/read-obligations.ts";
import type { ReadCoverageItem } from "../src/investigation/read-coverage.ts";
import { COVERAGE_STATEMENT_PREFIXES } from "../src/investigation/coverage-statement.ts";
import { copyFixture, createCodeGraphSchema, disposeAllWorkItems, tempDir } from "./helpers.ts";

// Wiring for the reading check. The rendering is unit-tested in read-residual-exposure.test.ts; what has to
// hold here is that the check and the gate it precedes read ONE denominator, that the check stays read-only
// (it is meant to be run freely, including on a frozen run, without paying a supplement), and that it
// leaves the trace which makes its own effect measurable inside a single run.

const BUDGETS = { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

/**
 * A run that actually leaves something unread. The shared fixture cannot produce one: its nodes are all
 * single-line, so every obligation is excluded `declaration-only` and the counted denominator is empty —
 * against which every assertion about partitions holds vacuously, whatever the code does.
 *
 * The residual is produced the way real ones are, not by contrivance: `maxSourceWindows` runs out, so
 * prepare cannot open a window over every retained node. `computeOvertimeCap` additionally arrives through
 * the boundary-file second source and carries none of the feature's vocabulary, so one obligation lands in
 * the unclassified partition and both halves of the split are exercised end to end.
 */
function createResidualGraphFixture(path: string): void {
  const db = createCodeGraphSchema(path);
  const insertFile = db.prepare("INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  insertFile.run("src/server.ts", "hash", "typescript", 300, Date.now(), Date.now(), 5, "[]");
  insertFile.run("src/rules.ts", "hash2", "typescript", 4000, Date.now(), Date.now(), 177, "[]");
  const node = db.prepare("INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const fn = (id: string, name: string, file: string, start: number, end: number): void => {
    node.run(id, "function", name, name, file, "typescript", start, end, 1, 40, null, `function ${name}`, "public", 0, 0, 0, 0, "[]", "[]", null, Date.now());
  };
  node.run("route-1", "route", "GET /leave", "GET /leave", "src/server.ts", "typescript", 4, 4, 1, 50, null, "app.get('/leave', listLeave)", "public", 0, 0, 0, 0, "[]", "[]", null, Date.now());
  fn("fn-2", "listLeave", "src/server.ts", 3, 3);
  fn("fn-3", "approveLeaveConsent", "src/rules.ts", 162, 170);
  fn("fn-4", "cancelLeaveAuthorization", "src/rules.ts", 172, 177);
  fn("fn-5", "settleLeaveBalance", "src/rules.ts", 80, 88);
  fn("fn-6", "computeOvertimeCap", "src/rules.ts", 42, 48);
  const edge = db.prepare("INSERT INTO edges (source,target,kind,metadata,line,col) VALUES (?,?,?,?,?,?)");
  edge.run("route-1", "fn-2", "references", JSON.stringify({ confidence: 0.9, refName: "listLeave" }), 4, 20);
  edge.run("fn-2", "fn-3", "calls", JSON.stringify({ confidence: 0.9, refName: "approveLeaveConsent" }), 3, 30);
  edge.run("fn-2", "fn-4", "calls", JSON.stringify({ confidence: 0.9, refName: "cancelLeaveAuthorization" }), 3, 45);
  db.close();
}

async function featureRequest(): Promise<ReportRequest> {
  const target = await copyFixture("residual-target");
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createResidualGraphFixture(codegraph);
  return { target, codegraph, workdir, language: "zh-CN", detailLevel: "standard", overviewAudiences: [], features: [{ subject: "Leave management", aliases: ["leave", "holiday"], audiences: ["product"] }], budgets: { ...BUDGETS, maxSourceWindows: 2 } };
}

/** These fixtures deliberately exercise the archived pre-L7 residual reader. V14 executes every authorized
 * span and blocks a pending declaration, so keeping that separate is what makes these tests about readingCheck
 * rather than about the new execution gate. */
async function prepareLegacyReadingRun(): Promise<{ runDir: string }> {
  const prepared = await prepareRun(await featureRequest());
  const path = join(prepared.runDir, "run.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as RunManifest;
  manifest.assuranceVersion = "assurance-v13-reading-check-fixture";
  await writeFile(path, JSON.stringify(manifest, null, 2));
  return { runDir: prepared.runDir };
}

// The failure this forbids: two commands deriving a denominator separately, so one run could show two
// different readings and the check would be advising against numbers the gate does not use.
test("the pre-freeze check and freeze reconcile the same denominator", async () => {
  const { runDir } = await prepareLegacyReadingRun();
  await disposeAllWorkItems(runDir);

  const before = await readingCheck(runDir);
  assert.equal(before.frozen, false);
  assert.match(before.report, /not frozen: opening a window is still ordinary investigation/);
  // Guard against the vacuous version of this test: on a fixture with nothing unread, every equality below
  // holds no matter what the code does.
  assert.equal(before.exposure?.annotated, true);
  assert.deepEqual(before.exposure?.totals, { functions: 3, files: 1, unreadLines: 24, retained: 3, named: 0, inDirectory: 0 });
  assert.equal(before.exposure?.unclassified.count, 1, "and both sides of the split are exercised, not just the one being advertised");

  assert.equal((await freezeRun(runDir)).frozen, true);
  const frozenResidual = JSON.parse(await readFile(join(runDir, "coverage", "read-residual.json"), "utf8")) as { summary: { counted: number; notOpened: number } };
  const after = await readingCheck(runDir);

  assert.equal(after.frozen, true);
  assert.match(after.report, /frozen: the denominator below is the frozen one/);
  assert.deepEqual(after.exposure?.totals, before.exposure?.totals, "freezing changes nothing about what was never opened");
  const counted = (before.exposure?.totals.functions ?? 0) + (before.exposure?.unclassified.count ?? 0);
  assert.equal(counted, frozenResidual.summary.notOpened, "the check's two partitions sum to the residual freeze recorded");
});

// "Reads the frozen denominator" and "re-derives it and happens to agree" are indistinguishable while the
// inputs still exist. Removing the second source's input separates them: a frozen read is unaffected, a
// live re-derivation silently loses the obligation that source contributed.
test("after freeze the check reports the frozen denominator, not a fresh derivation", async () => {
  const { runDir } = await prepareLegacyReadingRun();
  await disposeAllWorkItems(runDir);
  assert.equal((await freezeRun(runDir)).frozen, true);
  const frozen = await readingCheck(runDir);

  await rm(join(runDir, "context", "boundary-functions.json"));
  const afterRemoval = await readingCheck(runDir);

  assert.equal(afterRemoval.exposure?.unclassified.count, frozen.exposure?.unclassified.count,
    "the obligation the boundary source contributed is still counted, because the denominator was frozen");
  assert.deepEqual(afterRemoval.exposure?.totals, frozen.exposure?.totals);
});

// Refusing to answer is a real outcome and has to be honest about WHICH refusal it is: a run that never had
// a denominator and a run whose frozen denominator is gone both decline to re-derive, but only one of them
// is old. Both must also leave the run untouched — there is nothing to record.
test("a run with no denominator is told why, and nothing is written", async () => {
  const { runDir } = await prepareLegacyReadingRun();
  await disposeAllWorkItems(runDir);
  assert.equal((await freezeRun(runDir)).frozen, true);
  await rm(join(runDir, "coverage", "read-obligations.json"));
  const timelineBefore = await readFile(join(runDir, "timeline.jsonl"), "utf8");
  const manifestBefore = await readFile(join(runDir, "run.json"), "utf8");

  const lost = await readingCheck(runDir);
  assert.equal(lost.exposure, null);
  // 57B-449: an absent denominator is `ledger-absent`, never the covered wording and never `ledger-empty` —
  // "nobody can tell" and "the run genuinely recorded none" are two facts, and only one of them is final.
  assert.ok(lost.report.includes(`${COVERAGE_STATEMENT_PREFIXES.vacuous}ledger-absent)`), lost.report);
  assert.ok(!lost.report.includes(COVERAGE_STATEMENT_PREFIXES.complete), "an absent denominator may never read as covered");
  assert.ok(!lost.report.includes("ledger-empty"), "a lost ledger is not an empty one");
  assert.match(lost.report, /the frozen denominator is missing from this run/);
  assert.doesNotMatch(lost.report, /prepared before reading accountability/, "a lost artifact must not be reported as an old run");
  assert.equal(await readFile(join(runDir, "timeline.jsonl"), "utf8"), timelineBefore, "nothing to report means nothing to record");
  assert.equal(await readFile(join(runDir, "run.json"), "utf8"), manifestBefore);

  // The other refusal: a run prepared before reading accountability existed at all.
  const manifest = JSON.parse(manifestBefore) as RunManifest & { assuranceVersion?: string };
  manifest.assuranceVersion = "assurance-v2";
  await writeFile(join(runDir, "run.json"), JSON.stringify(manifest, null, 2));
  const old = await readingCheck(runDir);
  assert.match(old.report, /prepared before reading accountability existed/);
  assert.ok(old.report.includes(`${COVERAGE_STATEMENT_PREFIXES.vacuous}ledger-absent)`), old.report);
  assert.notEqual(old.report, lost.report, "the two absences keep their own reason clause");
  assert.equal(await readFile(join(runDir, "timeline.jsonl"), "utf8"), timelineBefore);
});

// The end-to-end leg: without it, the packet renderer can be perfect while freeze never hands it anything.
test("freeze writes the block into the packet on disk", async () => {
  const { runDir } = await prepareLegacyReadingRun();
  await disposeAllWorkItems(runDir);
  assert.equal((await freezeRun(runDir)).frozen, true);
  const manifest = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as RunManifest;
  const packet = await readFile(join(runDir, "context", "authoring", `${manifest.documents[0].id}.md`), "utf8");
  assert.match(packet, /## Reading boundary — feature-associated decision code never opened/);
  assert.match(packet, /3 functions across 1 file, 24 unread lines — retained 3, named 0, in-directory 0\./);
  assert.match(packet, /`settleLeaveBalance`/);
  const readingBoundary = packet.slice(packet.indexOf("## Reading boundary"));
  assert.doesNotMatch(readingBoundary, /computeOvertimeCap/, "the read residual counts the unclassified partition but does not expand it; layer-6 obligations may name it elsewhere");
  assert.match(packet, /A further 1 never-opened function \(7 line\(s\)\)/);
});

test("the check is read-only: it opens no window and needs no supplement after freeze", async () => {
  const { runDir } = await prepareLegacyReadingRun();
  await disposeAllWorkItems(runDir);
  assert.equal((await freezeRun(runDir)).frozen, true);
  const evidenceBefore = await readFile(join(runDir, "evidence.json"), "utf8");
  const knowledgeBefore = await readFile(join(runDir, "knowledge.json"), "utf8");

  await readingCheck(runDir);

  assert.equal(await readFile(join(runDir, "evidence.json"), "utf8"), evidenceBefore, "no window was opened");
  assert.equal(await readFile(join(runDir, "knowledge.json"), "utf8"), knowledgeBefore, "the frozen record is untouched, so no supplement is owed");
  const manifest = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as RunManifest;
  assert.equal(manifest.metrics.supplements ?? 0, 0);
});

// Without this event the only way to ask "did exposure change a reading choice" is to compare runs, where
// the answer is dominated by run-to-run variance. With it, the before/after lives inside one run.
test("the check leaves a timeline trace naming what it pointed at", async () => {
  const { runDir } = await prepareLegacyReadingRun();
  await disposeAllWorkItems(runDir);
  const result = await readingCheck(runDir);

  const events = await readTimeline(runDir);
  const check = events.filter((event) => event.action === "investigation.read-check");
  assert.equal(check.length, 1);
  const data = check[0].data as { frozen: boolean; functions: number; files: number; paths: string[] };
  assert.equal(data.frozen, false);
  assert.equal(data.functions, result.exposure?.totals.functions);
  assert.equal(data.files, result.exposure?.totals.files);
  assert.deepEqual(data.paths, result.exposure?.files.slice(0, 50).map((file) => file.path), "the file list is the join key a later window is checked against");

  await freezeRun(runDir);
  const frozenEvents = await readTimeline(runDir);
  const frozenIndex = frozenEvents.findIndex((event) => event.action === "investigation.frozen");
  const checkIndex = frozenEvents.findIndex((event) => event.action === "investigation.read-check");
  assert.ok(checkIndex >= 0 && checkIndex < frozenIndex, "a check run before freeze is recorded before it, which is what makes the ordering readable");
});

// --- the packet side ---

const OBLIGATION: ReadObligation = {
  id: "o1", kind: "decision-function", featureKey: "k", name: "approveLeave",
  path: "svc/leave/service.go", startLine: 10, endLine: 60, lines: 51, tier: 1, gated: false,
};

const ITEM: ReadCoverageItem = {
  id: "o1", name: "approveLeave", path: "svc/leave/service.go", startLine: 10, endLine: 60, tier: 1, gated: false,
  status: "not-opened", openedWindows: [], openedLines: 0, uncovered: [{ start: 10, end: 60 }], uncoveredLines: 51, consumedBy: [],
};

const PLAN: InvestigationPlan = {
  version: 1, runId: "r", items: [{
    id: "feature:k:decision-flow", dimension: "decision-flow", scope: "feature:k", hypothesis: "h", status: "found",
    material: true, requiredFor: ["feature-k-engineering", "feature-k-product", "overview-engineering"], evidenceIds: [], traceIds: [],
    reportSection: 3, origin: "default",
  }],
} as unknown as InvestigationPlan;

const TRACES: TraceCatalog = { version: 1, traces: [] } as unknown as TraceCatalog;

function document(overrides: Partial<DocumentPlan> = {}): DocumentPlan {
  return {
    id: "feature-k-engineering", kind: "feature", audience: "engineering", subject: "Leave",
    templatePath: "/tmp/t.md", contextPath: "/tmp/c.md",
    sections: [{ index: 3, title: "Business rules", file: "/tmp/3.md", claimsFile: "/tmp/3.claims.json", complete: false }],
    ...overrides,
  } as DocumentPlan;
}

const EVIDENCE = new Map<string, EvidenceItem>();
const READING = { obligations: [OBLIGATION], items: [ITEM], annotated: true };

test("a packet built without the reading input is byte-identical to before", () => {
  const withoutArgument = buildAuthoringPacket(document(), PLAN, EVIDENCE, TRACES, {});
  const withUndefined = buildAuthoringPacket(document(), PLAN, EVIDENCE, TRACES, {}, undefined, undefined);
  assert.equal(withUndefined, withoutArgument);
  assert.doesNotMatch(withoutArgument, /Reading boundary/);
});

test("the block lands last, after everything the packet knows", () => {
  const packet = buildAuthoringPacket(document(), PLAN, EVIDENCE, TRACES, {}, undefined, READING);
  assert.match(packet, /## Reading boundary/);
  assert.ok(packet.trimEnd().endsWith("(retained)"), "known unknowns come after what is known");
});

test("both audiences of a feature get the block; an overview gets none", () => {
  assert.match(buildAuthoringPacket(document({ id: "feature-k-product", audience: "product" }), PLAN, EVIDENCE, TRACES, {}, undefined, READING), /## Reading boundary/);
  const overview = buildAuthoringPacket(
    document({ id: "overview-engineering", kind: "overview", subject: undefined, sections: [{ index: 1, title: "Overview", file: "/tmp/1.md", claimsFile: "/tmp/1.claims.json", complete: false }] }),
    PLAN, EVIDENCE, TRACES, {}, undefined, READING,
  );
  assert.doesNotMatch(overview, /Reading boundary/, "an overview has no feature key to scope a feature-scoped partition to");
});

test("a document only ever sees its own feature's residual", () => {
  const other: ReadObligation = { ...OBLIGATION, id: "o2", featureKey: "billing", name: "chargeCard", path: "svc/billing/charge.go" };
  const otherItem: ReadCoverageItem = { ...ITEM, id: "o2", name: "chargeCard", path: "svc/billing/charge.go" };
  const packet = buildAuthoringPacket(document(), PLAN, EVIDENCE, TRACES, {}, undefined, { obligations: [OBLIGATION, other], items: [ITEM, otherItem], annotated: true });
  assert.match(packet, /approveLeave/);
  assert.doesNotMatch(packet, /chargeCard/);
});
