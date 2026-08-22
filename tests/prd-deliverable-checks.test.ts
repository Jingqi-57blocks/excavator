/**
 * THE PRD DELIVERABLE'S WORD-FORM CONTRACT (57B-500): every rule injected and every rule removed, over VALUES.
 *
 * WHY THE PAIRS ARE THE POINT. An instrument that is wrong goes green, not red, so each of the five shapes has a
 * fixture that produces it AND a fixture that takes the defect out and asserts silence. A rule with several exits
 * that nobody ever asserted goes quiet on is a rule with no coverage claim, whatever its line count says.
 *
 * THE THREE NEGATIVE CONTROLS, which are the reason half this file exists:
 *
 *   1. THE SAME BYTES IN A COLLAPSED `<details>` BLOCK OR A FENCED BLOCK ARE SILENT. A PRD's evidence blocks
 *      legitimately carry DDL, column types and API paths — the whole product/implementation split depends on it —
 *      and a chapter quoting a Markdown sample is quoting, not writing.
 *   2. THE SAME BYTES IN AN ENGINEERING DOCUMENT ARE SILENT. These rules are the PRD's own, and a rule that leaked
 *      into the other four templates would red documents that never agreed to it.
 *   3. THE SAME BYTES IN A PRODUCT-MANAGER OVERVIEW ARE SILENT — the sharp one. `mapLegacyDocumentRequest` records
 *      a prd request as the `product-manager` READER with the `prd` INTENT, so an overview and a PRD share an
 *      audience. A check keyed on the audience would pass control 2 and still red every product overview in the
 *      run; only a check keyed on the task passes this one.
 *
 * THE DELIVERABLE IS CHINESE, so the fixtures are: full-width punctuation, `、` enumerators and CJK text around
 * every token. A rule that only fired on ASCII-shaped English lines would pass a test written in English and do
 * nothing on the documents this engine actually produces.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { InvestigationWorkItem } from "../src/base/types.ts";
import { numberedChapters } from "../src/report/chapter-inventory.ts";
import {
  PRD_PROBLEM_SHAPES,
  TECHNICAL_LEAK_TOKENS,
  describePrdProblem,
  duplicateAnchorDefinitions,
  prdProblemSeverity,
  scanPrdUnitProse,
  type PrdProblemShape
} from "../src/report/prd-deliverable-checks.ts";
import {
  checkUnitConsistency,
  type ConsistencyDocument,
  type ConsistencyFinding,
  type ConsistencyResult,
  type ConsistencyUnit
} from "../src/report/unit-consistency.ts";
import { UNIT_SUMMARY_VERSION, type UnitSummary } from "../src/report/unit-output.ts";
import type { ReportIntent } from "../src/report/report-request-v2.ts";

const DOCUMENT = "feature-leave-prd";
const LEAF = `${DOCUMENT}::leaf::one`;
const OTHER = `${DOCUMENT}::leaf::two`;

function summary(unitId: string): UnitSummary {
  return {
    version: UNIT_SUMMARY_VERSION,
    unitId,
    documentId: DOCUMENT,
    kind: "leaf",
    coveredTopicIds: [],
    keyStatements: [`${unitId} 记录当前状态。`],
    unknowns: [],
    terminology: [],
    contentDigest: "0".repeat(64),
    claimsDigest: "1".repeat(64),
    childSummaryDigests: []
  };
}

/** One unit whose first chapter carries the caller's body. The chapter heading keeps the deliverable well-formed. */
function unit(unitId: string, ordinal: number, body: string): ConsistencyUnit {
  return {
    unitId,
    documentId: DOCUMENT,
    kind: "leaf",
    title: unitId,
    content: `## ${ordinal}. 功能概述\n\n${body}\n`,
    claims: [],
    summary: summary(unitId)
  };
}

/**
 * A document for the checker. `plannedChapterCount` is derived from the bytes so the chapter class stays silent:
 * every finding in this file has to come from the class under test, not from noise the fixture made itself.
 */
