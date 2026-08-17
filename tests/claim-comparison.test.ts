import test from "node:test";
import assert from "node:assert/strict";
import { auditComparativeClaims, comparativeWording, validateComparisonSides } from "../src/assurance/claim-comparison.ts";
import { validateClaimsInput } from "../src/assurance/section-audit.ts";
import type { EvidenceItem, SectionClaim } from "../src/base/types.ts";

// Synthetic-only identifiers throughout: never a real target repo/route/table name.
const MULTI_ROOTS = ["service-a", "service-b"];

function claim(partial: Partial<SectionClaim> & Pick<SectionClaim, "id" | "marker" | "statement">): SectionClaim {
  return { ...partial };
}

function evidence(id: string, path?: string): EvidenceItem {
  return { id, snapshotId: "snap", kind: path ? "source" : "search", title: id, path, reason: "test", digest: "d" };
}

function evidenceMap(items: EvidenceItem[]): Map<string, EvidenceItem> {
  return new Map(items.map((item) => [item.id, item]));
}

function audit(options: {
  claims: SectionClaim[];
  evidence: EvidenceItem[];
  multiRoot?: boolean;
  roots?: string[];
}) {
  return auditComparativeClaims({
    documentId: "doc",
    sectionIndex: 4,
    claims: options.claims,
    evidenceById: evidenceMap(options.evidence),
    multiRoot: options.multiRoot ?? true,
    roots: options.roots ?? MULTI_ROOTS
  });
}

// --- Positive: single-sided equivalence must warn -------------------------------------------------

