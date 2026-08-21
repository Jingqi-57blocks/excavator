import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { readFile } from "node:fs/promises";
import type { Audience, EvidenceItem, FeatureRequest, ReportRequest } from "../src/base/types.ts";
import { auditRun, freezeRun, prepareRun, searchSourceEvidence, updateChecklist } from "../src/run/run.ts";
import { featureCacheKey } from "../src/context/context.ts";
import { copyFixture, createCodeGraphFixture, installFixturePlan, tempDir } from "./helpers.ts";

async function makeRequest(authorMs = 30_000): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const db = join(workdir, "codegraph.db");
  createCodeGraphFixture(db);
  return {
    target, codegraph: db, workdir, language: "zh-CN", detailLevel: "standard",
    overviewAudiences: ["product", "engineering"],
    features: [
      { subject: "请假管理", aliases: ["leave", "holiday"], audiences: ["product", "engineering"] },
      { subject: "审批", aliases: ["approve", "manager"], audiences: ["product"] }
    ],
    budgets: { prepareMs: 30_000, authorMs, maxGraphQueries: 60, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 60, maxExpansionDepth: 2 }
  };
}

function sectionText(title: string, index: number, evidenceId: string): string {
  return `## ${title}\n\n这是第 ${index} 章的当前状态说明。\`事实\`\n\n**这意味着什么** 本章事实帮助读者理解后续内容。\`推断\`\n\n<details>\n<summary>依据</summary>\n\n- ${evidenceId}\n\n</details>\n`;
}

// The same substantive prose and claims as `sectionText`, but with the backtick evidence-level markers
// stripped: a section whose statements a reader cannot tell the evidence level of.

async function evidenceId(runDir: string): Promise<string> {
  const catalog = JSON.parse(await readFile(join(runDir, "evidence.json"), "utf8")) as { evidence: EvidenceItem[] };
  return catalog.evidence.find((item) => item.kind === "source")?.id ?? catalog.evidence[0].id;
}

async function dispositionChecklist(runDir: string, _id: string): Promise<void> {
  const receipt = await searchSourceEvidence(runDir, ["__excavator_no_such_fixture_marker__"], "prove the synthetic hypothesis search completed", { maxResults: 10 });
  const searchId = String((receipt.evidence as EvidenceItem).id);
  const checklist = JSON.parse(await readFile(join(runDir, "checklist.json"), "utf8")) as { items: Array<{ id: string }> };
  await updateChecklist(runDir, checklist.items.map((item) => ({
    id: item.id,
    verdict: "searched-not-found" as const,
    material: false,
    evidenceIds: [searchId],
    searchScope: "all candidate source files in the immutable synthetic fixture snapshot"
  })));
}

async function completeRun(runDir: string, manifest: Awaited<ReturnType<typeof prepareRun>>["manifest"]): Promise<string> {
  const id = await evidenceId(runDir);
  // Freeze-before-authoring order (assurance v3): dispose the plan and freeze first, then author. A run
  // authored without — or before — a freeze fails the audit-time order gate.
  await dispositionChecklist(runDir, id);
  const frozen = await freezeRun(runDir);
  assert.equal(frozen.frozen, true, JSON.stringify(frozen.findings, null, 2));
  // The plan precondition of authoring, derived from this run's own catalog (zero model calls).
  await installFixturePlan(runDir);
  return id;
}

test("a prd feature plans its own document and reuses the audience-independent feature cache (57B-380)", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const db = join(workdir, "codegraph.db");
  createCodeGraphFixture(db);
  const feature: Omit<FeatureRequest, "audiences"> = { subject: "请假管理", aliases: ["leave", "holiday"] };
  const key = featureCacheKey({ ...feature, audiences: ["product"] });
  const base = {
    target, codegraph: db, workdir, language: "zh-CN", detailLevel: "standard" as const,
    overviewAudiences: [] as Audience[],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 60, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 60, maxExpansionDepth: 2 }
  };

  // First prepare — product audience — populates the per-snapshot feature-scope cache (a miss).
  const first = await prepareRun({ ...base, features: [{ ...feature, audiences: ["product"] }] });
  assert.equal(first.manifest.metrics.cache[`feature:${key}`], "miss");

  // Second prepare — prd audience, same target/workdir/subject — plans a prd document from prd-feature.md
  // and reuses the same feature scope: the cache key depends only on subject+aliases, not the audience.
  const second = await prepareRun({ ...base, features: [{ ...feature, audiences: ["prd"] }] });
  const prd = second.manifest.documents.find((doc) => doc.audience === "prd");
  assert.ok(prd, "a prd feature document was planned");
  assert.equal(prd!.id, `feature-${key}-prd`);
  assert.equal(prd!.kind, "feature");
  assert.ok(prd!.templatePath.endsWith("prd-feature.md"), prd!.templatePath);
  assert.equal(prd!.sections.length, 10, "the prd-feature template's 10 chapters are derived as sections");
  assert.match(prd!.sections[8].title, /Acceptance checklist/);
  assert.equal(second.manifest.metrics.cache[`feature:${key}`], "hit", "the feature scope cache is reused across audiences");
});