function document(units: readonly ConsistencyUnit[], intent: ReportIntent = "prd", audience: ConsistencyDocument["audience"] = "product-manager"): ConsistencyDocument {
  const markdown = units.map((row) => row.content).join("\n");
  return {
    documentId: DOCUMENT,
    markdown,
    audience,
    intent,
    identifierPlacement: "evidence-only",
    plannedChapterCount: Math.max(1, numberedChapters(markdown).length),
    units
  };
}

const LEDGER = new Map<string, InvestigationWorkItem>();

function check(documentUnderTest: ConsistencyDocument): ConsistencyResult {
  return checkUnitConsistency({ documents: [documentUnderTest], workItems: LEDGER, frozenEvidenceIds: [] });
}

/** Only the class under test. Every other class is asserted silent by `allFindings` below. */
function prd(documentUnderTest: ConsistencyDocument): readonly ConsistencyFinding[] {
  const result = check(documentUnderTest);
  const others = result.findings.filter((finding) => finding.kind !== "prd-deliverable");
  assert.deepEqual(others, [], `the fixture tripped another class: ${others.map((finding) => finding.statement).join("; ")}`);
  return result.findings.filter((finding) => finding.kind === "prd-deliverable");
}

function shapes(findings: readonly ConsistencyFinding[]): readonly string[] {
  return findings.map((finding) => (finding.kind === "prd-deliverable" ? finding.problem.shape : finding.kind));
}

/** One body per shape, in the language and punctuation a real deliverable is written in. */
const INJECTIONS: Readonly<Record<PrdProblemShape, string>> = {
  "acceptance-residue": "- [ ] 用户在登录页提交正确的用户名与密码后进入工作台。\n- [x] 密码错误五次后账号锁定三十分钟。",
  "forbidden-anchor-series": "AC-001 用户在登录页提交正确的用户名与密码后进入工作台。",
  "anchor-shape": "- FR-1 用户可以在登录页提交用户名与密码。",
  "anchor-duplicate": "- FR-001 用户可以在登录页提交用户名与密码。\n- FR-001 用户可以在登录页重置密码。",
  "technical-leak": "员工姓名字段为 varchar(100)，不可为空。"
};

/** The compliant form of each injection: the same fact, written the way the contract asks for it. */
const REPAIRED: Readonly<Record<PrdProblemShape, string>> = {
  "acceptance-residue": "- 用户在登录页提交正确的用户名与密码后进入工作台。\n- 密码错误五次后账号锁定三十分钟。",
  "forbidden-anchor-series": "- FR-002 用户在登录页提交正确的用户名与密码后进入工作台。",
  "anchor-shape": "- FR-001 用户可以在登录页提交用户名与密码。",
  "anchor-duplicate": "- FR-001 用户可以在登录页提交用户名与密码。\n- FR-002 用户可以在登录页重置密码。",
  "technical-leak": "员工姓名最多 100 个字符，必填。"
};

// --- the census -------------------------------------------------------------------------------------

test("every shape of the prd word-form contract has a fixture that produces it, and one that does not", () => {
  const produced = new Set<string>();
  for (const shape of PRD_PROBLEM_SHAPES) {
    const injected = prd(document([unit(LEAF, 1, INJECTIONS[shape])]));
    assert.deepEqual(shapes(injected), [shape], `injecting ${shape} must produce exactly that shape`);
    assert.ok(injected.length > 0);
    produced.add(shape);

    // Removed: the same statement, written the way the contract asks for it. Silence, not a different finding.
    const repaired = prd(document([unit(LEAF, 1, REPAIRED[shape])]));
    assert.deepEqual(repaired, [], `the repaired form of ${shape} must be silent: ${repaired.map((row) => row.statement).join("; ")}`);
  }
  assert.deepEqual([...produced].sort(), [...PRD_PROBLEM_SHAPES].sort());
});

