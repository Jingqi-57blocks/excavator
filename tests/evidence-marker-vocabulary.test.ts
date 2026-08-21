import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { markersIn, MARKER_TOKENS } from "../src/report/evidence-markers.ts";
// THE FOLD'S OWN ENTRY POINT, imported on purpose rather than the pattern it routes through: the property this
// file guards is that the CHECK and the FOLD read one vocabulary, and the fold as its consumer actually calls it
// is `foldUnitText`. Asserting the pattern alone would leave a re-spelled literal inside that consumer invisible.
import { foldUnitText } from "../src/report/unit-claim-binding.ts";

// ONE VOCABULARY, TWO READERS — and a test that fails if they drift.
//
// `writing-rules.md` told authors to render the evidence markers "naturally … in the requested output
// language" while the audit accepted exactly four Chinese strings. A real zh-CN run wrote `` `已验证` `` and
// `` `不可用` `` in good faith and had whole chapters reported as having no evidence level at all — doing what
// the documentation said produced an error, which is the failure class this batch exists to clear.
//
// The vocabulary is now data (`references/evidence-markers.json`) that the contract points at, and this test
// is what keeps `assurance.ts` honest about it: adding a synonym to one side alone goes red.

// Repo-relative, like `language.test.ts` and `skill-contract.test.ts`. An absolute home-directory path
// passed here only because this machine symlinks the installed skill back into the repo — on any other
// machine it is ENOENT, and if the install form were a COPY the test would bind to a stale mirror and stay
// green while the repo drifted. Green against the wrong file is worse than red.
const VOCABULARY = JSON.parse(readFileSync(
  new URL("../skills/excavator/references/evidence-markers.json", import.meta.url), "utf8",
)) as { levels: Record<string, Record<string, string[]>> };

test("every token the contract lists is recognised by the audit", () => {
  for (const [level, byLanguage] of Object.entries(VOCABULARY.levels)) {
    for (const [language, tokens] of Object.entries(byLanguage)) {
      for (const token of tokens) {
        const prose = language === "en-US"
          ? `The handler rejects the request when the flag is unset ${token}.`
          : `处理器在标志未设置时拒绝该请求 \`${token}\`。`;
        assert.deepEqual([...markersIn(prose)], [level],
          `${language} token ${JSON.stringify(token)} must read as ${level}`);
      }
    }
  }
});

// BOTH DIRECTIONS. The first version of this file only checked contract → code, so a synonym added to
// `MARKER_TOKENS` alone would have stayed green — the header claimed a bidirectional guard it did not have.
test("the code recognises exactly the tokens the contract lists, and no others", () => {
  const fromContract = new Map<string, string>();
  for (const [level, byLanguage] of Object.entries(VOCABULARY.levels)) {
    for (const token of byLanguage["zh-CN"] ?? []) fromContract.set(token, level);
  }
  assert.deepEqual(
    Object.fromEntries([...Object.entries(MARKER_TOKENS)].sort(([a], [b]) => a.localeCompare(b))),
    Object.fromEntries([...fromContract].sort(([a], [b]) => a.localeCompare(b))),
    "the code's token table and the contract's zh-CN vocabulary must be the same set, mapped the same way",
  );
});

// The two natural synonyms the real run tried, named explicitly so a regression is legible without decoding
// the loop above.
test("the synonyms a real Chinese run wrote are accepted", () => {
  assert.deepEqual([...markersIn("该账号已过期仍可登入 `已验证`。")], ["verified"]);
  assert.deepEqual([...markersIn("生产环境实际取值 `不可用`。")], ["unavailable"]);
});

// Whole tokens only: a component whose name contains a marker word is not a marker. Without this the widened
// vocabulary would start reading Chinese identifiers as evidence levels.
test("a backticked identifier containing a marker word is not a marker", () => {
  for (const prose of ["组件 `验证服务` 负责校验入站请求。", "模块 `事实包` 汇总结构化事实。", "函数 `推断器` 生成候选。"]) {
    assert.deepEqual([...markersIn(prose)], [], prose);
  }
});

// The audit must still be able to say "this chapter has no marker" — widening the vocabulary must not make
// every chapter pass by accident.
test("prose with no marker still reads as having none", () => {
  assert.deepEqual([...markersIn("本章说明请假小时数如何按年度扣减，具体规则见折叠证据块。")], []);
});

// ═══ ONE VOCABULARY, BOTH HALVES OF THE MARKER RULE (57B-494) ═════════════════════════════════════════════════
//
// THE TWO HALVES, AND WHY THEY HAVE TO MOVE TOGETHER. A marker token is read twice by two different questions:
// `markersIn` asks "does this prose carry an evidence level" (the CHECK), and `foldUnitText` has to REMOVE the
// token before comparing prose to a claim statement (the FOLD) — an author's claim never repeats the `` `事实` ``
// they annotated with, so a token left standing becomes a bare word inside the segment around it.
//
// Until 57B-494 those were two literals in two files: eight tokens here, four spelled again in
// `unit-claim-binding.ts`. Nothing bound wrongly, because each file was internally consistent — the defect was
// that WIDENING was not atomic. Adding a synonym here made it recognised and left it unfolded, silently, and no
// test in the repository could see the difference.
//
// THE LOOP IS DRIVEN BY THE TABLE, WHICH IS WHAT MAKES IT A GUARD RATHER THAN A RESTATEMENT: a ninth token added
// to `MARKER_TOKENS` extends this test to itself, and goes red here if the fold does not follow it.
test("every token the vocabulary recognises is also a token the fold removes", () => {
  for (const [token, level] of Object.entries(MARKER_TOKENS)) {
    assert.deepEqual([...markersIn(`处理器在标志未设置时拒绝该请求 \`${token}\`。`)], [level],
      `${token} must be recognised as ${level}`);
    assert.equal(foldUnitText(`前置说明 \`${token}\` 后续说明`), "前置说明 后续说明",
      `${token} must fold away, or every claim around it stops binding`);
  }
});

// AND THE FALSIFICATION, so the loop above is shown to be load-bearing rather than vacuously true. This is the
// literal `unit-claim-binding.ts` carried before 57B-494. Run the same loop against it and four named tokens
// fail — the exact four the vocabulary had been widened by, recognised as evidence levels and folded as ordinary
// prose. A test that cannot name what it would have caught has not been shown to catch anything.
test("the pre-57B-494 hand-spelled pattern fails that loop on four named tokens", () => {
  const preTightening = /`(?:事实|验证|推断|不可得|fact|verified|inferred|unavailable)`/gi;
  const unfolded = Object.keys(MARKER_TOKENS)
    .filter((token) => `前置说明 \`${token}\` 后续说明`.replace(preTightening, "").replace(/[`*]/g, "").replace(/\s+/g, " ").trim()
      !== "前置说明 后续说明");
  assert.deepEqual(unfolded, ["已验证", "已推断", "不可用", "无法获得"],
    "the second spelling recognised eight tokens through markersIn and folded only four");
  // The drift in its exact shape: every one of them WAS a recognised evidence level while it was not folded.
  for (const token of unfolded) {
    assert.equal(markersIn(`处理器在标志未设置时拒绝该请求 \`${token}\`。`).size, 1, token);
  }
});