test("warns on a fact equivalence citing one file under a single root", () => {
  const findings = audit({
    claims: [claim({ id: "c1", marker: "fact", statement: "service-a and service-b share the same thresholds", evidenceIds: ["S-a"] })],
    evidence: [evidence("S-a", "service-a/internal/constant.go")]
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "warning");
  assert.match(findings[0].message, /c1/);
  assert.match(findings[0].message, /single source unit/);
});

test("warns on an intra-root cross-file comparison that declares no sides", () => {
  const findings = audit({
    claims: [claim({ id: "c2", marker: "fact", statement: "the frontend enum stays consistent with the backend", evidenceIds: ["S-fe", "S-be"] })],
    evidence: [evidence("S-fe", "service-a/frontend/enum.ts"), evidence("S-be", "service-a/backend/enum.ts")]
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "warning");
});

test("comparativeWording matches the bilingual positive phrasings", () => {
  assert.ok(comparativeWording("service-a and service-b share the same thresholds"));
  assert.ok(comparativeWording("the frontend enum stays consistent with the backend"));
  assert.ok(comparativeWording("v2 与遗留实现共享同一批数值阈值"));
  assert.ok(comparativeWording("前端枚举与 v2 后端保持一致"));
});

// --- 57B-354 #6b: comparison CONTEXT is required, not a bare noun-compound substring --------------

test("comparativeWording fires only on cross-source comparison context", () => {
  // Positives: real single-sided-fact defects the advisory must still catch.
  for (const positive of [
    "v2 与遗留实现共享同一批数值阈值",
    "遗留 wcp service 与 v2 共享 16 与 40 小时分级阈值",
    "前端枚举 LeaveStatus 与 v2 后端保持一致"
  ]) assert.ok(comparativeWording(positive), `expected a match: ${positive}`);

  // Negatives: ordinary compounds that read comparative but assert no cross-source equivalence.
  for (const negative of [
    "共享读取",
    "同一天",
    "同一自然日",
    "同一员工",
    "保持一致性",
    "相邻耦合",
    "相互对应",
    "行为一致性"
  ]) assert.equal(comparativeWording(negative), false, `expected no match: ${negative}`);
});

// --- Structural: malformed sides must error / throw -----------------------------------------------

const STRUCTURAL_CASES: Array<{ name: string; claim: SectionClaim }> = [
  { name: "one group", claim: claim({ id: "s1", marker: "fact", statement: "a equals b", evidenceIds: ["S-a"], sides: [["S-a"]] }) },
  { name: "empty group", claim: claim({ id: "s2", marker: "fact", statement: "a equals b", evidenceIds: ["S-a", "S-b"], sides: [["S-a"], []] }) },
  { name: "id shared across two groups", claim: claim({ id: "s3", marker: "fact", statement: "a equals b", evidenceIds: ["S-a", "S-b"], sides: [["S-a", "S-b"], ["S-b"]] }) },
  { name: "id not in evidenceIds", claim: claim({ id: "s4", marker: "fact", statement: "a equals b", evidenceIds: ["S-a"], sides: [["S-a"], ["S-x"]] }) },
  { name: "unavailable claim carrying sides", claim: claim({ id: "s5", marker: "unavailable", statement: "cannot compare a and b", reason: "no evidence", sides: [["S-a"], ["S-b"]] }) }
];

for (const { name, claim: bad } of STRUCTURAL_CASES) {
  test(`validateComparisonSides reports a violation: ${name}`, () => {
    assert.ok(validateComparisonSides(bad).length > 0);
  });

  test(`validateClaimsInput throws at checkpoint: ${name}`, () => {
    assert.throws(() => validateClaimsInput("doc", 4, [bad]), /comparison sides/i);
  });

  test(`auditComparativeClaims emits an error finding: ${name}`, () => {
    const findings = audit({ claims: [bad], evidence: [evidence("S-a", "service-a/x.ts"), evidence("S-b", "service-b/y.ts")] });
    assert.ok(findings.some((finding) => finding.level === "error" && finding.message.includes(bad.id)));
  });
}

test("a well-formed two-side grouping passes validateComparisonSides and validateClaimsInput", () => {
  const good = claim({ id: "ok", marker: "fact", statement: "a equals b", evidenceIds: ["S-a", "S-b"], sides: [["S-a"], ["S-b"]] });
  assert.deepEqual(validateComparisonSides(good), []);
  assert.doesNotThrow(() => validateClaimsInput("doc", 4, [good]));
});

test("an absent sides field is always valid", () => {
  assert.deepEqual(validateComparisonSides(claim({ id: "n", marker: "fact", statement: "a equals b", evidenceIds: ["S-a"] })), []);
});

// --- Negative controls: must NOT warn (bounding false positives) ----------------------------------

test("does not warn on `统一`/`unified` single-source facts (not a comparison)", () => {
  assert.equal(comparativeWording("both route groups mount the unified auth middleware"), false);
  assert.equal(comparativeWording("均挂载统一鉴权中间件"), false);
  const findings = audit({
    claims: [claim({ id: "u", marker: "fact", statement: "both route groups mount the unified auth middleware", evidenceIds: ["S-u"] })],
    evidence: [evidence("S-u", "service-a/router.ts")]
  });
  assert.deepEqual(findings, []);
});

test("does not warn on the `一致性` noun (a quality, not a cross-source claim)", () => {
  assert.equal(comparativeWording("transactional consistency is provided by the database"), false);
  assert.equal(comparativeWording("数据库提供事务一致性"), false);
  const findings = audit({
    claims: [claim({ id: "cn", marker: "fact", statement: "transactional consistency is provided by the database", evidenceIds: ["S-db"] })],
    evidence: [evidence("S-db", "service-a/db.ts")]
  });
  assert.deepEqual(findings, []);
});

test("does not warn on a comparative fact whose evidence spans two roots", () => {
  const findings = audit({
    claims: [claim({ id: "two", marker: "fact", statement: "service-a and service-b share the same thresholds", evidenceIds: ["S-a", "S-b"] })],
    evidence: [evidence("S-a", "service-a/const.go"), evidence("S-b", "service-b/const.js")]
  });
  assert.deepEqual(findings, []);
});

test("does not warn on a same-root cross-file comparison that declares valid sides", () => {
  const findings = audit({
    claims: [claim({ id: "declared", marker: "fact", statement: "the frontend enum stays consistent with the backend", evidenceIds: ["S-fe", "S-be"], sides: [["S-fe"], ["S-be"]] })],
    evidence: [evidence("S-fe", "service-a/frontend/enum.ts"), evidence("S-be", "service-a/backend/enum.ts")]
  });
  assert.deepEqual(findings, []);
});

test("does not warn on an inferred single-source comparative sentence", () => {
  const findings = audit({
    claims: [claim({ id: "inf", marker: "inferred", statement: "service-a and service-b likely share the same thresholds", evidenceIds: ["S-a"] })],
    evidence: [evidence("S-a", "service-a/const.go")]
  });
  assert.deepEqual(findings, []);
});

test("does not warn on a comparative fact citing only non-path evidence", () => {
  const findings = audit({
    claims: [claim({ id: "np", marker: "fact", statement: "service-a and service-b share the same thresholds", evidenceIds: ["SEARCH-1", "CG-1"] })],
    evidence: [evidence("SEARCH-1"), evidence("CG-1")]
  });
  assert.deepEqual(findings, []);
});

// --- Single-root mode: a "side" is a file --------------------------------------------------------

test("in single-root mode a two-file comparison is two sides (no warning)", () => {
  const findings = audit({
    claims: [claim({ id: "sr", marker: "fact", statement: "handler A stays consistent with handler B", evidenceIds: ["S-1", "S-2"] })],
    evidence: [evidence("S-1", "src/a.ts"), evidence("S-2", "src/b.ts")],
    multiRoot: false,
    roots: []
  });
  assert.deepEqual(findings, []);
});

test("in single-root mode a single-file comparison warns", () => {
  const findings = audit({
    claims: [claim({ id: "sr1", marker: "fact", statement: "handler A stays consistent with handler B", evidenceIds: ["S-1"] })],
    evidence: [evidence("S-1", "src/a.ts")],
    multiRoot: false,
    roots: []
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "warning");
});