test("a compliant prd deliverable reports zero findings and a denominator that can be checked", () => {
  const compliant = document([
    unit(LEAF, 1, "本能力覆盖员工的请假申请与审批。入口为「请假管理」页面，路径 `/manage/leave/list`。"),
    unit(OTHER, 2, "- FR-001 员工可以提交请假申请，见第 1 章。\n- PAGE-001 请假管理，路径 `/manage/leave/list`。")
  ]);
  assert.deepEqual(prd(compliant), []);
  const reading = check(compliant).readings.find((row) => row.kind === "prd-deliverable")!;
  assert.equal(reading.objects.state, "examined");
  assert.equal(reading.objects.state === "examined" ? reading.objects.objects : -1, 2, "one scan per unit");
  // The counts are in the sentence, so "0 findings" is a claim a reader can falsify rather than a bare zero.
  assert.match(reading.statement, /covering \d+ visible prose line\(s\) and 2 FR\/PAGE token\(s\)/u);
  assert.equal(reading.findings, 0);
});

// --- 1. acceptance residue ---------------------------------------------------------------------------

test("a checkbox line is residue of a chapter the template no longer has; a plain bullet is not", () => {
  const findings = prd(document([unit(LEAF, 1, INJECTIONS["acceptance-residue"])]));
  assert.equal(findings.length, 1, "two checkbox lines in one unit are one residue and one repair");
  assert.deepEqual(findings[0]!.unitIds, [LEAF]);
  assert.equal(findings[0]!.severity, "error");
  assert.match(findings[0]!.statement, /2 acceptance checkbox line\(s\)/u);
  assert.match(findings[0]!.statement, /never how someone would verify it/u);

  // A LINK whose text is `x` is not a checkbox: GFM needs whitespace after the bracket, and so does this rule.
  assert.deepEqual(prd(document([unit(LEAF, 1, "- [x](https://example.test/handbook) 员工手册。")])), []);
  // An ordered checklist and one inside a table cell are still checklists.
  assert.equal(prd(document([unit(LEAF, 1, "1. [ ] 提交申请。")])).length, 1);
  assert.equal(prd(document([unit(LEAF, 1, "| - [ ] 提交申请 | 待办 |")])).length, 1);
});

// --- 2. the forbidden id series ----------------------------------------------------------------------

test("an AC id is a series the trace index may not define; FR and PAGE ids are the two it may", () => {
  const findings = prd(document([unit(LEAF, 1, "AC-001 用户可登录。AC-001 重复出现。AC-2 也在场。")]));
  assert.deepEqual(shapes(findings), ["forbidden-anchor-series", "forbidden-anchor-series"], "one finding per distinct id");
  assert.match(findings[0]!.statement, /acceptance id AC-001/u);
  assert.match(findings[0]!.statement, /no acceptance ids, no component ids, no test ids/u);

  // The token boundary: an id-shaped tail of a longer word is not an AC id.
  assert.deepEqual(prd(document([unit(LEAF, 1, "设备编号 MAC-001 记录在案。")])), []);
});

// --- 3. anchor shape ----------------------------------------------------------------------------------

test("a trace anchor is FR- or PAGE- plus exactly three digits, wherever it is written", () => {
  const malformed = prd(document([unit(LEAF, 1, "- FR-1 用户可登录。\n- PAGE-0012 请假管理。\n- FR-00A 无效。")]));
  assert.deepEqual(shapes(malformed), ["anchor-shape", "anchor-shape", "anchor-shape"]);
  assert.deepEqual(malformed.map((finding) => (finding.kind === "prd-deliverable" && finding.problem.shape === "anchor-shape" ? finding.problem.token : "")), ["FR-00A", "FR-1", "PAGE-0012"]);
  assert.match(malformed[0]!.statement, /exactly three digits/u);

  // A malformed id written mid-sentence is still malformed: the shape rule reads every occurrence, not only the
  // definitions. This is what the uniqueness narrowing does NOT give up.
  assert.equal(prd(document([unit(LEAF, 1, "登录规则见 FR-12，密码规则见 FR-002。")])).length, 1);
  // Case-sensitive on purpose: a CSS property and an ordinary lower-case word are not trace anchors.
  assert.deepEqual(prd(document([unit(LEAF, 1, "列表使用 `page-break-inside` 控制分页。")])), []);
});

// --- 4. anchor uniqueness ------------------------------------------------------------------------------