test("repeated preparation creates isolated run directories while reusing caches", async () => {
  const request = await makeRequest();
  request.overviewAudiences = ["product"];
  request.features = [];
  const first = await prepareRun(request);
  const second = await prepareRun(request);
  assert.notEqual(first.runDir, second.runDir);
  assert.equal(second.manifest.metrics.graphQueries, 0);
  assert.equal(second.manifest.metrics.sourceWindows, 0);
});

test("cannot-determine checklist dispositions require evidence for the limitation", async () => {
  const request = await makeRequest();
  request.overviewAudiences = ["product"];
  request.features = [];
  const { runDir, manifest } = await prepareRun(request);
  const id = await completeRun(runDir, manifest);
  const checklistPath = join(runDir, "checklist.json");
  const checklist = JSON.parse(await readFile(checklistPath, "utf8")) as { items: Array<{ id: string }> };
  // completeRun freezes before authoring (assurance v3), so this post-freeze re-disposition must carry a
  // supplement charged to the same work item; the audit still rejects the evidence-less cannot-determine.
  await updateChecklist(runDir, [{
    id: checklist.items[0].id,
    verdict: "cannot-determine",
    material: false,
    evidenceIds: [],
    reason: "The synthetic fixture does not expose runtime configuration.",
    settledBy: "Runtime configuration and traffic evidence."
  }], { reason: "the frozen disposition needs a cannot-determine re-classification", workItemId: checklist.items[0].id });
  const audit = await auditRun(runDir);
  assert.ok(audit.findings.some((item) => /cannot-determine item has no evidence/i.test(item.message)));
  assert.ok(id);
});

test("source searches create cached, snapshot-bound receipt evidence", async () => {
  const request = await makeRequest();
  request.overviewAudiences = ["product"];
  request.features = [];
  const { runDir } = await prepareRun(request);
  const first = await searchSourceEvidence(runDir, ["Leave requests"], "locate the feature UI", { maxResults: 10 });
  assert.equal(first.cacheHit, false);
  assert.match(String(first.searchVersion), /^source-search-/);
  assert.match(String((first.evidence as EvidenceItem).id), /^SEARCH-/);
  assert.ok(Array.isArray(first.matches) && first.matches.length > 0);
  const second = await searchSourceEvidence(runDir, ["Leave requests"], "locate the feature UI", { maxResults: 10 });
  assert.equal(second.cacheHit, true);
  const persisted = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  assert.equal(persisted.metrics.sourceSearches, 1);
  assert.equal(persisted.metrics.sourceSearchCacheHits, 1);
});

test("a search receipt reports truncation honestly with a lower-bound count", async () => {
  const request = await makeRequest();
  request.overviewAudiences = ["product"];
  request.features = [];
  const { runDir } = await prepareRun(request);
  // A widespread token capped at one match: the receipt returns far fewer than were found.
  const truncated = await searchSourceEvidence(runDir, ["app"], "find a widespread token", { maxResults: 1 });
  assert.equal(truncated.truncated, true);
  assert.ok(Array.isArray(truncated.matches) && truncated.matches.length === 1);
  assert.ok(typeof truncated.atLeast === "number" && (truncated.atLeast as number) > truncated.matches.length);
  // A cap wider than the match set: the receipt is exhaustive and carries no truncation flag or count.
  const exhaustive = await searchSourceEvidence(runDir, ["__no_such_token_anywhere__"], "find nothing", { maxResults: 50 });
  assert.equal(exhaustive.truncated, false);
  assert.equal(exhaustive.atLeast, undefined);
  assert.ok(Array.isArray(exhaustive.matches) && exhaustive.matches.length === 0);
});

test("searched-not-found checklist dispositions reject non-search evidence", async () => {
  const request = await makeRequest();
  request.overviewAudiences = ["product"];
  request.features = [];
  const { runDir, manifest } = await prepareRun(request);
  const id = await evidenceId(runDir);
  const checklist = JSON.parse(await readFile(join(runDir, "checklist.json"), "utf8")) as { items: Array<{ id: string }> };
  await updateChecklist(runDir, checklist.items.map((item) => ({ id: item.id, verdict: "searched-not-found" as const, material: false, evidenceIds: [id], searchScope: "synthetic source files" })));
  const audit = await auditRun(runDir);
  assert.ok(audit.findings.some((item) => /cites no SEARCH receipt/i.test(item.message)));
});

test("searched-not-found checklist dispositions reject search receipts that contain matches", async () => {
  const request = await makeRequest();
  request.overviewAudiences = ["product"];
  request.features = [];
  const { runDir, manifest } = await prepareRun(request);
  const receipt = await searchSourceEvidence(runDir, ["Leave requests"], "find an existing fixture phrase", { maxResults: 10 });
  const searchId = String((receipt.evidence as EvidenceItem).id);
  const checklist = JSON.parse(await readFile(join(runDir, "checklist.json"), "utf8")) as { items: Array<{ id: string }> };
  await updateChecklist(runDir, checklist.items.map((item) => ({ id: item.id, verdict: "searched-not-found" as const, material: false, evidenceIds: [searchId], searchScope: "synthetic source files" })));
  const audit = await auditRun(runDir);
  assert.ok(audit.findings.some((item) => /contains matches/i.test(item.message)));
});

