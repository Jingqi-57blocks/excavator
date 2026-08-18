import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import type { EvidenceItem, ReportRequest, RunManifest, SectionClaim, TimelineEvent } from "../src/base/types.ts";
import { assembleRun, auditRun, beginDocument, checkpointSection, freezeRun, prepareRun, resumeRun, runStatus } from "../src/run/run.ts";
import { collectDrafts, draftSection } from "../src/report/parallel-authoring.ts";
import { auditTimeline, readTimeline } from "../src/base/timeline.ts";
import { exists } from "../src/base/util.ts";
import { copyFixture, createCodeGraphFixture, disposeAllWorkItems, tempDir } from "./helpers.ts";

// 57B-367 parallel section authoring — "write in parallel, account serially". These tests validate the
// two-command split: `draft` is provably isolated from the shared ledger (so any number run concurrently),
// and `collect` is the single-writer barrier whose serial appends produce a timeline that passes the same
// hash-chain audit a serial run would. Concurrency here is in-process Promise.all; for the disjoint
// per-(document, section) atomicWrite paths `draft` uses (no shared fd or in-memory state), that is
// equivalent to multi-process — the safety argument is that the write sets do not intersect, not that a
// race test happened to pass. Real multi-process form is covered by the workspace smoke and the demo.

const BUDGETS = { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

async function overviewRequest(overrides: Partial<typeof BUDGETS> = {}): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return { target, codegraph, workdir, language: "zh-CN", detailLevel: "standard", overviewAudiences: ["product"], features: [], budgets: { ...BUDGETS, ...overrides } };
}

async function twoDocRequest(): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return { target, codegraph, workdir, language: "zh-CN", detailLevel: "standard", overviewAudiences: ["product", "engineering"], features: [], budgets: BUDGETS };
}

function sectionText(title: string, index: number, evidenceId: string): string {
  return `## ${title}\n\n第 ${index} 节记录当前状态。\`事实\`\n\n<details><summary>依据</summary>\n\n- ${evidenceId}\n\n</details>\n`;
}
function sectionClaims(documentId: string, index: number, evidenceId: string): SectionClaim[] {
  return [{ id: `C-${documentId}-${index}`, marker: "fact", statement: `第 ${index} 节记录当前状态。`, evidenceIds: [evidenceId], confidence: "high", status: "verified" }];
}
async function firstEvidence(runDir: string): Promise<string> {
  const catalog = JSON.parse(await readFile(join(runDir, "evidence.json"), "utf8")) as { evidence: EvidenceItem[] };
  return catalog.evidence.find((item) => item.kind === "source")?.id ?? catalog.evidence[0].id;
}
async function readManifest(runDir: string): Promise<RunManifest> {
  return JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as RunManifest;
}
async function frozenRun(request: Awaited<ReturnType<typeof overviewRequest>>): Promise<{ runDir: string; manifest: RunManifest; evidenceId: string }> {
  const { runDir, manifest } = await prepareRun(request);
  const evidenceId = await firstEvidence(runDir);
  await disposeAllWorkItems(runDir);
  assert.equal((await freezeRun(runDir)).frozen, true);
  for (const document of manifest.documents) await beginDocument(runDir, document.id);
  return { runDir, manifest: await readManifest(runDir), evidenceId };
}
async function draftAllConcurrently(runDir: string, manifest: RunManifest, evidenceId: string): Promise<void> {
  await Promise.all(manifest.documents.flatMap((document) =>
    document.sections.map((section) => draftSection(runDir, document.id, section.index, sectionText(section.title, section.index, evidenceId), sectionClaims(document.id, section.index, evidenceId)))
  ));
}
function receiptPath(runDir: string, documentId: string, sectionIndex: number): string {
  return join(runDir, "drafts", documentId, `${String(sectionIndex).padStart(2, "0")}.json`);
}
function sectionEvents(events: TimelineEvent[]): TimelineEvent[] {
  return events.filter((event) => event.action === "section.checkpoint" || event.action === "section.revised");
}

// --- ① draft isolation: the shared ledger is byte-unchanged; the four per-section artifacts land ---

