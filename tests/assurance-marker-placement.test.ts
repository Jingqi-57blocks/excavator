import test from "node:test";
import assert from "node:assert/strict";
import { auditEvidenceMarkerPlacement, auditSectionClaims, auditSectionEvidenceMarkers, substantiveSegments } from "../src/assurance/section-audit.ts";
import type { Audience, DocumentKind, DocumentPlan, SectionClaimsFile } from "../src/base/types.ts";

function doc(kind: DocumentKind = "feature", audience: Audience = "product"): DocumentPlan {
  return { id: `${kind}-${audience}`, kind, audience, templatePath: "", contextPath: "", sections: [] };
}

function placement(document: DocumentPlan, sectionIndex: number, sectionText: string) {
  return auditEvidenceMarkerPlacement({ document, sectionIndex, sectionText });
}

// --- advisory triggers: each stranded marker line yields exactly one warning (never an error) ---

// A CJK "证据级别：`事实`" label stranded on its own paragraph between two normal body paragraphs.
const CJK_LEAD_IN_LINE =
  "## 登录流程\n\n用户在提交凭证后进入账户登录的校验阶段。\n\n证据级别：`事实`。\n\n系统随后返回会话令牌并记录审计日志。\n";
// An English "Evidence level: `fact`" lead-in on its own line.
const EN_LEAD_IN_LINE =
  "## Authentication\n\nThe user submits credentials and the service issues a session token.\n\nEvidence level: `fact`\n\nThe system then records an audit entry for the login attempt.\n";
// A bare marker occupying a line by itself.
const BARE_MARKER_LINE =
  "## Inference note\n\n系统依据调用图判断该分支不会被触发。\n\n`推断`\n\n后续版本可能显式移除该分支。\n";

test("a marker or lead-in stranded on its own line warns exactly once and never errors", () => {
  const cases: Array<[string, string]> = [
    ["cjk lead-in", CJK_LEAD_IN_LINE],
    ["english lead-in", EN_LEAD_IN_LINE],
    ["bare marker", BARE_MARKER_LINE]
  ];
  for (const [label, sectionText] of cases) {
    const document = doc();
    const findings = placement(document, 3, sectionText);
    assert.equal(findings.length, 1, label);
    assert.equal(findings[0].level, "warning", label);
    assert.notEqual(findings[0].level, "error", label);
    assert.equal(findings[0].document, document.id, label);
    assert.match(findings[0].message, /on its own line or behind an "Evidence level:" lead-in/, label);
  }
});

// --- advisory silent: a marker attached to its statement, cell, or a collapsed evidence block ---

// The marker rides at the end of the statement it qualifies, on the same visible line.
const INLINE_TRAILING =
  "## 终审扣减\n\n用户提交后交由 approveLevel2 终审并扣减余额。`事实`\n";
// The marker sits in a dedicated level column of a Markdown table.
const TABLE_LEVEL_COLUMN =
  "## 操作与证据\n\n| 操作 | 说明 | 证据级别 |\n| --- | --- | --- |\n| 登录 | 校验凭证并签发令牌 | `事实` |\n| 登出 | 失效当前会话 | `验证` |\n";
// A marker living only inside a collapsed evidence block: `visibleText` strips <details>, so it is
// not part of the reading flow the advisory inspects.
const MARKER_IN_DETAILS =
  "## 证据附录\n\n登录流程在提交凭证后完成会话签发。\n\n<details><summary>证据</summary>\n\n`事实`\n\n来源：src/auth.ts:12\n</details>\n";

test("an attached marker in the reading flow, a table cell, or a collapsed block draws no finding", () => {
  const document = doc();
  assert.deepEqual(placement(document, 3, INLINE_TRAILING), [], "inline trailing");
  assert.deepEqual(placement(document, 3, TABLE_LEVEL_COLUMN), [], "table level column");
  assert.deepEqual(placement(document, 3, MARKER_IN_DETAILS), [], "marker inside <details>");
});

// --- regression pins: the advisory (#2) does not disturb the hard claim/marker accounting path ---

test("an inline-trailing statement with its claim clears auditSectionClaims and auditSectionEvidenceMarkers", () => {
  const document = doc();
  const sectionIndex = 4;
  // The section cites S-abc123def4 in an evidence comment; the claim declares the same id and marker.
  const sectionText =
    "## 终审扣减\n\n用户提交后交由 approveLevel2 终审并扣减余额。`事实`\n\n<!--E:S-abc123def4-->\n";
  const evidenceIds = new Set(["S-abc123def4"]);
  const claimsFile: SectionClaimsFile = {
    version: 2,
    documentId: document.id,
    section: sectionIndex,
    claims: [
      {
        id: "C1",
        marker: "fact",
        statement: "用户提交后交由 approveLevel2 终审并扣减余额",
        evidenceIds: ["S-abc123def4"],
        status: "verified",
        confidence: "high"
      }
    ]
  };
  // The sentence-end marker is still tabulated: the claim binds and the evidence reconciles, no findings.
  assert.deepEqual(
    auditSectionClaims({ documentId: document.id, sectionIndex, sectionText, claimsFile, evidenceIds }),
    []
  );
  // The section still carries a visible marker, so the strict per-section marker audit is clean.
  assert.deepEqual(
    auditSectionEvidenceMarkers({ documentId: document.id, sectionIndex, sectionText, strict: true }),
    []
  );
  // And the advisory itself stays silent on the attached marker.
  assert.deepEqual(placement(document, sectionIndex, sectionText), []);
});

test("a stranded '证据级别：`事实`' segment is non-substantive: it yields no substantive segment", () => {
  // After stripping the marker the residue is 证据级别 (4 semantic chars < 8), so it never becomes a
  // substantive segment and demands no claim — the advisory's target line does not break claim accounting.
  const sectionText = "## 证据级别\n\n证据级别：`事实`\n";
  assert.deepEqual(substantiveSegments(sectionText), []);
});
