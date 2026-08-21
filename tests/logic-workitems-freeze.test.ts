import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import type { DocumentPlan, FactPackItem, FeatureFactPack, InvestigationPlan, InvestigationWorkItem, KnowledgeArtifact, ReportRequest, RunManifest, SectionClaim } from "../src/base/types.ts";
import { auditRun, freezeRun, prepareRun, updateWorkItems } from "../src/run/run.ts";
import { workItemsToChecklist } from "../src/investigation/assurance.ts";
import { auditWorkItemClaimCoverage } from "../src/report/work-item-claim-coverage.ts";
import { logicWorkItems } from "../src/obligation/logic-workitems.ts";
import { readJson, writeJson } from "../src/base/util.ts";
import { copyFixture, createCodeGraphFixture, disposeAllWorkItems, tempDir } from "./helpers.ts";
import { v2Item, v2Pack } from "./factpack-v2-fixture.ts";

// 57B-375 wiring proof, WITHOUT any authoring run. The sample-target rescues no logic function, so these
// tests inject one rescued `logic` item into the prepared run's on-disk fact pack and derive the matching
// work item through the PRODUCTION `logicWorkItems` — exactly what prepare bakes when a real fact pack
// carries a rescue. That lets us prove the freeze gate fires on an undisposed logic function, that the three
// expected sets (plan / freeze / audit + checklist mirror) agree, and that a pre-v4 run is grandfathered.

const BUDGETS = { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

async function featureRequest(): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return { target, codegraph, workdir, language: "zh-CN", detailLevel: "standard", overviewAudiences: [], features: [{ subject: "Leave management", aliases: ["leave", "holiday"], audiences: ["product"] }], budgets: BUDGETS };
}

/** The one rescued decision function these tests promote, at a real sample-target source location. */
const RESCUED: FactPackItem = v2Item({ category: "logic", name: "isIgnoreHolidayLvType", filePath: "src/server.ts", line: 3, endLine: 3, detail: "func isIgnoreHolidayLvType", source: "graph", rank: 0, signal: "anchor-token holiday, references LvHldyTypeC(x1)" });

/** Overwrite the run's single feature fact pack so its `logic` category carries one rescued item. Returns the
 *  pack and manifest so a caller can derive the matching work item through the production function. */
async function writeRescuedPack(runDir: string): Promise<{ pack: FeatureFactPack; manifest: RunManifest }> {
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const featuresDir = join(runDir, "context", "features");
  const packFile = (await readdir(featuresDir)).find((name) => name.endsWith(".factpack.json"));
  assert.ok(packFile, "the prepared feature run wrote a fact pack");
  const packPath = join(featuresDir, packFile);
  const pack = await readJson<FeatureFactPack>(packPath);
  const updated = v2Pack([...pack.items.filter((item) => item.category !== "logic"), RESCUED], {
    featureKey: pack.featureKey,
    snapshotId: pack.snapshotId,
    warnings: pack.warnings
  });
  await writeJson(packPath, updated);
  return { pack: updated, manifest };
}

/** writeRescuedPack + bake the derived work item into workitems.json (pending) and its checklist mirror,
 *  exactly as prepare would have if the original fact pack had carried the rescue. */
async function injectRescuedLogic(runDir: string): Promise<string> {
  const { pack, manifest } = await writeRescuedPack(runDir);
  const logic = logicWorkItems([pack], manifest.documents);
  assert.equal(logic.items.length, 1, "one rescued function promotes to one work item");
  const plan = await readJson<InvestigationPlan>(join(runDir, "workitems.json"));
  plan.items.push(...logic.items);
  await writeJson(join(runDir, "workitems.json"), plan);
  await writeJson(join(runDir, "checklist.json"), workItemsToChecklist(plan));
  return logic.items[0].id;
}

const DIVERGENCE = /unexpected non-open work item|required work item is missing|unexpected non-open checklist item|required checklist item is missing/;

