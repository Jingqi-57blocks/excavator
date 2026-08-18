import test from "node:test";
import assert from "node:assert/strict";
import { auditConditionCoverage, CONDITION_INVENTORY_VERSION, inventoryConditions, type ClaimStatement } from "../src/investigation/condition-inventory.ts";
import type { EvidenceItem } from "../src/base/types.ts";

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
  `			if style.Font.Size > 14 {`,
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

test("structural terms are camelCase-anchored: a discount or price index survives, a row count does not", () => {
  const w = window("S-anchor", 100, [
    `	if order.discount > 30 {`,      // 'count' inside a lowercase word — a real discount threshold
    `	if priceIndex > 900 {`,          // a domain index, not an array index
    `	if rowCount > 5 {`,              // camelCase tail — structural
    `	if searchDepth < 15 {`,          // camelCase tail — structural
    `	if style.Font.Size > 14 {`,      // presentation
  ]);
  assert.deepEqual(
    inventoryConditions([w], []).items.map((item) => item.expression),
    ["order.discount > 30", "priceIndex > 900"],
  );
});

test("the magnitude cut keeps money/quota ceilings and still drops clock and id magnitudes", () => {
  const w = window("S-mag", 200, [
    `	if amount > 500000 {`,           // a real ceiling
    `	if query.Head < 1609430400 {`,   // epoch seconds
    `	if userID == 123456789012 {`,    // generated id
  ]);
  assert.deepEqual(inventoryConditions([w], []).items.map((item) => item.expression), ["amount > 500000"]);
});

test("a literal inside a decimal or a fraction is not a mention (false green is worse than false red)", () => {
  const consumedBy = (statement: string): string[] =>
    inventoryConditions([APPROVE_WINDOW], [claim("doc#c1", statement, ["S-approve"])])
      .items.find((item) => item.expression === "lv.Hours > 16")?.consumedBy ?? [];
  assert.deepEqual(consumedBy("平均耗时 16.5 小时"), [], "16.5 does not state the 16h threshold");
  assert.deepEqual(consumedBy("比例为 3/16 左右"), [], "a fraction denominator does not state it either");
  assert.deepEqual(consumedBy("超过 16 小时需 L1 审批"), ["doc#c1"], "the bare literal still counts");
});

test("consumedBy is the union across overlapping windows, independent of window order", () => {
  const wide = window("S-wide2", 500, [
    ...Array.from({ length: 5 }, () => "// padding"),
    `	} else if lv.Hours > 16 && strings.Compare(lastAprv.ApproveFlow, constant.L1FlowF.String()) == 0 {`,
  ]);
  const claims = [claim("doc#a", "16 小时阈值(窗口一)。", ["S-approve"]), claim("doc#b", "16 小时阈值(窗口二)。", ["S-wide2"])];
  for (const order of [[APPROVE_WINDOW, wide], [wide, APPROVE_WINDOW]]) {
    const item = inventoryConditions(order, claims).items.find((entry) => entry.expression === "lv.Hours > 16")!;
    assert.deepEqual(item.consumedBy, ["doc#a", "doc#b"], "both citing claims are kept, whichever window is seen first");
  }
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

// A string enum value must be a token in the statement, not a substring of an unrelated word. Plain
// containment made "The configuration loads once." consume `mode === "on"` — a false green, which is worse
// than a false red because it inflates the very consume bucket the attribution funnel steers by.
test("a string enum value is not consumed by a longer word that merely contains it", () => {
  const modes = window("S-modes", 700, [`	if (settings.mode === "on") { start(); }`, `	if (settings.view === "open") { list(); }`]);
  const bystander = inventoryConditions([modes], [
    claim("doc#c1", "The configuration loads once, then open_positions is rendered.", ["S-modes"]),
  ]);
  assert.equal(bystander.summary.consumed, 0, "'on' ⊄ 'configuration' and 'open' ⊄ 'open_positions'");

  const stated = inventoryConditions([modes], [
    claim("doc#c2", "mode 为 on 时启动；view 为 open 时展示列表。", ["S-modes"]),
  ]);
  assert.equal(stated.summary.consumed, 2, "a CJK or punctuation neighbour is still a real mention");
});

// The value-set residual is a second, separate advisory: a field can have every individual comparison
// consumed in prose and still never have its SET stated, which is how a report describes one mode and
// leaves the others invisible.
test("a value set no claim fully states raises its own advisory, and silence once stated", () => {
  const views = window("S-views", 40, [
    `	if repr.View == "open_positions" {`,
    `	} else if repr.View == "delayed_positions" {`,
  ]);
  const unstated = auditConditionCoverage(inventoryConditions([views], []));
  const valueSet = unstated.filter((finding) => finding.message.includes("value-set residual"));
  assert.equal(valueSet.length, 1);
  assert.equal(valueSet[0].level, "warning");
  assert.match(valueSet[0].message, /repr\.View ∈ \{delayed_positions, open_positions\}/, "values are sorted, not source-ordered — the artifact must be byte-stable");

  const stated = inventoryConditions([views], [
    claim("doc#c1", "视图取值为 open_positions 与 delayed_positions 两种。", ["S-views"]),
  ]);
  assert.equal(stated.families[0].status, "consumed");
  assert.equal(auditConditionCoverage(stated).filter((f) => f.message.includes("value-set residual")).length, 0);
});

test("the inventory is byte-stable regardless of window order", () => {
  const second = window("S-b", 900, ["	if record.ItemType > 3 {"]);
  const a = inventoryConditions([APPROVE_WINDOW, second], []);
  const b = inventoryConditions([second, APPROVE_WINDOW], []);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
