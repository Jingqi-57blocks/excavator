// Claims-layer rule-coverage red baseline for the WCP leave feature (57B-374).
//
// The measured object is the CLAIMS / report layer: extractKnowledge over a run's claims/*.json, diffed
// by diffKnowledge (a pure function of Knowledge x Expected — no I/O, no model) against the hand-built
// expected-knowledge gold. This is one layer below the FG boundary gold (57B-370) and the fact-pack gold
// (57B-372): here the source is in scope AND in the fact pack, yet the author never wrote the rule into
// claims. This file pins that red as a green CI test using two FROZEN real-run knowledge fixtures — no run
// directories at test time.
//
// Two layers, both pure:
//   1. Frozen real-run readings: the C1v2 (red) and C1 00:50 (green) runs, extracted once and committed
//      gzipped. Asserts the exact reality — which T1 rules miss and with what attribution, that the T3
//      frontend rules are prepare-misses, that the forbidden pin fires on the wrong cron claims (red) and
//      stays silent on the correct wording (green), and that the T2 sentinels are all still green.
//   2. Forbidden-pin discriminator units: minimal synthetic Knowledge from wordings harvested verbatim from
//      the real runs, guarding that the pin fires on the C1v2 "disabled/unregistered Node job" framing,
//      exempts a claim that also cites the Go cron (unless), and never even matches the green 注释停用 wording.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { diffKnowledge, type Diff } from "../diff.ts";
import { loadExpected } from "../expected.ts";
import { loadKnowledgeFixture } from "../knowledge-fixture.ts";
import type { Knowledge, KnowledgeFact } from "../knowledge.ts";

const FX = join(import.meta.dirname, "..", "fixtures", "wcp-leave");
const expected = loadExpected(join(FX, "expected-knowledge.json"));
const red = loadKnowledgeFixture(join(FX, "knowledge-C1v2-red.json.gz"));
const green = loadKnowledgeFixture(join(FX, "knowledge-C1-green.json.gz"));

const T1 = ["T1-preview-hours", "T1-natural-vs-working-day", "T1-autocomplete-cron"];
const T3 = ["T3-ui-apply-form", "T3-ui-approval-actions", "T3-ui-export-request"];
const T2 = [
  "T2-approval-thresholds",
  "T2-approval-chain",
  "T2-balance-deduct-by-type",
  "T2-permission-approve",
  "T2-permission-quota-edit",
  "T2-withdraw-eligibility",
  "T2-cancelleave-eligibility",
  "T2-latam-pto-caps",
  "T2-notification-next-approver"
];

const attributionOf = (diff: Diff) => new Map(diff.missing.map((m) => [m.id, m.attribution] as const));
const foundIds = (diff: Diff) => new Set(diff.found.map((f) => f.id));

// --- Layer 1a: RED reading (C1v2) --------------------------------------------------------------

const redDiff = diffKnowledge(red, expected);

test("RED fixture is the frozen C1v2 run", () => {
  assert.match(red.runDir, /run-2026_08_12_13_47-.*-28d5edde$/, "red fixture must be the C1v2 run directory");
});

test("RED: all 3 T1 rules miss with attribution authoring-miss (source is in the fact pack, so this is an authoring miss)", () => {
  const attr = attributionOf(redDiff);
  for (const id of T1) {
    assert.equal(attr.get(id), "authoring-miss", `${id} must be a mustFind authoring-miss in the red run`);
  }
});

test("RED: the 3 T3 frontend rules miss with attribution prepare-miss (frontend not in the prepared horizon)", () => {
  const attr = attributionOf(redDiff);
  for (const id of T3) {
    assert.equal(attr.get(id), "prepare-miss", `${id} must be a prepare-miss in the red run`);
  }
});

