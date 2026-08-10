import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditClaimReceiptSupport,
  extractMatchCounts,
  hasItemCount,
  matchesNegation,
  provableLowerBound
} from "../src/claim-receipt-support.ts";
import type { EvidenceItem, SearchReceipt, SectionClaim } from "../src/types.ts";

function receipt(overrides: Partial<SearchReceipt>): SearchReceipt {
  const matchCount = overrides.matches?.length ?? 0;
  return {
    searchVersion: "test",
    terms: ["x"],
    pathPrefixes: [],
    candidateFiles: 10,
    maxResults: 200,
    regex: false,
    caseSensitive: false,
    truncated: false,
    ...overrides,
    matches: overrides.matches ?? Array.from({ length: matchCount }, (_, i) => ({ path: `f${i}.ts`, line: i + 1, excerpt: "hit", matchedTerms: ["x"], score: 1 }))
  };
}

function withMatches(count: number, extra: Partial<SearchReceipt> = {}): SearchReceipt {
  return receipt({ matches: Array.from({ length: count }, (_, i) => ({ path: `f${i}.ts`, line: i + 1, excerpt: "hit", matchedTerms: ["x"], score: 1 })), ...extra });
}

function searchEvidence(id: string, data: SearchReceipt): EvidenceItem {
  return { id, snapshotId: "snap", kind: "search", title: `search ${id}`, data, reason: "test", digest: "d" };
}

function sourceEvidence(id: string): EvidenceItem {
  return { id, snapshotId: "snap", kind: "source", title: "src", path: "a.ts", startLine: 1, endLine: 2, content: "x", reason: "test", digest: "d" };
}

function claim(overrides: Partial<SectionClaim> & { statement: string }): SectionClaim {
  return { id: "claim-1", marker: "verified", evidenceIds: ["SEARCH-a"], ...overrides };
}

function audit(claims: SectionClaim[], evidence: EvidenceItem[], strict = true) {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  return auditClaimReceiptSupport({ documentId: "doc", sectionIndex: 3, claims, evidenceById, strict });
}

// ---------------------------------------------------------------------------
// Number extractor: positive controls
// ---------------------------------------------------------------------------

test("extractMatchCounts recognizes match-context counts (positive controls)", () => {
  const cases: Array<[string, number, string]> = [
    ["检索命中 136 处", 136, "exact"],
    ["不少于 122 处", 122, "lower"],
    ["超过 200 处", 200, "lower"],
    ["122+ matches", 122, "lower"],
    ["共 1,068 处", 1068, "exact"],
    ["命中 37", 37, "exact"]
  ];
  for (const [statement, value, qualifier] of cases) {
    const mentions = extractMatchCounts(statement);
    assert.equal(mentions.length, 1, `${statement} -> ${JSON.stringify(mentions)}`);
    assert.equal(mentions[0].value, value, statement);
    assert.equal(mentions[0].qualifier, qualifier, statement);
  }
});

test("extractMatchCounts classifies upper-bound and approximate qualifiers", () => {
  assert.equal(extractMatchCounts("不超过 50 处")[0].qualifier, "upper");
  assert.equal(extractMatchCounts("约 80 处")[0].qualifier, "approximate");
  assert.equal(extractMatchCounts("~64 matches")[0].qualifier, "approximate");
});

// ---------------------------------------------------------------------------
// Number extractor: negative controls (must NOT be read as a match count)
// ---------------------------------------------------------------------------

test("extractMatchCounts ignores non-match-context numbers (negative controls)", () => {
  for (const statement of ["3 处理器并发", "多处配置", "80% 覆盖", "共 12 个入口点", "第 3 章", "版本 2 已发布"]) {
    assert.deepEqual(extractMatchCounts(statement), [], statement);
  }
});

test("item-count detector separates 个/条/项 from match counts", () => {
  assert.ok(hasItemCount("共 12 个入口点"));
  assert.ok(hasItemCount("1,068 条声明"));
  assert.ok(hasItemCount("3 项检查"));
  assert.ok(!hasItemCount("命中 136 处"));
  assert.ok(!hasItemCount("覆盖率 80%"));
});

// ---------------------------------------------------------------------------
// Negation wordlist: positive AND negative controls (57B-358 honest-negation lesson)
// ---------------------------------------------------------------------------

test("matchesNegation accepts honest negative findings (positive controls)", () => {
  for (const statement of [
    "未发现相关调用",
    "未找到匹配项",
    "未见该配置",
    "该字段不存在",
    "没有命中任何路径",
    "无命中",
    "零命中",
    "共 0 处命中",
    "not found in the reviewed workspace",
    "no matches were recorded",
    "no occurrences of the flag",
    "none were observed",
    "the handler is absent",
    "the rule does not exist"
  ]) {
    assert.ok(matchesNegation(statement), statement);
  }
});

