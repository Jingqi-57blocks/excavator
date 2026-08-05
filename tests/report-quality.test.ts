import test from "node:test";
import assert from "node:assert/strict";
import type { DocumentPlan, InvestigationPlan, SectionClaim, SectionClaimsFile } from "../src/types.ts";
import { auditDetailedFeatureSection, auditWorkItemClaimCoverage } from "../src/assurance.ts";

function featureDocument(): DocumentPlan {
  return {
    id: "feature-account-engineering",
    kind: "feature",
    audience: "engineering",
    subject: "Account access",
    templatePath: "contract.md",
    contextPath: "context.md",
    sections: Array.from({ length: 12 }, (_, index) => ({ index: index + 1, title: `Section ${index + 1}`, file: `${index + 1}.md`, claimsFile: `${index + 1}.json`, complete: true }))
  };
}

function claimsFile(section: number, count: number): SectionClaimsFile {
  return {
    version: 2,
    documentId: "feature-account-engineering",
    section,
    claims: Array.from({ length: count }, (_, index): SectionClaim => ({
      id: `C-${section}-${index + 1}`,
      marker: "fact",
      statement: `Distinct material fact ${section}-${index + 1}.`,
      evidenceIds: ["S-1"]
    }))
  };
}

test("detailed engineering features reject synopsis-level chapter density", () => {
  const findings = auditDetailedFeatureSection({
    document: featureDocument(),
    detailLevel: "detailed",
    sectionIndex: 4,
    sectionText: "## Business rules\n\nOne broad summary. `fact`\n",
    claimsFile: claimsFile(4, 2)
  });
  assert.ok(findings.some((item) => /minimum is 16/i.test(item.message)));
  assert.ok(findings.some((item) => /requires an inventory/i.test(item.message)));
});

test("standard mode keeps evidence checks without enforcing the detailed density floor", () => {
  const findings = auditDetailedFeatureSection({
    document: featureDocument(),
    detailLevel: "standard",
    sectionIndex: 4,
    sectionText: "## Business rules\n\nOne broad summary. `fact`\n",
    claimsFile: claimsFile(4, 1)
  });
  assert.deepEqual(findings, []);
});

test("material work items must be visible in the assigned chapter and reuse their grounding", () => {
  const document = featureDocument();
  const itemId = "feature:account:calculations-and-thresholds";
  const plan: InvestigationPlan = {
    version: 1,
    runId: "run-test",
    createdAt: new Date(0).toISOString(),
    items: [{
      id: itemId,
      dimension: "calculations-and-thresholds",
      scope: "feature:account",
      hypothesis: "Thresholds are inventoried.",
      status: "found",
      material: true,
      requiredFor: [document.id],
      evidenceIds: ["S-rule"],
      traceIds: [],
      reportSection: 4,
      origin: "default"
    }]
  };
  const missing = auditWorkItemClaimCoverage(plan, [document], new Map([[document.id, []]]));
  assert.ok(missing.some((item) => /not represented/i.test(item.message)));

  const wrongSection = auditWorkItemClaimCoverage(plan, [document], new Map([[document.id, [{ section: 3, claim: {
    id: "C-rule",
    marker: "fact",
    statement: "The limit is eight hours.",
    evidenceIds: ["S-rule"],
    workItemIds: [itemId]
  } }]]]));
  assert.ok(wrongSection.some((item) => /expected section 4/i.test(item.message)));

  const grounded = auditWorkItemClaimCoverage(plan, [document], new Map([[document.id, [{ section: 4, claim: {
    id: "C-rule",
    marker: "fact",
    statement: "The limit is eight hours.",
    evidenceIds: ["S-rule"],
    workItemIds: [itemId]
  } }]]]));
  assert.deepEqual(grounded, []);
});

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { prepareRun } from "../src/run.ts";
import { copyFixture, tempDir } from "./helpers.ts";

test("detailed feature preparation emits a chapter-oriented authoring inventory", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const { runDir, manifest } = await prepareRun({
    target,
    codegraphMode: "off",
    language: "zh-CN",
    detailLevel: "detailed",
    workdir,
    overviewAudiences: [],
    features: [{ subject: "Leave management", aliases: ["leave", "holiday"], audiences: ["engineering"] }],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 10, maxSourceWindows: 70, maxSourceCharacters: 160_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 }
  });
  const key = manifest.documents[0].id.replace(/^feature-/, "").replace(/-engineering$/, "");
  const context = await readFile(join(runDir, "context", "features", `${key}.md`), "utf8");
  assert.match(context, /## Authoring inventory/);
  assert.match(context, /UI, API and automated entry points/);
  assert.match(context, /Types, states, calculations and validation/);
  assert.match(context, /Tests, documentation and unfinished behavior/);
});
