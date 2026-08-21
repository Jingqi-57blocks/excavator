import { auditSectionClaims, auditTargetProblemAttribution } from "../src/report/section-audit.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { Audience, ReportRequest } from "../src/base/types.ts";
import { auditRun, prepareRun } from "../src/run/run.ts";
import { copyFixture, createCodeGraphFixture, tempDir } from "./helpers.ts";

async function request(options: { feature?: boolean; graph?: boolean } = {}): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  let codegraph: string | undefined;
  if (options.graph) {
    codegraph = join(workdir, "codegraph.db");
    createCodeGraphFixture(codegraph);
  }
  return {
    target,
    codegraph,
    codegraphMode: options.graph ? "auto" : "off",
    language: "zh-CN",
    detailLevel: "standard",
    workdir,
    overviewAudiences: options.feature ? [] : ["product"],
    features: options.feature ? [{ subject: "Leave management", aliases: ["leave", "holiday"], audiences: ["product"] }] : [],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 }
  };
}

test("prepare persists analysis scope, provider registry, work items, traces and a valid timeline", async () => {
  const { runDir, manifest } = await prepareRun(await request({ graph: true }));
  const scope = JSON.parse(await readFile(join(runDir, "analysis-scope.json"), "utf8"));
  const providers = JSON.parse(await readFile(join(runDir, "provider-status.json"), "utf8"));
  const workitems = JSON.parse(await readFile(join(runDir, "workitems.json"), "utf8"));
  const traces = JSON.parse(await readFile(join(runDir, "traces.json"), "utf8"));
  const timeline = (await readFile(join(runDir, "timeline.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(scope.snapshotId, manifest.snapshot?.id);
  assert.equal(scope.providerRegistryDigest, providers.digest);
  assert.ok(providers.providers.some((provider: any) => provider.id === "source" && provider.selected));
  assert.ok(providers.providers.some((provider: any) => provider.id === "codegraph" && provider.selected));
  assert.ok(workitems.items.length > 0);
  assert.deepEqual(traces.traces, []);
  assert.equal(timeline[0].action, "run.prepared");
  assert.equal(timeline[0].sequence, 1);
});

test("source-only provider registry records CodeGraph as unselected", async () => {
  const { runDir } = await prepareRun(await request());
  const providers = JSON.parse(await readFile(join(runDir, "provider-status.json"), "utf8"));
  const graph = providers.providers.find((provider: any) => provider.id === "codegraph");
  assert.equal(graph.selected, false);
  assert.equal(graph.available, false);
  assert.match(graph.selectionReason, /source-only/i);
});

// The scanner is internal; the ids it extracts surface one-for-one as "cites <id>" findings
// when the section declares no evidence, so the findings are a faithful readout of the scan.
function citedEvidenceIds(sectionText: string, knownEvidenceIds: string[] = []): string[] {
  const findings = auditSectionClaims({
    documentId: "doc",
    sectionIndex: 1,
    sectionText,
    claimsFile: { version: 2, documentId: "doc", section: 1, claims: [] },
    evidenceIds: new Set(knownEvidenceIds)
  });
  return findings
    .flatMap((finding) => finding.message.match(/cites (\S+) but no section claim declares it/)?.[1] ?? [])
    .sort();
}

test("evidence id scanner never emits ids that end on a separator", () => {
  assert.deepEqual(citedEvidenceIds("<!--E:S-d59eb3a823-->", ["S-d59eb3a823"]), ["S-d59eb3a823"]);
  assert.deepEqual(citedEvidenceIds("- S-abc--", ["S-abc"]), ["S-abc"]);
  assert.deepEqual(citedEvidenceIds("- S-abc.", ["S-abc"]), ["S-abc"]);
  assert.deepEqual(citedEvidenceIds("- S-abc:", ["S-abc"]), ["S-abc"]);
  // A separator-terminated token that matches no catalogued id is no longer reported at all,
  // which is what stops one stray marker from cascading into hundreds of false findings.
  assert.deepEqual(citedEvidenceIds("<!--E:S-d59eb3a823-->"), []);
});

test("evidence id scanner still recognizes plain and Unicode ids", () => {
  assert.deepEqual(citedEvidenceIds("- SEARCH-1a2b3c"), ["SEARCH-1a2b3c"]);
  assert.deepEqual(citedEvidenceIds("- FG-请假管理-abc12"), ["FG-请假管理-abc12"]);
  assert.deepEqual(citedEvidenceIds("依据 SEARCH-1a2b3c 与 GIT-9f0e1d。"), ["GIT-9f0e1d", "SEARCH-1a2b3c"]);
});

test("the pseudo-id scanner flags a fabricated FACT- id but accepts a declared catalog one", () => {
  // A FACT-* token in prose that no claim declares is a fabricated citation, flagged like any prefix.
  assert.deepEqual(citedEvidenceIds("- FACT-xyz"), ["FACT-xyz"]);
  assert.deepEqual(citedEvidenceIds("依据 FACT-leave-mana-entrypoints-f70ad25f。"), ["FACT-leave-mana-entrypoints-f70ad25f"]);

  // A real fact-pack id the catalog carries and a section claim declares raises no pseudo-id finding.
  const factId = "FACT-leave-mana-entrypoints-f70ad25f";
  const findings = auditSectionClaims({
    documentId: "doc",
    sectionIndex: 1,
    sectionText: `第 1 节枚举入口 ${factId}。\`事实\``,
    claimsFile: { version: 2, documentId: "doc", section: 1, claims: [{ id: "C-1", marker: "fact", statement: "第 1 节枚举入口", evidenceIds: [factId] }] },
    evidenceIds: new Set([factId])
  });
  assert.ok(!findings.some((finding) => /FACT-/.test(finding.message)), JSON.stringify(findings));
});

test("target problem sections reject analyser limitations", () => {
  const document = {
    id: "leave-product",
    kind: "feature" as const,
    audience: "product" as const,
    subject: "Leave",
    templatePath: "template.md",
    contextPath: "context.md",
    sections: []
  };
  const findings = auditTargetProblemAttribution({
    document,
    sectionIndex: 11,
    sectionText: "## Current problems found\n\nCodeGraph routes cannot prove the complete handler path."
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /analysis-method information/i);
});

test("a product feature's connected-scope chapter (section 10) is not the problem chapter", () => {
  // 57B-364 #3: product-feature problems moved from §10 (now connected scope) to their own §11.
  const document = {
    id: "leave-product",
    kind: "feature" as const,
    audience: "product" as const,
    subject: "Leave",
    templatePath: "template.md",
    contextPath: "context.md",
    sections: []
  };
  // The old problem section index (10) now describes connected scope, so analysis-method wording there
  // is out of the attribution check's scope; the check only guards the section-11 problem chapter.
  assert.deepEqual(auditTargetProblemAttribution({
    document,
    sectionIndex: 10,
    sectionText: "## Connected capabilities and scope\n\nCodeGraph routes reach the billing capability."
  }), []);
});

// Restored after /code-review caught an over-deletion: this case is a PURE `auditTargetProblemAttribution`
// call with no section-chain dependency, and it is the only negative control at the correct problem-section
// index (§11 with prose matching none of `ANALYSIS_METHOD_TERMS` → zero findings). The survivors above assert
// a positive at §11 and an early return at §10, so without this one an over-broad new term that matches
// ordinary target prose would go green. The deletion pass mis-flagged it: the detector took each case's body
// as running to the NEXT `test(`, which swallowed a helper defined in between.
test("target problem sections allow target-attributable contradictions", () => {
  const document = {
    id: "leave-engineering",
    kind: "feature" as const,
    audience: "engineering" as const,
    subject: "Leave",
    templatePath: "template.md",
    contextPath: "context.md",
    sections: []
  };
  const findings = auditTargetProblemAttribution({
    document,
    sectionIndex: 11,
    sectionText: "## Current problems\n\nThe production threshold is 166 hours while the target test asserts 200 hours."
  });
  assert.equal(findings.length, 0);
});

// --- 57B-338: audit scoping (single-document mode) and partial-set robustness ---

async function multiFeatureRequest(features: Array<{ subject: string; aliases: string[] }>): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  return {
    target,
    codegraph: undefined,
    codegraphMode: "off",
    language: "zh-CN",
    detailLevel: "standard",
    workdir,
    overviewAudiences: [],
    features: features.map((feature) => ({ subject: feature.subject, aliases: feature.aliases, audiences: ["product"] as Audience[] })),
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 }
  };
}

// Author section 1 with an extra claim that binds a material work item, so the document genuinely covers it.

test("single-document audit rejects an unknown document id", async () => {
  const { runDir } = await prepareRun(await multiFeatureRequest([{ subject: "Leave management", aliases: ["leave"] }]));
  await assert.rejects(() => auditRun(runDir, { documentId: "no-such-document" }), /Unknown document/);
});