test("matchesNegation does not fire on neutral/positive statements (negative controls)", () => {
  for (const statement of [
    "该服务无状态地转发请求",
    "系统在登录路径上出现三处调用",
    "控制器负责处理登录流程",
    "该模块包含缓存层",
    "the controller handles the login flow",
    "several matches were recorded"
  ]) {
    assert.ok(!matchesNegation(statement), statement);
  }
});

test("provableLowerBound uses atLeast only when truncated", () => {
  assert.equal(provableLowerBound(withMatches(20)), 20);
  assert.equal(provableLowerBound(withMatches(20, { truncated: true, atLeast: 137 })), 137);
  assert.equal(provableLowerBound(withMatches(20, { truncated: true })), 20);
});

// ---------------------------------------------------------------------------
// Rule A matrix
// ---------------------------------------------------------------------------

test("Rule A: exact count matching a complete receipt passes", () => {
  const findings = audit([claim({ statement: "命中 136 处" })], [searchEvidence("SEARCH-a", withMatches(136))]);
  assert.deepEqual(findings, []);
});

test("Rule A: exact count disagreeing with a complete receipt is an error", () => {
  const findings = audit([claim({ statement: "命中 136 处" })], [searchEvidence("SEARCH-a", withMatches(120))]);
  assert.equal(findings.filter((f) => f.level === "error").length, 1, JSON.stringify(findings));
  assert.match(findings[0].message, /exact count of 136/);
});

test("Rule A: exact count against a truncated-only receipt is an error advising a lower bound", () => {
  const findings = audit([claim({ statement: "命中 136 处" })], [searchEvidence("SEARCH-a", withMatches(200, { truncated: true, atLeast: 400 }))]);
  assert.equal(findings.filter((f) => f.level === "error").length, 1, JSON.stringify(findings));
  assert.match(findings[0].message, /truncated/);
});

test("Rule A: lower bound within a single receipt passes", () => {
  const findings = audit([claim({ statement: "不少于 122 处" })], [searchEvidence("SEARCH-a", withMatches(137))]);
  assert.deepEqual(findings, []);
});

test("Rule A: lower bound landing in the receipt sum is a warning", () => {
  const findings = audit(
    [claim({ statement: "不少于 122 处", evidenceIds: ["SEARCH-a", "SEARCH-b"] })],
    [searchEvidence("SEARCH-a", withMatches(80)), searchEvidence("SEARCH-b", withMatches(70))]
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "warning");
  assert.match(findings[0].message, /summed across 2 receipts/);
});

test("Rule A: lower bound exceeding the receipt sum is an error", () => {
  const findings = audit(
    [claim({ statement: "不少于 300 处", evidenceIds: ["SEARCH-a", "SEARCH-b"] })],
    [searchEvidence("SEARCH-a", withMatches(80)), searchEvidence("SEARCH-b", withMatches(70))]
  );
  assert.equal(findings.filter((f) => f.level === "error").length, 1, JSON.stringify(findings));
  assert.match(findings[0].message, /prove at most 150/);
});

test("Rule A: exact count equal to the sum of complete receipts passes", () => {
  const findings = audit(
    [claim({ statement: "命中 150 处", evidenceIds: ["SEARCH-a", "SEARCH-b"] })],
    [searchEvidence("SEARCH-a", withMatches(80)), searchEvidence("SEARCH-b", withMatches(70))]
  );
  assert.deepEqual(findings, []);
});

test("Rule A: upper-bound and approximate wording are warnings only", () => {
  const upper = audit([claim({ statement: "不超过 50 处" })], [searchEvidence("SEARCH-a", withMatches(0))]);
  assert.equal(upper.length, 1);
  assert.equal(upper[0].level, "warning");
  assert.match(upper[0].message, /upper-bound/);
  const approx = audit([claim({ statement: "约 80 处" })], [searchEvidence("SEARCH-a", withMatches(0))]);
  assert.ok(approx.some((f) => f.level === "warning" && /approximate/.test(f.message)));
});

// ---------------------------------------------------------------------------
// Rule B
// ---------------------------------------------------------------------------

test("Rule B: verified claim citing a zero-match receipt with a negation passes", () => {
  const findings = audit([claim({ marker: "verified", statement: "未发现相关命中" })], [searchEvidence("SEARCH-a", withMatches(0))]);
  assert.deepEqual(findings, []);
});

test("Rule B: verified claim citing a zero-match receipt with neutral wording warns", () => {
  const findings = audit([claim({ marker: "verified", statement: "该登录路径存在授权校验" })], [searchEvidence("SEARCH-a", withMatches(0))]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "warning");
  assert.match(findings[0].message, /neither a negative finding nor a match count/);
});

test("Rule B: fact marker behaves the same as verified", () => {
  const findings = audit([claim({ marker: "fact", statement: "该登录路径存在授权校验" })], [searchEvidence("SEARCH-a", withMatches(0))]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "warning");
});

test("Rule B: inferred marker is not flagged", () => {
  const findings = audit([claim({ marker: "inferred", statement: "该登录路径存在授权校验" })], [searchEvidence("SEARCH-a", withMatches(0))]);
  assert.deepEqual(findings, []);
});

