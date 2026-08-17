import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { auditTraces } from "../src/assurance/assurance.ts";
import { auditRescuedLogicCoverage } from "../src/assurance/section-audit.ts";
import { collectClaims } from "../src/assurance/assurance-artifacts.ts";
import type { DocumentPlan, EvidenceItem, SectionClaim, TraceCatalog } from "../src/base/types.ts";
import { tempDir } from "./helpers.ts";

// TWO CHECKS THAT WERE MEASURING SOMETHING OTHER THAN WHAT THEY PROMISED.
//
// 1. The rescued-logic advisory searched the report text for an identifier, while `writing-rules.md` tells
//    authors the opposite — "The prose need not contain the identifier — the coverage ledger binds through
//    the cited evidence." On a real run it warned about five items that were all properly disposed, and the
//    author silenced it by stuffing identifiers into a collapsed block. An advisory that fires when the
//    documented practice is followed teaches people to ignore advisories.
// 2. `collectClaims` keyed on the claim id alone, but ids are unique only within a section. A run with 472
//    claims across 12 sections reported 81 — the number that becomes `metrics.claims` and feeds `eval
//    compare`. Fixing the key then endangers `auditTraces`, which compares against BARE ids; that hazard is
//    the third test here, and the suite could not see it before it was written.

function logicEvidence(items: Array<{ name: string; filePath: string; line: number; signal: string }>): EvidenceItem[] {
  return [{
    id: "FACT-logic", snapshotId: "s", kind: "structured", title: "logic", reason: "r", digest: "d",
    data: { category: "logic", items },
  } as unknown as EvidenceItem];
}

const ITEM = { name: "recordTakeLeaveHours", filePath: "wcp-service/services/leaveService.js", line: 139, signal: "rescued" };

function claim(overrides: Partial<SectionClaim>): SectionClaim {
  return { id: "claim-1", kind: "fact", statement: "s", evidenceIds: [], ...overrides } as SectionClaim;
}

const DISPOSED = `feature:k:logic:${ITEM.name}@${ITEM.filePath}:${ITEM.line}`;

test("a rescued item disposed by a claim is covered, even when the prose never names it", () => {
  const report = "本章说明请假小时数如何按年度扣减，具体规则见折叠证据块。";
  assert.deepEqual(auditRescuedLogicCoverage("doc", report, logicEvidence([ITEM]), [claim({ workItemIds: [DISPOSED] })], "k"), [],
    "the contract binds through the ledger, so the check must read the ledger");
});

// The id is matched WHOLE. A suffix match drops the feature key, and then — measured while writing this —
// one feature's disposition silences another feature's rescued item in a multi-feature run. A silenced real
// miss is strictly worse than a false warning, so this is the collision that decides the matching rule.
test("another feature's disposition does not cover this feature's item", () => {
  const otherFeature = claim({ workItemIds: [`feature:OTHER:logic:${ITEM.name}@${ITEM.filePath}:${ITEM.line}`] });
  const findings = auditRescuedLogicCoverage("doc", "无关正文。", logicEvidence([ITEM]), [otherFeature], "k");
  assert.equal(findings.length, 1, "same name, same file, same line — different feature");
});

test("without a feature key the binding path stays closed rather than matching loosely", () => {
  const findings = auditRescuedLogicCoverage("doc", "无关正文。", logicEvidence([ITEM]), [claim({ workItemIds: [DISPOSED] })], "");
  assert.equal(findings.length, 1, "no key means no exact id to check against; the text fallback still applies");
});

test("a rescued item nothing disposed and nothing names is still reported", () => {
  const findings = auditRescuedLogicCoverage("doc", "报告完全没提这件事。", logicEvidence([ITEM]), [], "k");
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /1 rescued logic fact/);
  assert.equal(findings[0].level, "warning", "advisory, as it has always been");
});

// The fallback stays: a report that names the item is covered even with no claim binding, which keeps every
// run that predates work-item ids passing exactly as before.
test("naming the item in the report still counts, so older runs are unaffected", () => {
  assert.deepEqual(auditRescuedLogicCoverage("doc", `见 ${ITEM.name} 的实现。`, logicEvidence([ITEM]), [], "k"), []);
});

test("a claim disposing a different item does not cover this one", () => {
  const other = claim({ workItemIds: ["feature:k:logic:somethingElse@other/file.js:10"] });
  assert.equal(auditRescuedLogicCoverage("doc", "无关正文。", logicEvidence([ITEM]), [other], "k").length, 1);
});

// --- claim counting ---

async function runWithClaims(sections: Array<{ index: number; claims: SectionClaim[] }>): Promise<{ documents: DocumentPlan[]; runDir: string }> {
  const runDir = await tempDir();
  await mkdir(join(runDir, "claims"), { recursive: true });
  const document = {
    id: "feature-k-engineering", kind: "feature", audience: "engineering", subject: "Leave",
    templatePath: "/tmp/t.md", contextPath: "/tmp/c.md",
    sections: sections.map((section) => ({
      index: section.index, title: `S${section.index}`, file: join(runDir, `${section.index}.md`),
      claimsFile: join(runDir, "claims", `${section.index}.json`), complete: true,
    })),
  } as unknown as DocumentPlan;
  for (const section of sections) {
    await writeFile(join(runDir, "claims", `${section.index}.json`), JSON.stringify({ version: 2, documentId: document.id, section: section.index, claims: section.claims }));
  }
  return { documents: [document], runDir };
}

// Every section numbers its claims from 1, so an id-keyed map collapses the run into one section's worth.
test("claims are counted per section, not collapsed by a shared id", async () => {
  const { documents, runDir } = await runWithClaims([
    { index: 1, claims: [claim({ id: "claim-1" }), claim({ id: "claim-2" })] },
    { index: 2, claims: [claim({ id: "claim-1" }), claim({ id: "claim-2" }), claim({ id: "claim-3" })] },
  ]);
  const claims = await collectClaims(runDir, documents);
  assert.equal(claims.size, 5, "two sections of 2 and 3 are five claims, not three");
  assert.ok(claims.has("feature-k-engineering#1#claim-1"));
  assert.ok(claims.has("feature-k-engineering#2#claim-1"), "same id, different section, both kept");
});

// The hazard the fix creates, which the suite could not see until this test existed: a trace step cites a
// claim by its BARE id, so handing it the composite keys would report every legitimate citation as missing.
test("trace citations are checked against bare claim ids, not the composite keys", async () => {
  const { documents, runDir } = await runWithClaims([{ index: 1, claims: [claim({ id: "claim-1" })] }]);
  const collected = await collectClaims(runDir, documents);
  const traces = {
    version: 1,
    traces: [{
      id: "TRACE-1", title: "t", kind: "call", status: "verified", documentIds: ["feature-k-engineering"],
      steps: [{ index: 1, action: "a", location: "l", evidenceIds: [], claimIds: ["claim-1"] }],
    }],
  } as unknown as TraceCatalog;

  const bare = new Set([...collected.values()].map((entry) => entry.id));
  assert.deepEqual(
    auditTraces(traces, new Set(["feature-k-engineering"]), new Set(), bare).filter((finding) => /missing claim id/.test(finding.message)),
    [], "a real citation resolves",
  );

  const composite = new Set(collected.keys());
  const broken = auditTraces(traces, new Set(["feature-k-engineering"]), new Set(), composite);
  assert.equal(broken.filter((finding) => /missing claim id/.test(finding.message)).length, 1,
    "and passing the composite keys instead would break every citation — which is why the call site converts");
});