test("RED: the forbidden pin fires on the wrong disabled-Node auto-complete claims", () => {
  assert.equal(redDiff.forbiddenHits.length, 3, "expected exactly the 3 C1v2 disabled-Node auto-complete claims to fire");
  for (const hit of redDiff.forbiddenHits) {
    assert.equal(hit.id, "autocomplete-wrongly-disabled");
  }
  const claimIds = new Set(redDiff.forbiddenHits.map((h) => h.ref.split("#")[1]));
  for (const cid of ["claim-14", "claim-21", "claim-29"]) {
    assert.ok(claimIds.has(cid), `expected the forbidden pin to fire on ${cid}`);
  }
});

// --- Layer 1b: GREEN reading (C1 00:50) --------------------------------------------------------

const greenDiff = diffKnowledge(green, expected);

test("GREEN fixture is the frozen C1 00:50 run", () => {
  assert.match(green.runDir, /run-2026_08_12_00_50-.*-1e2a64e4$/, "green fixture must be the C1 00:50 run directory");
});

test("GREEN: the auto-complete-cron rule is FOUND (that run authored it correctly on cron.go)", () => {
  assert.ok(foundIds(greenDiff).has("T1-autocomplete-cron"), "T1-autocomplete-cron must be found in the green run");
});

test("GREEN: the forbidden pin does NOT fire (unless exempts the correct Go-cron wording)", () => {
  assert.equal(greenDiff.forbiddenHits.length, 0, "the pin must never punish the correctly-authored green run");
});

test("GREEN: all 9 T2 regression sentinels are FOUND (guards today's correctly-authored leave core)", () => {
  const found = foundIds(greenDiff);
  for (const id of T2) {
    assert.ok(found.has(id), `${id} must be found (green) in the C1 00:50 run`);
  }
});

test("GREEN: the other two T1 rules remain claims-layer authoring-misses even in the green run", () => {
  // The 'green' run covers auto-complete correctly but still never authored the preview-hours calc or the
  // natural-day-vs-working-day distinction against their support source — this is the depth gap, not noise.
  const attr = attributionOf(greenDiff);
  assert.equal(attr.get("T1-preview-hours"), "authoring-miss");
  assert.equal(attr.get("T1-natural-vs-working-day"), "authoring-miss");
});

// --- Layer 2: forbidden-pin discriminator units (verbatim wordings) ----------------------------

function fact(statement: string): KnowledgeFact {
  return { ref: "d#c", documentId: "d", claimId: "c", statement, marker: "fact", windows: [], citedEvidenceCount: 0, searchEvidence: [] };
}

function knowledgeWith(facts: KnowledgeFact[]): Knowledge {
  return { runDir: "(synthetic)", facts, relations: [], coverage: [], unknowns: [], prepareHorizon: { files: [], scopeText: "" } };
}

function pinOutcome(statement: string): "fires" | "exempt" | "no-match" {
  const diff = diffKnowledge(knowledgeWith([fact(statement)]), expected);
  if (diff.forbiddenHits.length) return "fires";
  if (diff.forbiddenExempted.length) return "exempt";
  return "no-match";
}

// Each row: [statement, expected pin outcome]. Statements are harvests / minimal variants of them.
const PIN_CASES: Array<[string, "fires" | "exempt" | "no-match"]> = [
  // C1v2 hallucination: auto-complete framed as an unregistered / won't-happen Node job (no Go cron).
  ["自动标记完成：Node 定义了将已批准且已过期请假置为已完成的任务，但当前启动路径未注册它", "fires"],
  ["旧服务不会自动补发请假邮件，也不会自动将到期请假置为已完成", "fires"],
  // The SAME disabled-Node framing but this time correctly attributing to the Go cron -> unless exempts it.
  ["到期标记完成任务在旧 Node 未注册，改由 Go cron syncLvCompleted 承担", "exempt"],
  // Green wording: the old Node task is commented out, but 注释停用 / 不将 sit outside the pin's base framing.
  ["旧 Node 服务中原有的请假邮件任务与标记完成任务已在启动注册处被注释停用", "no-match"],
  ["到期完成：后台 cron 将结束日已过的已批准请假批量置为已完成", "no-match"]
];

for (const [statement, want] of PIN_CASES) {
  test(`pin: ${want} — ${statement.slice(0, 30)}…`, () => {
    assert.equal(pinOutcome(statement), want);
  });
}
