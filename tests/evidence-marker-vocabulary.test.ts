import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { markersIn, MARKER_FOLDING, MARKER_TOKENS } from "../src/report/evidence-markers.ts";
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

// ═══ THE VOCABULARY'S TWO READERS, AND THE PARTITION THAT KEEPS WIDENING FROM BEING SILENT (57B-494) ══════════
//
// A marker token is read by two different questions. `markersIn` asks "does this prose carry an evidence level"
// (the CHECK) and accepts all eight. `foldUnitText` has to REMOVE the token before comparing prose against a
// claim statement (the FOLD) — an author's claim statement does not repeat the `` `事实` `` they annotated with —
// and it removes only four. So `` `已验证` `` is a recognised evidence level that folds as ORDINARY PROSE.
//
// THAT ASYMMETRY IS NOT WHAT 57B-494 FIXED, AND THE REASON IS A MIGRATION. Making the fold strip all eight was
// measured on the real command: a unit whose claim statement swallowed `` `已验证` `` goes from `complete` to
// `violations`. `unit-claim-binding.ts`'s header calls that a change of FOLDING GENERATION and states the law —
// prior unit products become a second generation whose judgement has to be rebuilt. Unit products live in
// arbitrary target run dirs `audit --units` is pointed at, so the population is not bounded by this repo, and
// the header of THIS file records why it is probably not empty: a real zh-CN run wrote `` `已验证` `` and
// `` `不可用` `` in good faith. Unifying the sets is a decision with a migration attached.
//
// WHAT WAS SILENT AND IS NOW NOT. The hazard was never today's asymmetry — both halves of the fold agree with
// each other, so no segment goes missing from its own unit. It was that widening the vocabulary moved only the
// RECOGNITION, with nothing able to see it. The split is now DECLARED (`MARKER_FOLDING`), and this test is what
// makes the declaration binding: the partition must be total over `MARKER_TOKENS`, and each token's real folding
// behaviour must match the list it was put in. A NINTH SYNONYM BELONGS TO NEITHER LIST AND GOES RED HERE until
// somebody decides which — widening now has to pass the fold as well as the check, without a migration.
test("every recognised token is declared either folded or deliberately unfolded, and behaves that way", () => {
  const declared = [...MARKER_FOLDING.folded, ...MARKER_FOLDING.unfolded].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(declared, Object.keys(MARKER_TOKENS).sort((a, b) => a.localeCompare(b)),
    "a token the vocabulary recognises must be declared folded or unfolded — a new synonym belongs to one of the two lists");
  assert.equal(new Set(declared).size, declared.length, "no token may be in both lists");

  // The declaration is checked against the real fold, not trusted. This is the half that goes red if the fold
  // moves without the list moving — the same drift in the other direction.
  for (const token of MARKER_FOLDING.folded) {
    assert.equal(foldUnitText(`前置说明 \`${token}\` 后续说明`), "前置说明 后续说明", `${token} is declared folded`);
  }
  for (const token of MARKER_FOLDING.unfolded) {
    assert.equal(foldUnitText(`前置说明 \`${token}\` 后续说明`), `前置说明 ${token} 后续说明`,
      `${token} is declared unfolded, so it stays in the prose as an ordinary word`);
  }
  // And both lists are recognised by the CHECK regardless — which is the asymmetry, stated as an assertion.
  for (const token of declared) {
    assert.equal(markersIn(`处理器在标志未设置时拒绝该请求 \`${token}\`。`).size, 1, `${token} is a recognised level`);
  }
});

// THE en-US HALF, PINNED IN THE DIRECTION THAT WAS MISSING. The bidirectional test above compares `MARKER_TOKENS`
// against the contract's `zh-CN` lists only, so the English words — a second table since 57B-494 — were checked
// contract → code and not code → contract: dropping or renaming one stayed green. That is the half-covered
// contract this module's own header says a second spelling must not have.
test("the code recognises exactly the en-US tokens the contract lists, and no others", () => {
  const fromContract = new Map<string, string>();
  for (const [level, byLanguage] of Object.entries(VOCABULARY.levels)) {
    for (const token of byLanguage["en-US"] ?? []) fromContract.set(token, level);
  }
  // Code → contract: every English word the audit reads must be one the contract lists, at the same level.
  const fromCode = new Map<string, string>();
  for (const token of fromContract.keys()) {
    const seen = [...markersIn(`The handler rejects the request when the flag is unset ${token}.`)];
    assert.equal(seen.length, 1, `${token} must read as exactly one level`);
    fromCode.set(token, seen[0]);
  }
  assert.deepEqual([...fromCode].sort(), [...fromContract].sort(),
    "the en-US vocabulary and the words the audit accepts must be the same set, mapped the same way");
  // And nothing beyond it: an ordinary English word is not an evidence level.
  for (const word of ["asserted", "confirmed", "unknown", "factory", "verification"]) {
    assert.deepEqual([...markersIn(`The handler rejects the request when the flag is ${word}.`)], [], word);
  }
});
