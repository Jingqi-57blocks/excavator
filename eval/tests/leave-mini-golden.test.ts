// leave-mini golden depth + robustness guards (57B-365).
//
// Two layers, both pure (diffKnowledge is a function of Knowledge x Expected, no I/O, no model):
//   1. Real-artifact negative control: two fixated Knowledge extractions from real runs — a deep run
//      (dec-1, PASS side) and a shallow run (base-3, depth-red side). Asserts ONLY the depth-related
//      fields (found / mustFind-missing / attribution), never overall pass — the shallow run also carries
//      an independent forbidden false positive we deliberately do not pin here.
//   2. Wording-variant units: minimal synthetic Knowledge built from wordings harvested verbatim from the
//      6 real runs (table-fragment claims, "跳过扣减", "大于剩余", "无任何调用" vs a bare method-name list).
//      Guards that each depth / robustness pattern hits genuine deep phrasing and rejects shallow phrasing,
//      so synthetic test prose can never drift away from what authors actually write.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diffKnowledge } from "../diff.ts";
import { loadExpected } from "../expected.ts";
import type { EvidenceWindow, Knowledge, KnowledgeFact } from "../knowledge.ts";

const EXPECTED_FILE = join(import.meta.dirname, "..", "fixtures", "leave-mini", "expected-knowledge.json");
const RUNS_DIR = join(import.meta.dirname, "fixtures", "leave-mini-runs");
const expected = loadExpected(EXPECTED_FILE);

/** The three mustFind depth items; depth-l1-status-only is an optional observation and not gated here. */
const DEPTH_MUSTFIND = ["depth-terminal-immutable", "depth-transition-whitelist", "depth-restore-uncalled"];

function loadKnowledge(name: string): Knowledge {
  return JSON.parse(readFileSync(join(RUNS_DIR, name), "utf8")) as Knowledge;
}

// --- Layer 1: fixated real-run negative control ------------------------------------------------

test("deep run (dec-1): all mustFind depth items are found", () => {
  const diff = diffKnowledge(loadKnowledge("deep-dec1.knowledge.json"), expected);
  const foundIds = new Set(diff.found.map((entry) => entry.id));
  for (const id of DEPTH_MUSTFIND) {
    assert.ok(foundIds.has(id), `expected deep run to surface ${id}, but it was missing`);
  }
});

test("shallow run (base-3): depth-restore-uncalled is the UNIQUE mustFind miss, attributed authoring-miss", () => {
  const diff = diffKnowledge(loadKnowledge("shallow-base3.knowledge.json"), expected);
  const mustFindMissing = diff.missing.filter((entry) => entry.mustFind);
  // Robustness fixes cleared every table-fragment artifact, so the only mustFind red left in a real
  // shallow run is the genuine depth failure — this is the "eval 红 = 真失败" property, asserted directly.
  assert.deepEqual(
    mustFindMissing.map((entry) => entry.id).sort(),
    ["depth-restore-uncalled"],
    "the only genuine mustFind depth failure in the shallow run must be depth-restore-uncalled"
  );
  assert.equal(mustFindMissing[0].attribution, "authoring-miss", "the anchor file reached the horizon, so this is an authoring miss, not a prepare miss");
});

// --- Layer 2: wording-variant units (real phrasing harvested from the 6 runs) -------------------

function win(path: string): EvidenceWindow {
  return { id: "S-1", path, startLine: 1, endLine: 40 };
}

function fact(statement: string, path: string): KnowledgeFact {
  return { ref: "d#c", documentId: "d", claimId: "c", statement, marker: "fact", windows: [win(path)], citedEvidenceCount: 0, searchEvidence: [] };
}

function knowledgeWith(facts: KnowledgeFact[]): Knowledge {
  return { runDir: "(synthetic)", facts, relations: [], coverage: [], unknowns: [], prepareHorizon: { files: [], scopeText: "" } };
}

/** found | missing for one item id, given a single synthetic fact. Throws if the id is absent entirely. */
function outcome(statement: string, path: string, id: string): "found" | "missing" {
  const diff = diffKnowledge(knowledgeWith([fact(statement, path)]), expected);
  if (diff.found.some((entry) => entry.id === id)) return "found";
  if (diff.missing.some((entry) => entry.id === id)) return "missing";
  throw new Error(`item ${id} not present in diff`);
}

// Each row: [item id, anchor path, statement, expected outcome]. Statements are verbatim harvests.
const CASES: Array<[string, string, string, "found" | "missing"]> = [
  // depth-restore-uncalled — the one true discriminator: restore + explicit "no caller" investigation.
  ["depth-restore-uncalled", "src/balance.ts", "restore 提供归还但当前无任何调用者，见 src/balance.ts 第 18 到 29 行", "found"],
  ["depth-restore-uncalled", "src/balance.ts", "restore 归还方法无调用者", "found"],
  // Shallow phrasing: names restore in a method list but never investigated callers → must reject.
  ["depth-restore-uncalled", "src/balance.ts", "BalanceStore 内部用 Map 保存员工到剩余天数，提供 set、remaining、deduct、restore 四个方法", "missing"],

  // depth-terminal-immutable — the "terminal / immutable" insight itself.
  ["depth-terminal-immutable", "src/leave-request.ts", "驳回分支可从 pending 或 level1Approved 进入终态 rejected，且不扣减余额", "found"],

  // depth-transition-whitelist — table-driven state machine AND rejection of illegal transitions.
  ["depth-transition-whitelist", "src/leave-request.ts", "状态机以 TRANSITIONS 白名单约束转移，任何不在表内的转移都会被 canTransition 判为非法", "found"],
  // "there is a state machine" without the rejection proposition → reject (not deep enough).
  ["depth-transition-whitelist", "src/leave-request.ts", "本节说明申请状态机的完整生命周期", "missing"],

  // flow-balance-insufficient robustness: "大于剩余" was a false negative before widening P1.
  ["flow-balance-insufficient", "src/balance.ts", "扣减前校验库存是否充足，当申请 days 大于剩余天数时抛 BalanceError 并且不做部分扣减", "found"],

  // flow-unpaid-no-deduct robustness: "跳过扣减" was a false negative before widening P2.
  ["flow-unpaid-no-deduct", "src/approval.ts", "二级审批内按类型分流，unpaid 跳过扣减，annual 与 sick 按天数扣减", "found"],

  // authz-data-scope split: each rule now satisfies its own single-pattern item (table fragments no longer AND-killed).
  ["authz-scope-employee-self", "src/scope.ts", "数据范围由 canViewLeave 决定，员工只能查看自己提交的申请，见 src/scope.ts 第 8 到 15 行", "found"],
  ["authz-scope-manager-reports", "src/scope.ts", "经理只能查看其直接下属的申请，由 isDirectManagerOf 判定", "found"],

  // authz guards / roles: single-pattern forms tolerate fragmented labels.
  ["authz-l1-guard", "src/auth.ts", "必须是申请人的直属经理", "found"],
  ["authz-l2-guard", "src/auth.ts", "assertCanApproveLevel2 转 requireRole hr，src/auth.ts:27", "found"],
  ["authz-three-roles", "src/roles.ts", "角色等级由 RANK 定义为 employee 为一、manager 为二、hr 为三，hasRoleAtLeast 按等级比较", "found"]
];

for (const [id, path, statement, want] of CASES) {
  test(`wording: ${id} ${want} — ${statement.slice(0, 28)}…`, () => {
    assert.equal(outcome(statement, path, id), want);
  });
}
