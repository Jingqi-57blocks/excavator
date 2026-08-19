// Golden byte pin for `assemble` (57B-441 R0), on top of the model-free canned-draft chain the parallel
// authoring e2e already exercises: prepare -> freeze -> begin -> concurrent draft -> collect -> assemble.
//
// Why a golden and not another structural assertion: the epic replaces everything upstream of the authoring
// runtime (topic catalog, planner, authoring units). The one thing that must NOT move while that happens is the
// bytes assemble produces from the same knowledge and the same drafts. A structural assertion would pass through
// a formatting regression; a byte pin cannot.
//
// The projection substitutes six volatile identifiers and nothing else (see eval/report-canonical.ts). This file
// carries both directions of that claim:
//
//   * positive — two independent runs of the same fixture produce DIFFERENT raw report bytes and the SAME
//     canonical bytes, and every rule the projection declares is asserted to have actually fired;
//   * negative — the rules leave stable content alone: a bare date, a bare clock time, a non-Z instant, an
//     id-shaped string that is not in the run's catalog, and ordinary prose all survive verbatim; two distinct
//     catalog ids keep distinct placeholders; and a one-byte edit to a drafted section moves the golden.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceItem, ReportRequest, RunManifest, SectionClaim } from "../../src/base/types.ts";
import { assembleRun, beginDocument, freezeRun, prepareRun } from "../../src/run/run.ts";
import { collectDrafts, draftSection } from "../../src/report/parallel-authoring.ts";
import { copyFixture, createCodeGraphFixture, disposeAllWorkItems, tempDir } from "../../tests/helpers.ts";
import { canonicalAssembleProjection, canonicalizeText, type VolatileIdentity } from "../report-canonical.ts";

const GOLDEN = join(import.meta.dirname, "..", "golden", "assemble-canonical.txt");
const BUDGETS = { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

// The canned draft. It is owned by THIS file: the golden pins these bytes, so editing one character here is the
// tripwire for "assemble output changed", and nothing else in the suite depends on the wording.
function sectionText(title: string, index: number, evidenceId: string): string {
  return `## ${title}\n\n第 ${index} 节记录当前状态。\`事实\`\n\n<details><summary>依据</summary>\n\n- ${evidenceId}\n\n</details>\n`;
}
function sectionClaims(documentId: string, index: number, evidenceId: string): SectionClaim[] {
  return [{ id: `C-${documentId}-${index}`, marker: "fact", statement: `第 ${index} 节记录当前状态。`, evidenceIds: [evidenceId], confidence: "high", status: "verified" }];
}

async function overviewRequest(): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return { target, codegraph, workdir, language: "zh-CN", detailLevel: "standard", overviewAudiences: ["product"], features: [], budgets: BUDGETS };
}

/** The model-free chain, end to end, with canned drafts. Returns the run directory it assembled. */
async function assembledRun(): Promise<{ runDir: string; manifest: RunManifest }> {
  const { runDir } = await prepareRun(await overviewRequest());
  const catalog = JSON.parse(await readFile(join(runDir, "evidence.json"), "utf8")) as { evidence: EvidenceItem[] };
  const evidenceId = catalog.evidence.find((item) => item.kind === "source")?.id ?? catalog.evidence[0].id;
  await disposeAllWorkItems(runDir);
  assert.equal((await freezeRun(runDir)).frozen, true);
  const manifest = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as RunManifest;
  for (const document of manifest.documents) await beginDocument(runDir, document.id);
  await Promise.all(manifest.documents.flatMap((document) =>
    document.sections.map((section) => draftSection(runDir, document.id, section.index, sectionText(section.title, section.index, evidenceId), sectionClaims(document.id, section.index, evidenceId)))
  ));
  await collectDrafts(runDir);
  await assembleRun(runDir);
  return { runDir, manifest: JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as RunManifest };
}

const golden = readFileSync(GOLDEN, "utf8");
const first = await assembledRun();
const second = await assembledRun();

test("two independent runs write different report bytes and project to the same canonical bytes as the golden", async () => {
  const rawFirst = await readFile(join(first.runDir, "reports", "product-overview.md"), "utf8");
  const rawSecond = await readFile(join(second.runDir, "reports", "product-overview.md"), "utf8");
  assert.notEqual(rawFirst, rawSecond, "the raw reports must differ, otherwise the canonical projection proves nothing");

  const a = canonicalAssembleProjection(first.runDir);
  const b = canonicalAssembleProjection(second.runDir);
  assert.deepEqual(a.files, ["companions/overview-product.claims.json", "companions/overview-product.coverage.json", "companions/overview-product.traces.json", "product-overview.md"]);
  assert.deepEqual(a.files, b.files);
  assert.equal(a.text, b.text, "the same fixture must project to the same canonical bytes");
  assert.equal(a.text, golden, "the canonical projection must equal the checked-in golden");
  assert.equal(Buffer.compare(Buffer.from(a.text), Buffer.from(golden)), 0);
});

test("assembling the same run twice leaves the canonical projection byte-identical", async () => {
  const before = canonicalAssembleProjection(first.runDir).text;
  await assembleRun(first.runDir);
  const after = canonicalAssembleProjection(first.runDir).text;
  assert.equal(after, before, "a second assemble must not move a byte");
  assert.equal(after, golden);
});