test("an id that leads two lines is a duplicate — across units too — and an id cited mid-sentence is not", () => {
  const inOneUnit = prd(document([unit(LEAF, 1, INJECTIONS["anchor-duplicate"])]));
  assert.deepEqual(shapes(inOneUnit), ["anchor-duplicate"]);
  assert.deepEqual(inOneUnit[0]!.unitIds, [LEAF]);
  assert.match(inOneUnit[0]!.statement, /defines trace anchor FR-001 on 2 line\(s\)/u);

  // Across units: the chapters are the concatenation of every unit's prose, so both definers are named.
  const acrossUnits = prd(document([
    unit(LEAF, 1, "- PAGE-001 请假管理，路径 `/manage/leave/list`。"),
    unit(OTHER, 2, "| PAGE-001 | 请假审批 | `/manage/leave/review` |")
  ]));
  assert.deepEqual(shapes(acrossUnits), ["anchor-duplicate"]);
  assert.deepEqual(acrossUnits[0]!.unitIds, [LEAF, OTHER]);

  // THE NARROWING, ASSERTED: the index defines FR-001 once and another chapter cites it mid-sentence. That is what
  // an anchor is FOR. A rule counting every occurrence would red this document, and this assertion is what would
  // go red if someone widened it.
  assert.deepEqual(prd(document([
    unit(LEAF, 1, "提交后进入待审批状态，规则见 FR-001。"),
    unit(OTHER, 2, "- FR-001 员工可以提交请假申请，见第 1 章。")
  ])), []);
});

// --- 5. the storage-schema tripwire --------------------------------------------------------------------

test("a storage-schema token in prose is a warning that never fails the check, and the product form is silent", () => {
  const findings = prd(document([unit(LEAF, 1, "员工表 varchar(100) NOT NULL，主键 AUTO_INCREMENT，含 FOREIGN KEY。")]));
  assert.deepEqual(shapes(findings), ["technical-leak", "technical-leak", "technical-leak", "technical-leak"]);
  for (const finding of findings) {
    assert.equal(finding.severity, "warning", "a rule decided by a word list may not stop a pipeline");
    assert.deepEqual(finding.unitIds, [LEAF]);
  }
  assert.match(findings[0]!.statement, /tripwire rather than a gate/u);

  // Whitespace inside a two-word token, and case, are spellings rather than different tokens.
  assert.equal(prd(document([unit(LEAF, 1, "字段声明为 not  null。")])).length, 1);
  // The product form of the same fact says nothing about storage.
  assert.deepEqual(prd(document([unit(LEAF, 1, REPAIRED["technical-leak"])])), []);
});

test("every leak token in the list is reachable, and each one names itself", () => {
  for (const token of TECHNICAL_LEAK_TOKENS) {
    const findings = prd(document([unit(LEAF, 1, `字段定义：${token}。`)]));
    assert.deepEqual(shapes(findings), ["technical-leak"], `${token} must be reachable`);
    assert.match(findings[0]!.statement, new RegExp(token.replace(/ /gu, "\\s"), "iu"));
  }
});

// --- the three negative controls ------------------------------------------------------------------------

test("the same bytes inside a collapsed evidence block or a fenced sample are silent", () => {
  for (const shape of PRD_PROBLEM_SHAPES) {
    const collapsed = `<details>\n<summary>证据</summary>\n\n${INJECTIONS[shape]}\n\n</details>`;
    assert.deepEqual(prd(document([unit(LEAF, 1, collapsed)])), [], `${shape} must be silent inside <details>`);
    const fenced = "```markdown\n" + INJECTIONS[shape] + "\n```";
    assert.deepEqual(prd(document([unit(LEAF, 1, fenced)])), [], `${shape} must be silent inside a fence`);
    const commented = `<!--\n${INJECTIONS[shape]}\n-->`;
    assert.deepEqual(prd(document([unit(LEAF, 1, commented)])), [], `${shape} must be silent inside an HTML comment`);
  }
});

test("the same bytes in an engineering document, and in a product-manager overview, are silent", () => {
  for (const shape of PRD_PROBLEM_SHAPES) {
    const engineering = document([unit(LEAF, 1, INJECTIONS[shape])], "deep-dive", "engineer");
    assert.deepEqual(check(engineering).findings, [], `${shape} leaked into an engineering document`);

    // The sharp control: SAME READER as a prd request, different task. A rule keyed on the audience passes the
    // line above and fails this one.
    const overview = document([unit(LEAF, 1, INJECTIONS[shape])], "overview", "product-manager");
    assert.deepEqual(check(overview).findings, [], `${shape} leaked into a product-manager overview`);
  }
});

