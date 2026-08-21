import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { markersIn, MARKER_TOKENS } from "../src/report/evidence-markers.ts";

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