test("every declared substitution rule fires, and no volatile identifier survives into the golden", () => {
  const projection = canonicalAssembleProjection(second.runDir);
  const fired = Object.fromEntries(projection.applied.map((rule) => [rule.name, rule.replacements]));
  // Each rule is load-bearing on this fixture: a rule that never fires is an untested rule.
  for (const name of ["evidence-id", "run-id", "snapshot-id", "target-name", "iso-instant"]) {
    assert.ok((fired[name] ?? 0) > 0, `rule ${name} must fire (fired ${JSON.stringify(fired)})`);
  }
  // The absolute target path never reaches a report; the rule exists so a future leak is masked, not silently
  // machine-dependent — and the assertion below is what proves nothing local is in the golden either way.
  assert.equal(fired["target-path"], 0);

  const { identity } = projection;
  for (const literal of [identity.runId, identity.snapshotId, identity.targetPath, identity.targetName, second.runDir, tmpdir()]) {
    assert.ok(!projection.text.includes(literal), `canonical projection must not contain ${literal}`);
  }
  for (const id of Object.keys(identity.evidencePlaceholders)) assert.ok(!projection.text.includes(id), `canonical projection must not contain evidence id ${id}`);
  // The front matter kept its run/snapshot lines — the values were replaced, the structure was not.
  assert.ok(projection.text.includes("run: <RUN-ID>"));
  assert.ok(projection.text.includes("snapshot: <SNAPSHOT-ID>"));
  assert.ok(/title: "<TARGET-NAME> — product overview"/.test(projection.text));
});

test("the substitution rules leave stable content alone", () => {
  const identity: VolatileIdentity = {
    runId: "run-2026_01_02_03_04-overview-aaaaaaaa-bbbbbbbb-cccccccc",
    snapshotId: "0123456789abcdef0123",
    targetPath: "/tmp/excavator-test-AbCdEf",
    targetName: "excavator-test-AbCdEf",
    evidencePlaceholders: { "S-1111111111": "<EVIDENCE source src/a.ts:1-3>", "S-2222222222": "<EVIDENCE source src/b.ts:4-6>" }
  };
  const input = [
    "run: run-2026_01_02_03_04-overview-aaaaaaaa-bbbbbbbb-cccccccc",
    "snapshot: 0123456789abcdef0123",
    "started: 2026-01-02T03:04:05.678Z",
    "cited: S-1111111111 and S-2222222222 and S-1111111111",
    "not in this catalog: S-9999999999",
    "release date 2026-01-02 and daily cutoff 03:04:05 and local stamp 2026-01-02T03:04:05",
    "第 1 节记录当前状态。 The snapshot digest column header stays."
  ].join("\n");
  const { text, applied } = canonicalizeText(input, identity);
  const fired = Object.fromEntries(applied.map((rule) => [rule.name, rule.replacements]));

  // Positive: the volatile forms went.
  assert.deepEqual(fired, { "evidence-id": 3, "run-id": 1, "snapshot-id": 1, "target-path": 0, "target-name": 0, "iso-instant": 1 });
  assert.ok(text.includes("run: <RUN-ID>"));
  assert.ok(text.includes("snapshot: <SNAPSHOT-ID>"));
  assert.ok(text.includes("started: <TIMESTAMP>"));

  // Negative: nothing stable was eaten.
  assert.ok(text.includes("release date 2026-01-02 and daily cutoff 03:04:05 and local stamp 2026-01-02T03:04:05"), "a bare date, a bare time and a non-Z instant are not instants");
  assert.ok(text.includes("not in this catalog: S-9999999999"), "an id-shaped string outside the run's catalog is left alone");
  assert.ok(text.includes("第 1 节记录当前状态。 The snapshot digest column header stays."), "prose survives verbatim");
  // Two distinct ids keep distinct placeholders, so a swap between them would still diff.
  assert.ok(text.includes("cited: <EVIDENCE source src/a.ts:1-3> and <EVIDENCE source src/b.ts:4-6> and <EVIDENCE source src/a.ts:1-3>"));
});

test("two catalog ids that describe the same evidence fail by name instead of collapsing", () => {
  const identity: VolatileIdentity = {
    runId: "run-x", snapshotId: "snap-x", targetPath: "/tmp/x", targetName: "x",
    evidencePlaceholders: { "S-aaaaaaaaaa": "<EVIDENCE source src/a.ts:1-3>", "S-bbbbbbbbbb": "<EVIDENCE source src/a.ts:1-3>" }
  };
  assert.throws(() => canonicalizeText("S-aaaaaaaaaa and S-bbbbbbbbbb", identity),
    /report canonical: evidence ids S-aaaaaaaaaa and S-bbbbbbbbbb both appear in the projection and both describe <EVIDENCE source src\/a.ts:1-3>/);
});

test("a one-byte edit to a drafted section moves the canonical projection off the golden", async () => {
  const section = second.manifest.documents[0].sections[0];
  const drafted = await readFile(section.file, "utf8");
  assert.ok(drafted.includes("第 1 节"), "the canned draft must contain the byte this test flips");
  await writeFile(section.file, drafted.replace("第 1 节", "第 9 节"));
  await assembleRun(second.runDir);

  const mutated = canonicalAssembleProjection(second.runDir).text;
  assert.notEqual(mutated, golden, "a drafted byte must not be invisible to the golden");
  // Exactly one character moved, and it is the one that was edited: the projection neither swallows the change
  // nor smears it across the file. (Section 9's own body already reads `第 9 节`, so this is checked positionally
  // rather than by substituting the text back.)
  assert.equal(mutated.length, golden.length);
  const differences = [...mutated].map((character, index) => ({ index, mutated: character, golden: golden[index] })).filter((entry) => entry.mutated !== entry.golden);
  assert.equal(differences.length, 1, JSON.stringify(differences));
  assert.deepEqual([differences[0].mutated, differences[0].golden], ["9", "1"]);
});
