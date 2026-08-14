import test from "node:test";
import assert from "node:assert/strict";
import { auditConditionCoverage, CONDITION_INVENTORY_VERSION, inventoryConditions, type ClaimStatement } from "../src/assurance/condition-inventory.ts";
import type { EvidenceItem } from "../src/core/types.ts";

const PATH = "svc/internal/handlers/leave/service.go";

function window(id: string, startLine: number, lines: string[], path = PATH): EvidenceItem {
  return {
    id,
    snapshotId: "snap1",
    kind: "source",
    title: id,
    path,
    startLine,
    endLine: startLine + lines.length - 1,
    content: lines.join("\n"),
    reason: "r",
    digest: "d",
  };
}

function claim(ref: string, statement: string, evidenceIds: string[]): ClaimStatement {
  return { ref, statement, evidenceIds };
}

// The real shape this exists for: the tiered-approval thresholds, surrounded by the noise classes that a
// repo-wide literal scan drowned in (existence guards, structural lengths, presentation constants, timestamps).
const APPROVE_WINDOW = window("S-approve", 505, [
  `	} else if lv.Hours > 16 && strings.Compare(lastAprv.ApproveFlow, constant.L1FlowF.String()) == 0 {`,
  `		if len(parts) != 3 {`,
  `			style.Font.Size = 14`,
  `		}`,
  `	} else if lv.Hours > 40 && record.Status == 3 {`,
  `		if query.Head < 1609430400 {`,
  `			total := 0`,
  `		}`,
]);

test("only domain-field literal comparisons enter the inventory; guards, structure and clocks are filtered", () => {
  const inventory = inventoryConditions([APPROVE_WINDOW], []);
  assert.equal(inventory.version, CONDITION_INVENTORY_VERSION);
  const expressions = inventory.items.map((item) => item.expression);
  assert.deepEqual(expressions, ["lv.Hours > 16", "lv.Hours > 40", "record.Status == 3"]);
  // Each of the excluded classes, named so a regression says which filter broke:
  assert.ok(!expressions.some((e) => e.includes("len(parts)")), "structural length is not a business rule");
  assert.ok(!expressions.some((e) => e.includes("Font.Size")), "presentation constant is not a business rule");
  assert.ok(!expressions.some((e) => e.includes("1609430400")), "a clock magnitude is not a business rule");
  assert.ok(!expressions.some((e) => /== 0\b/.test(e)), "an existence guard is not a business rule");
});

test("an HTTP status comparison is protocol handling, but a domain ordinal named status is not exempted", () => {
  const w = window("S-http", 10, [
    `	if JIRAResponse.status !== 200 {`,
    `	if record.status < 7 {`,
    `	if resp.StatusCode == 404 {`,
  ]);
  const expressions = inventoryConditions([w], []).items.map((item) => item.expression);
  assert.deepEqual(expressions, ["record.status < 7"], "only the domain ordinal survives");
});

test("absolute line numbers are computed from the window start, not the excerpt offset", () => {
  const inventory = inventoryConditions([APPROVE_WINDOW], []);
  const byExpression = new Map(inventory.items.map((item) => [item.expression, item]));
  assert.equal(byExpression.get("lv.Hours > 16")?.line, 505);
  assert.equal(byExpression.get("lv.Hours > 40")?.line, 509);
  assert.equal(byExpression.get("lv.Hours > 16")?.path, PATH);
  assert.equal(byExpression.get("lv.Hours > 16")?.field, "lv.Hours");
  assert.equal(byExpression.get("lv.Hours > 16")?.literal, "16");
});

test("a condition is consumed only when a claim citing that window states its literal", () => {
  const claims = [
    claim("doc#c1", "超过 16 小时的请假需要 L1 审批流。", ["S-approve"]),
    claim("doc#c2", "状态为 3 表示已批准。", ["S-other"]), // cites a different window
  ];
  const inventory = inventoryConditions([APPROVE_WINDOW], claims);
  const byExpression = new Map(inventory.items.map((item) => [item.expression, item]));
  assert.equal(byExpression.get("lv.Hours > 16")?.status, "consumed");
  assert.deepEqual(byExpression.get("lv.Hours > 16")?.consumedBy, ["doc#c1"]);
  assert.equal(byExpression.get("lv.Hours > 40")?.status, "unaccounted", "the 40h threshold was never stated");
  assert.equal(byExpression.get("record.Status == 3")?.status, "unaccounted", "a claim citing another window does not consume it");
  assert.equal(inventory.summary.total, 3);
  assert.equal(inventory.summary.consumed, 1);
  assert.equal(inventory.summary.unaccounted, 2);
});

test("a literal inside a longer number or identifier is not a mention", () => {
  const inventory = inventoryConditions([APPROVE_WINDOW], [
    claim("doc#c1", "阈值配置项 THRESHOLD_160 与 1640 均与此无关。", ["S-approve"]),
  ]);
  assert.equal(inventory.items.find((item) => item.expression === "lv.Hours > 16")?.status, "unaccounted");
});

test("the same condition reached through two overlapping windows is one item, consumed if either cites it", () => {
  const second = window("S-wide", 500, [
    ...Array.from({ length: 5 }, () => "// padding"),
    `	} else if lv.Hours > 16 && strings.Compare(lastAprv.ApproveFlow, constant.L1FlowF.String()) == 0 {`,
  ]);
  const inventory = inventoryConditions([APPROVE_WINDOW, second], [claim("doc#c1", "16 小时阈值。", ["S-wide"])]);
  const matching = inventory.items.filter((item) => item.expression === "lv.Hours > 16");
  assert.equal(matching.length, 1, "the same path:line:expression is one condition, not one per window");
  assert.equal(matching[0].status, "consumed");
});

test("only source windows with content are scanned", () => {
  const graph: EvidenceItem = { id: "G-1", snapshotId: "s", kind: "graph", title: "g", reason: "r", digest: "d", content: "x.Status == 3" };
  const noContent: EvidenceItem = { id: "S-empty", snapshotId: "s", kind: "source", title: "s", path: PATH, startLine: 1, endLine: 2, reason: "r", digest: "d" };
  assert.equal(inventoryConditions([graph, noContent], []).items.length, 0);
});

test("the advisory names the unaccounted conditions and states what it measures; silence when all consumed", () => {
  const unaccounted = inventoryConditions([APPROVE_WINDOW], []);
  const findings = auditConditionCoverage(unaccounted);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "warning", "extraction is a residual, never a blocking error in this generation");
  assert.equal(findings[0].document, "condition-coverage");
  assert.match(findings[0].message, /lv\.Hours > 40/);
  assert.match(findings[0].message, /measures extraction, not reading/);

  const allConsumed = inventoryConditions([APPROVE_WINDOW], [claim("doc#c1", "16、40 小时与状态 3 全部记录。", ["S-approve"])]);
  assert.equal(allConsumed.summary.unaccounted, 0);
  assert.deepEqual(auditConditionCoverage(allConsumed), []);
});

test("the inventory is byte-stable regardless of window order", () => {
  const second = window("S-b", 900, ["	if record.ItemType > 3 {"]);
  const a = inventoryConditions([APPROVE_WINDOW, second], []);
  const b = inventoryConditions([second, APPROVE_WINDOW], []);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