test("a document that is not a prd reads vacuous with the contract as the reason, never with the prose", () => {
  const reading = check(document([unit(LEAF, 1, INJECTIONS["acceptance-residue"])], "overview")).readings
    .find((row) => row.kind === "prd-deliverable")!;
  assert.equal(reading.objects.state, "vacuous");
  assert.match(reading.objects.state === "vacuous" ? reading.objects.reason : "", /records the document task of feature-leave-prd as overview/u);
  assert.match(reading.objects.state === "vacuous" ? reading.objects.reason : "", /no prose can write itself into or out of this arm/u);

  // And a PRD is NEVER vacuous — not even one whose every line lives inside a collapsed block. The cheapest way
  // past a prose rule would otherwise be to write no visible prose.
  const hidden = check(document([unit(LEAF, 1, "<details>\n<summary>证据</summary>\n\n仅证据。\n\n</details>")]))
    .readings.find((row) => row.kind === "prd-deliverable")!;
  assert.equal(hidden.objects.state, "examined");
});

// --- the shape-level unit: severity, statements and the definition rule -------------------------------

test("exactly one shape is a warning, and the four contract rules are gates", () => {
  const warnings = PRD_PROBLEM_SHAPES.filter((shape) => prdProblemSeverity(shape) === "warning");
  assert.deepEqual(warnings, ["technical-leak"],
    "a second warning is a decision, not an edit: it means a second rule stopped being decidable without a word list");
});

test("the scanner reports what it read, and a definition is an id that leads its line", () => {
  const scan = scanPrdUnitProse("- FR-001 员工可以提交请假申请。\n\n提交后进入待审批状态，规则见 FR-001。\n");
  assert.deepEqual(scan.anchorIds, ["FR-001"], "one definition and one citation");
  assert.equal(scan.anchorTokens, 2, "both occurrences are read for shape");
  assert.equal(scan.visibleLines, 2);
  assert.deepEqual(scan.problems, []);

  // Every decoration a definition may hide behind. Each of these must count as ONE definition of the same id.
  for (const line of ["- **FR-001** — 员工可以提交请假申请。", "1. `FR-001` 员工可以提交请假申请。", "| FR-001 | 员工可以提交请假申请 |", "> FR-001 员工可以提交请假申请。"]) {
    assert.deepEqual(scanPrdUnitProse(line).anchorIds, ["FR-001"], line);
  }
});

test("duplicate detection groups by id, counts definitions and names every definer", () => {
  const duplicates = duplicateAnchorDefinitions([
    { unitId: OTHER, anchorIds: ["FR-001", "PAGE-001"] },
    { unitId: LEAF, anchorIds: ["FR-001", "FR-001"] }
  ]);
  assert.equal(duplicates.length, 1, "PAGE-001 is defined once");
  assert.equal(duplicates[0]!.problem.anchorId, "FR-001");
  assert.equal(duplicates[0]!.problem.definitions, 3);
  assert.deepEqual(duplicates[0]!.unitIds, [LEAF, OTHER]);
  assert.deepEqual(duplicateAnchorDefinitions([{ unitId: LEAF, anchorIds: ["FR-001"] }]), []);
});

test("every problem prints a sentence that names the document and what to do about it", () => {
  for (const shape of PRD_PROBLEM_SHAPES) {
    const findings = prd(document([unit(LEAF, 1, INJECTIONS[shape])]));
    for (const finding of findings) {
      assert.ok(finding.kind === "prd-deliverable");
      const sentence = describePrdProblem(finding.problem, DOCUMENT, `unit ${LEAF}`);
      assert.equal(finding.statement, sentence);
      assert.ok(sentence.includes(DOCUMENT), sentence);
      assert.ok(sentence.length > 120, `${shape} must say why, not only what: ${sentence}`);
    }
  }
});