test("freeze is refused while a rescued logic function is undisposed; disposing it lets the run freeze", async () => {
  const { runDir } = await prepareRun(await featureRequest());
  await disposeAllWorkItems(runDir);
  const logicId = await injectRescuedLogic(runDir);

  const refused = await freezeRun(runDir);
  assert.equal(refused.frozen, false, "an undisposed logic-disposition item must block freeze");
  assert.ok(
    refused.findings.some((finding) => finding.level === "error" && finding.message.includes(logicId) && /was not completed/.test(finding.message)),
    JSON.stringify(refused.findings, null, 2)
  );

  await updateWorkItems(runDir, [{ id: logicId, status: "not-applicable", reason: "boundary noise in this synthetic fixture" }]);
  const frozen = await freezeRun(runDir);
  assert.equal(frozen.frozen, true, JSON.stringify(frozen.findings, null, 2));
});

test("plan, freeze expected-plan and audit expected-plan/checklist agree on the forced logic item", async () => {
  const { runDir } = await prepareRun(await featureRequest());
  const logicId = await injectRescuedLogic(runDir);
  await disposeAllWorkItems(runDir);

  const frozen = await freezeRun(runDir);
  assert.equal(frozen.frozen, true, JSON.stringify(frozen.findings, null, 2));
  // The frozen knowledge records the promoted work item, so freeze read it from the same on-disk fact pack.
  const knowledge = await readJson<KnowledgeArtifact>(join(runDir, "knowledge.json"));
  assert.ok(knowledge.workitems.some((item) => item.id === logicId), "the frozen plan carries the logic-disposition item");

  const audit = await auditRun(runDir);
  const divergence = audit.findings.filter((finding) => DIVERGENCE.test(finding.message));
  assert.deepEqual(divergence, [], "the three expected sets must agree — no unexpected/missing item in plan or checklist");
  // The forced item is present in both the actual plan and its checklist mirror, disposed not-applicable.
  const checklist = JSON.parse(await readFile(join(runDir, "checklist.json"), "utf8")) as { items: Array<{ id: string; verdict: string }> };
  assert.equal(checklist.items.find((item) => item.id === logicId)?.verdict, "not-applicable");
});

test("a v4 run is NOT false-failed by a later assurance/redaction bump (generation gate, not exact version)", async () => {
  const { runDir } = await prepareRun(await featureRequest());
  const logicId = await injectRescuedLogic(runDir);
  await disposeAllWorkItems(runDir);
  assert.equal((await freezeRun(runDir)).frozen, true);

  // Simulate the code moving ahead of the run: bump its stored version to a DIFFERENT generation-4 string,
  // no longer === ASSURANCE_VERSION but still generation 4. The baked origin-"default" logic item is already
  // in workitems.json; the old exact-equality gate would stop re-deriving it and false-fail it as unexpected.
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  manifest.assuranceVersion = "assurance-v4-redaction-vNEXT";
  await writeJson(join(runDir, "run.json"), manifest);

  const audit = await auditRun(runDir);
  const divergence = audit.findings.filter((finding) => DIVERGENCE.test(finding.message));
  assert.deepEqual(divergence, [], "a forward bump must still re-derive the baked logic item, never false-fail it as unexpected/missing");
  assert.ok(!audit.findings.some((finding) => finding.message.includes(logicId) && finding.level === "error"), "no error cites the baked logic item after the bump");
});

test("a pre-v4 run is grandfathered: a rescued fact pack forces nothing", async () => {
  const { runDir } = await prepareRun(await featureRequest());
  await disposeAllWorkItems(runDir);
  // A rescued pack on disk, but the run predates v4 and never baked the work item.
  const { pack, manifest } = await writeRescuedPack(runDir);
  const wouldBeId = logicWorkItems([pack], manifest.documents).items[0].id;
  manifest.assuranceVersion = "assurance-v3-redaction-v4";
  await writeJson(join(runDir, "run.json"), manifest);

  const frozen = await freezeRun(runDir);
  assert.equal(frozen.frozen, true, "a grandfathered run does not require the rescued logic item, so freeze proceeds");

  const audit = await auditRun(runDir);
  assert.ok(!audit.findings.some((finding) => finding.message.includes(wouldBeId)), "a grandfathered run neither requires nor rejects the rescued logic function");
  assert.ok(!audit.findings.some((finding) => DIVERGENCE.test(finding.message) && finding.message.includes("logic")), JSON.stringify(audit.findings.filter((f) => DIVERGENCE.test(f.message)), null, 2));
});