test("draft writes only per-section artifacts and leaves timeline/run/metrics byte-identical", async () => {
  const { runDir, manifest, evidenceId } = await frozenRun(await overviewRequest());
  const document = manifest.documents[0];
  const section = document.sections[0];

  const timelineBefore = await readFile(join(runDir, "timeline.jsonl"));
  const runBefore = await readFile(join(runDir, "run.json"));
  const metricsBefore = await readFile(join(runDir, "metrics.json"));

  const receipt = await draftSection(runDir, document.id, section.index, sectionText(section.title, section.index, evidenceId), sectionClaims(document.id, section.index, evidenceId));

  // The shared ledger the audit hash-chains is untouched — this is the root of the safety argument.
  assert.ok((await readFile(join(runDir, "timeline.jsonl"))).equals(timelineBefore), "draft must not touch timeline.jsonl");
  assert.ok((await readFile(join(runDir, "run.json"))).equals(runBefore), "draft must not touch run.json");
  assert.ok((await readFile(join(runDir, "metrics.json"))).equals(metricsBefore), "draft must not touch metrics.json");

  // The section, claims and receipt land; the manifest still shows the section incomplete (collect owns that).
  assert.ok(await exists(section.file), "section file written");
  assert.ok(await exists(section.claimsFile), "claims file written");
  assert.ok(await exists(receiptPath(runDir, document.id, section.index)), "receipt written");
  assert.equal(receipt.revision, false);
  assert.equal(receipt.hasClaims, true);
  assert.equal((await readManifest(runDir)).documents[0].sections[0].complete, false);

  // A second draft of the same section archives the prior one into history/ and marks the receipt a revision.
  await draftSection(runDir, document.id, section.index, sectionText(section.title, section.index, evidenceId), sectionClaims(document.id, section.index, evidenceId));
  const revisionReceipt = JSON.parse(await readFile(receiptPath(runDir, document.id, section.index), "utf8")) as { revision: boolean };
  assert.equal(revisionReceipt.revision, true);
  assert.ok(await exists(join(runDir, "history", document.id)), "history directory written on revision");
});

test("draft rejects invalid claims, unknown document/section, and an unfrozen current-version run", async () => {
  const { runDir, manifest, evidenceId } = await frozenRun(await overviewRequest());
  const document = manifest.documents[0];
  const title = document.sections[0].title;
  const good = sectionText(title, 1, evidenceId);

  await assert.rejects(() => draftSection(runDir, document.id, 1, good, [{ id: "C1", statement: "", marker: "fact" } as SectionClaim]), /Invalid claim/);
  await assert.rejects(() => draftSection(runDir, "no-such-document", 1, good), /Unknown document/);
  await assert.rejects(() => draftSection(runDir, document.id, 999, good), /Unknown section/);

  // An unfrozen current-version run is refused with begin's exact wording — the freeze gate has no bypass.
  const { runDir: unfrozenDir, manifest: unfrozen } = await prepareRun(await overviewRequest());
  await assert.rejects(() => draftSection(unfrozenDir, unfrozen.documents[0].id, 1, good), /not frozen/);
});

// --- ② concurrent draft across documents: every artifact lands, the timeline is still untouched ---

test("concurrent drafts across documents produce every artifact and never touch the timeline", async () => {
  const { runDir, manifest, evidenceId } = await frozenRun(await twoDocRequest());
  const timelineBefore = await readFile(join(runDir, "timeline.jsonl"));

  await draftAllConcurrently(runDir, manifest, evidenceId);

  for (const document of manifest.documents) {
    for (const section of document.sections) {
      assert.ok(await exists(section.file), `${document.id} section ${section.index} file`);
      assert.ok(await exists(section.claimsFile), `${document.id} section ${section.index} claims`);
      assert.ok(await exists(receiptPath(runDir, document.id, section.index)), `${document.id} section ${section.index} receipt`);
    }
  }
  assert.ok((await readFile(join(runDir, "timeline.jsonl"))).equals(timelineBefore), "concurrent drafts must not touch timeline.jsonl");
});

// --- ③ collect ordering: deterministic event order, contiguous sequences, intact chain ---

