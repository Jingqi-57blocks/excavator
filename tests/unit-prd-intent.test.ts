import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { EvidenceItem, ReportRequest } from "../src/base/types.ts";
import { freezeRun, prepareRun } from "../src/run/run.ts";
import { planRun } from "../src/run/stages/plan-stage.ts";
import { assembleUnits } from "../src/run/stages/unit-assemble-stage.ts";
import { checkpointUnit } from "../src/report/unit-checkpoint.ts";
import { intentPolicyFor, lensPolicyFor } from "../src/report/report-policy-registry.ts";
import { exists } from "../src/base/util.ts";
import { copyFixture, createCodeGraphFixture, disposeAllWorkItems, manifestOf, tempDir } from "./helpers.ts";
import { planViewOf, unitDraftFor, UNIT_BUDGETS, type PlannedRun } from "./unit-fixture.ts";

/**
 * The prd DOCUMENT TASK, end to end on the unit path.
 *
 * `prd` was the one audience the section path treated specially — a tenth template and a relaxed section-link
 * check — and the only e2e that proved a prd request reaches a deliverable at all authored ten chapters
 * (`tests/prd-audience.test.ts`). The v2 vocabulary splits that word in two: the READER is still the product
 * manager, and `prd` is the INTENT. `mapLegacyDocumentRequest` is where the split happens and
 * `tests/legacy-request-mapping.test.ts` pins every arm of it as a pure function — what nothing asserted is that
 * the mapped row survives planning, drafting, collecting and assembly and lands in the deliverable's own header.
 *
 * That is what this fixture is: one feature document requested for the prd audience, carried by the real commands
 * to `reports/`, with the front matter read back. The two policy digests are compared against the registry's own
 * entries rather than to literals, so the assertion is "the policy in force is the prd one", not "these bytes".
 *
 * ZERO MODEL CALLS: the plan is the fixture plan derived from the run's own catalog, and every unit's prose comes
 * from `unitContent` in `tests/unit-fixture.ts`.
 */

const SUBJECT = "Leave management";

async function prdFeatureRun(): Promise<PlannedRun> {
  const target = await copyFixture();
  const workdir = await tempDir("excavator-unit-prd-");
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  const request: ReportRequest = {
    target, codegraph, workdir, language: "zh-CN", detailLevel: "standard",
    overviewAudiences: [],
    features: [{ subject: SUBJECT, aliases: ["leave", "holiday"], audiences: ["prd"] }],
    budgets: UNIT_BUDGETS
  };
  const { runDir } = await prepareRun(request);
  await disposeAllWorkItems(runDir);
  const frozen = await freezeRun(runDir);
  assert.equal(frozen.frozen, true, JSON.stringify(frozen.findings, null, 2));
  await planRun(runDir, { mode: "fixture" }, { kind: "record" });
  const catalog = JSON.parse(await readFile(join(runDir, "evidence.json"), "utf8")) as { evidence: EvidenceItem[] };
  const evidenceId = (catalog.evidence.find((item) => item.kind === "source") ?? catalog.evidence[0]!).id;
  const base = { runDir, workdir, manifest: await manifestOf(runDir), evidenceId, view: await planViewOf(runDir) };
  for (const unitId of base.view.collectionOrder) {
    await checkpointUnit(runDir, await unitDraftFor({ ...base, view: await planViewOf(runDir) }, unitId));
  }
  return { ...base, view: await planViewOf(runDir) };
}

function frontMatterOf(document: string): Map<string, string> {
  const [, header] = document.split("---\n", 2);
  assert.ok(header, "the assembled document opens with YAML front matter");
  const rows = new Map<string, string>();
  for (const line of header.split("\n")) {
    const separator = line.indexOf(": ");
    if (separator > 0) rows.set(line.slice(0, separator), line.slice(separator + 2));
  }
  return rows;
}

test("a prd feature request reaches an assembled unit-path deliverable whose header carries the prd intent", async () => {
  const run = await prdFeatureRun();
  const assembled = await assembleUnits(run.runDir, "write");
  assert.equal(assembled.written, true);
  assert.equal(assembled.documents.length, 1, JSON.stringify(assembled.documents));

  const document = assembled.documents[0]!;
  const text = await readFile(join(run.runDir, document.path), "utf8");
  const header = frontMatterOf(text);

  // The v2 row, as the mapping produced it: the reader did not become "prd", the task did.
  assert.equal(header.get("audience"), "product-manager");
  assert.equal(header.get("intent"), "prd");
  assert.equal(header.get("scope"), "feature");
  assert.ok(header.get("scopeIds")?.startsWith("["), header.get("scopeIds"));

  // And the policies in force are the registry's prd/product-manager entries, digest included.
  const intent = intentPolicyFor("prd");
  const lens = lensPolicyFor("product-manager");
  assert.equal(header.get("intentPolicy"), `"${intent.id}@${intent.version}"`);
  assert.equal(header.get("intentPolicyDigest"), intent.digest);
  assert.equal(header.get("lensPolicy"), `"${lens.id}@${lens.version}"`);
  assert.equal(header.get("lensPolicyDigest"), lens.digest);

  // The deliverable is complete rather than a header: its three companions are beside it.
  for (const key of ["claimsCompanion", "tracesCompanion", "coverageCompanion"]) {
    const relative = header.get(key)?.replace(/^"|"$/g, "");
    assert.ok(relative, key);
    assert.ok(await exists(join(run.runDir, relative)), `${key} -> ${relative}`);
  }
});