// --- disposition acceptance (root cause b): a product-report claim describing the behavior, no identifier
// in prose, links the item and reuses its evidence. Pure auditWorkItemClaimCoverage — no authoring run. ---

const DOC = "feature-abc-product";
function logicItem(id: string, over: Partial<InvestigationWorkItem> = {}): InvestigationWorkItem {
  return { id, dimension: "logic-disposition", scope: "feature:abc", hypothesis: "h", status: "found", material: true, requiredFor: [DOC], evidenceIds: ["S-1"], traceIds: [], reportSection: undefined, origin: "default", ...over };
}
function doc(): DocumentPlan {
  return { id: DOC, kind: "feature", audience: "product", templatePath: "/t", contextPath: "/c", sections: Array.from({ length: 5 }, (_, i) => ({ index: i + 1, title: `S${i + 1}`, file: "/f", claimsFile: "/c", complete: true })) };
}
function claim(over: Partial<SectionClaim>): SectionClaim {
  return { id: "C-1", marker: "verified", statement: "s", evidenceIds: [], workItemIds: [], ...over };
}

test("a behavioral claim in any section, with no identifier in prose, satisfies a found logic item by reusing its evidence", () => {
  const plan: InvestigationPlan = { version: 1, runId: "r", createdAt: "", items: [logicItem("feature:abc:logic:CalculationAuto@svc/service.go:415")] };
  // The claim prose describes behavior only; the deciding identifier stays out of it. It lands in §5, not a
  // pinned section — the unpinned logic item accepts any section — and reuses the item's evidence S-1.
  const behavioral = claim({ id: "K-1", marker: "verified", statement: "工时按自然日或工作日累计并在结算时扣减余额", evidenceIds: ["S-1"], workItemIds: ["feature:abc:logic:CalculationAuto@svc/service.go:415"] });
  const claims = new Map([[DOC, [{ section: 5, claim: behavioral }]]]);
  const findings = auditWorkItemClaimCoverage(plan, [doc()], claims, { completeDocumentIds: new Set([DOC]) });
  assert.deepEqual(findings, [], "covering the behavior and reusing the evidence satisfies the ledger, identifier not required");
});

test("a claim that links the found logic item but reuses none of its evidence is rejected", () => {
  const plan: InvestigationPlan = { version: 1, runId: "r", createdAt: "", items: [logicItem("feature:abc:logic:CalculationAuto@svc/service.go:415")] };
  const detached = claim({ id: "K-2", statement: "some behavior", evidenceIds: ["S-9"], workItemIds: ["feature:abc:logic:CalculationAuto@svc/service.go:415"] });
  const claims = new Map([[DOC, [{ section: 3, claim: detached }]]]);
  const findings = auditWorkItemClaimCoverage(plan, [doc()], claims, { completeDocumentIds: new Set([DOC]) });
  assert.ok(findings.some((f) => /do not reuse its evidence or trace/.test(f.message)), JSON.stringify(findings, null, 2));
});

test("one unavailable claim batch-disposes several not-applicable logic items via its workItemIds array", () => {
  const ids = ["feature:abc:logic:noiseA@svc/a.go:1", "feature:abc:logic:noiseB@svc/b.go:2"];
  const plan: InvestigationPlan = { version: 1, runId: "r", createdAt: "", items: ids.map((id) => logicItem(id, { status: "not-applicable", evidenceIds: [], reason: "boundary noise" })) };
  const batch = claim({ id: "K-3", marker: "unavailable", statement: "两个边界工具函数与本能力无关", reason: "boundary noise outside the capability", workItemIds: ids });
  const claims = new Map([[DOC, [{ section: 5, claim: batch }]]]);
  const findings = auditWorkItemClaimCoverage(plan, [doc()], claims, { completeDocumentIds: new Set([DOC]) });
  assert.deepEqual(findings, [], "one unavailable claim listing both ids disposes both n/a items");
});