test("collect records drafts in document x section order with a contiguous, valid hash chain", async () => {
  const { runDir, manifest, evidenceId } = await frozenRun(await twoDocRequest());
  await draftAllConcurrently(runDir, manifest, evidenceId);

  const expectedOrder = manifest.documents.flatMap((document) => [...document.sections].sort((a, b) => a.index - b.index).map((section) => `${document.id}#${section.index}`));
  const { collected } = await collectDrafts(runDir);
  assert.equal(collected.length, expectedOrder.length);

  const events = await readTimeline(runDir);
  const section = sectionEvents(events);
  assert.deepEqual(section.map((event) => `${event.documentId}#${event.section}`), expectedOrder, "events follow manifest document order then section index");
  // The collected events occupy a strictly contiguous sequence block, and the whole chain audits clean.
  const sequences = section.map((event) => event.sequence);
  for (let i = 1; i < sequences.length; i += 1) assert.equal(sequences[i], sequences[i - 1] + 1, "collected section events are contiguous");
  assert.deepEqual(await auditTimeline(runDir, manifest.id), [], "collect produces a chain that passes auditTimeline");
  for (const event of section) {
    assert.equal((event.data as Record<string, unknown>).collected, true);
    assert.equal(typeof (event.data as Record<string, unknown>).draftedAt, "string");
    assert.equal(event.action, "section.checkpoint");
  }
});

// --- ④ end-to-end audit equivalence (the load-bearing one): the parallel path audits clean ---

test("prepare -> freeze -> begin -> concurrent draft -> collect -> assemble audits with zero errors", async () => {
  const { runDir, manifest, evidenceId } = await frozenRun(await overviewRequest());
  await draftAllConcurrently(runDir, manifest, evidenceId);
  await collectDrafts(runDir);
  await assembleRun(runDir);

  const audit = await auditRun(runDir);
  assert.deepEqual(audit.findings.filter((finding) => finding.level === "error"), [], JSON.stringify(audit.findings, null, 2));
  assert.equal(audit.manifest.state, "complete");
});

// --- ⑤ revision path: a draft over a checkpointed section records section.revised and protects completedAt ---

test("drafting over a completed document records section.revised and protects completedAt", async () => {
  const { runDir, manifest, evidenceId } = await frozenRun(await overviewRequest());
  const document = manifest.documents[0];
  // Complete the whole document with serial checkpoints so completedAt is set.
  for (const section of document.sections) await checkpointSection(runDir, document.id, section.index, sectionText(section.title, section.index, evidenceId), sectionClaims(document.id, section.index, evidenceId));
  const completedAt = (await readManifest(runDir)).documents[0].completedAt;
  assert.ok(completedAt, "document completed after serial checkpoints");

  const receipt = await draftSection(runDir, document.id, 1, sectionText(document.sections[0].title, 1, evidenceId), sectionClaims(document.id, 1, evidenceId));
  assert.equal(receipt.revision, true);
  const { collected } = await collectDrafts(runDir);
  assert.equal(collected[0].revision, true);

  const events = sectionEvents(await readTimeline(runDir));
  const last = events.at(-1)!;
  assert.equal(last.action, "section.revised");
  assert.equal((last.data as Record<string, unknown>).revision, true);
  assert.equal((last.data as Record<string, unknown>).collected, true);
  // Revising a completed document must not re-stamp its completion.
  assert.equal((await readManifest(runDir)).documents[0].completedAt, completedAt);
});

// --- ⑥ partial drafting: resume lists the gap, a follow-up draft + collect closes it; empty collect is no-op ---

test("collect of a subset leaves the rest incomplete; a second draft + collect closes the gap; empty collect is a no-op", async () => {
  const { runDir, manifest, evidenceId } = await frozenRun(await overviewRequest());
  const document = manifest.documents[0];
  const [first, ...rest] = document.sections;

  await draftSection(runDir, document.id, first.index, sectionText(first.title, first.index, evidenceId), sectionClaims(document.id, first.index, evidenceId));
  await collectDrafts(runDir);

  const status = await runStatus(runDir);
  const documentStatus = (status.documents as Array<{ id: string; complete: number; total: number }>)[0];
  assert.equal(documentStatus.complete, 1);
  const resumed = await resumeRun(runDir);
  assert.deepEqual(resumed.next.map((item) => item.section).sort((a, b) => a - b), rest.map((section) => section.index));

  // An empty collect with nothing pending is a pure no-op: the ledger is byte-identical afterward.
  const timelineBefore = await readFile(join(runDir, "timeline.jsonl"));
  const empty = await collectDrafts(runDir);
  assert.equal(empty.collected.length, 0);
  assert.ok((await readFile(join(runDir, "timeline.jsonl"))).equals(timelineBefore), "no-op collect must not append events");

  // Draft the rest, collect, and the run assembles and audits clean.
  await Promise.all(rest.map((section) => draftSection(runDir, document.id, section.index, sectionText(section.title, section.index, evidenceId), sectionClaims(document.id, section.index, evidenceId))));
  await collectDrafts(runDir);
  await assembleRun(runDir);
  const audit = await auditRun(runDir);
  assert.deepEqual(audit.findings.filter((finding) => finding.level === "error"), [], JSON.stringify(audit.findings, null, 2));
});