// ---------------------------------------------------------------------------
// Rule A2
// ---------------------------------------------------------------------------

test("Rule A2: all-SEARCH evidence asserting an item count warns", () => {
  const findings = audit([claim({ marker: "fact", statement: "共 12 个入口点" })], [searchEvidence("SEARCH-a", withMatches(5))]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "warning");
  assert.match(findings[0].message, /item count/);
});

test("Rule A2: does not fire when non-search evidence is also cited", () => {
  const findings = audit(
    [claim({ marker: "fact", statement: "共 12 个入口点", evidenceIds: ["SEARCH-a", "S-1"] })],
    [searchEvidence("SEARCH-a", withMatches(5)), sourceEvidence("S-1")]
  );
  assert.deepEqual(findings, []);
});

// ---------------------------------------------------------------------------
// Non-triggering shapes
// ---------------------------------------------------------------------------

test("claims with no SEARCH evidence never trigger the check", () => {
  const findings = audit([claim({ marker: "fact", statement: "命中 136 处", evidenceIds: ["S-1"] })], [sourceEvidence("S-1")]);
  assert.deepEqual(findings, []);
});

test("unavailable claims (no evidence) never trigger the check", () => {
  const findings = audit([{ id: "c", marker: "unavailable", statement: "命中 136 处", reason: "static review cannot answer" }], []);
  assert.deepEqual(findings, []);
});

// ---------------------------------------------------------------------------
// Version gate: Rule A errors become warnings for grandfathered runs
// ---------------------------------------------------------------------------

test("version gate: a Rule A error downgrades to a warning when strict is false", () => {
  const strictFindings = audit([claim({ statement: "命中 136 处" })], [searchEvidence("SEARCH-a", withMatches(120))], true);
  assert.equal(strictFindings[0].level, "error");
  const legacyFindings = audit([claim({ statement: "命中 136 处" })], [searchEvidence("SEARCH-a", withMatches(120))], false);
  assert.equal(legacyFindings.length, 1);
  assert.equal(legacyFindings[0].level, "warning");
  assert.equal(legacyFindings[0].message, strictFindings[0].message);
});

test("version gate: advisory (Rule B/A2) warnings stay warnings regardless of strict", () => {
  const b = audit([claim({ marker: "verified", statement: "该登录路径存在授权校验" })], [searchEvidence("SEARCH-a", withMatches(0))], false);
  assert.equal(b[0].level, "warning");
  const a2 = audit([claim({ marker: "fact", statement: "共 12 个入口点" })], [searchEvidence("SEARCH-a", withMatches(5))], false);
  assert.equal(a2[0].level, "warning");
});

// ---------------------------------------------------------------------------
// Real golden fixture: receipts + claims produced by the pipeline against the actual cebreo repo.
// See tests/fixtures/cebreo-receipt-support/README.md for provenance and the reproduction commands.
// ---------------------------------------------------------------------------

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cebreo-receipt-support");

test("golden fixture: real cebreo receipts — zero-match count errors, provable counts pass", () => {
  const evidence = (JSON.parse(readFileSync(join(fixtureDir, "evidence.json"), "utf8")) as { evidence: EvidenceItem[] }).evidence;
  const claimsFile = JSON.parse(readFileSync(join(fixtureDir, "claims.json"), "utf8")) as { claims: SectionClaim[] };
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));

  // Fixture integrity: the frozen receipts really reproduce the two cebreo shapes.
  const zero = evidenceById.get("SEARCH-5fa4a75ef122")!.data as SearchReceipt;
  const hasMatch = evidenceById.get("SEARCH-25309d9ce1e3")!.data as SearchReceipt;
  assert.equal(zero.matches.length, 0, "zero-match receipt must have no matches");
  assert.equal(zero.truncated, false);
  assert.ok(hasMatch.matches.length > 0 && !hasMatch.truncated, "has-match receipt must be a complete, provable count");

  const findings = auditClaimReceiptSupport({ documentId: "overview-engineering", sectionIndex: 1, claims: claimsFile.claims, evidenceById, strict: true });

  // cebreo #3: a large positive count citing the zero-match receipt is a hard error.
  assert.equal(findings.filter((f) => f.level === "error" && /claim-zero-count/.test(f.message)).length, 1, JSON.stringify(findings, null, 2));

  // The complete receipt supports both an exact count == matches.length and a lower bound below it.
  const exactClaim = claimsFile.claims.find((c) => c.id === "claim-hasmatch-exact")!;
  assert.ok(exactClaim.statement.includes(String(hasMatch.matches.length)), "exact claim states the receipt's real match count (derived from the fixture, not hardcoded)");
  assert.ok(!findings.some((f) => /claim-hasmatch-exact/.test(f.message)), JSON.stringify(findings, null, 2));
  assert.ok(!findings.some((f) => /claim-hasmatch-lower/.test(f.message)), JSON.stringify(findings, null, 2));
});