// --- ⑦ author budget: an overrun marks the run timed-out with a warning but keeps every collected section ---

test("collect marks the run timed-out on an author-budget overrun yet keeps the collected sections", async () => {
  const { runDir, manifest, evidenceId } = await frozenRun(await overviewRequest({ authorMs: 100 }));
  const document = manifest.documents[0];
  const [first, ...rest] = document.sections;
  await draftSection(runDir, document.id, first.index, sectionText(first.title, first.index, evidenceId), sectionClaims(document.id, first.index, evidenceId));

  // Push the document's start well past the tiny author budget so collect measures an overrun deterministically.
  const patched = await readManifest(runDir);
  patched.documents[0].startedAt = new Date(Date.now() - 60_000).toISOString();
  await writeFile(join(runDir, "run.json"), JSON.stringify(patched, null, 2));

  const { manifest: after } = await collectDrafts(runDir);
  assert.equal(after.state, "timed-out");
  assert.ok(after.metrics.warnings.some((warning) => /authoring exceeded 100ms/.test(warning)), JSON.stringify(after.metrics.warnings));
  // The collected section survives the overrun; the untouched sections remain resumable.
  assert.equal((await readManifest(runDir)).documents[0].sections[0].complete, true);
  const resumed = await resumeRun(runDir);
  assert.deepEqual(resumed.next.map((item) => item.section).sort((a, b) => a - b), rest.map((section) => section.index));
});

// --- ⑧ fail closed: a receipt whose section file has been deleted stops collect with an error ---

test("collect fails closed when a receipt's section file is missing from disk", async () => {
  const { runDir, manifest, evidenceId } = await frozenRun(await overviewRequest());
  const document = manifest.documents[0];
  const section = document.sections[0];
  await draftSection(runDir, document.id, section.index, sectionText(section.title, section.index, evidenceId), sectionClaims(document.id, section.index, evidenceId));

  // The receipt promises a section on disk; delete it and collect must refuse rather than record a phantom.
  await rm(section.file);
  await assert.rejects(() => collectDrafts(runDir), /has no section file on disk/);
  // The unconsumed receipt is left in place so a corrected rerun can still pick it up.
  assert.ok(await exists(receiptPath(runDir, document.id, section.index)));
});

// --- ⑨ mixed serial checkpoint and parallel draft/collect interoperate on one run ---

test("serial checkpoint and parallel draft/collect mix cleanly on the same run", async () => {
  const { runDir, manifest, evidenceId } = await frozenRun(await overviewRequest());
  const document = manifest.documents[0];
  const [first, ...rest] = document.sections;

  // Section 1 via the serial path; the remaining sections via the parallel path.
  await checkpointSection(runDir, document.id, first.index, sectionText(first.title, first.index, evidenceId), sectionClaims(document.id, first.index, evidenceId));
  await Promise.all(rest.map((section) => draftSection(runDir, document.id, section.index, sectionText(section.title, section.index, evidenceId), sectionClaims(document.id, section.index, evidenceId))));
  await collectDrafts(runDir);

  assert.ok((await readManifest(runDir)).documents[0].sections.every((section) => section.complete), "every section complete");
  assert.deepEqual(await auditTimeline(runDir, manifest.id), [], "mixed run keeps a valid chain");
  await assembleRun(runDir);
  const audit = await auditRun(runDir);
  assert.deepEqual(audit.findings.filter((finding) => finding.level === "error"), [], JSON.stringify(audit.findings, null, 2));
});
