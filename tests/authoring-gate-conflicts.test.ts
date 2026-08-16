import test from "node:test";
import assert from "node:assert/strict";
import { unnegatedAdvice } from "../src/assurance/recommendation-language.ts";
import { comparativeWording } from "../src/assurance/claim-comparison.ts";

// GATES THAT PUNISHED AUTHORS FOR FOLLOWING THE CONTRACT.
//
// Every sentence below is the wording a real Chinese authoring run either wrote or was forced to abandon —
// not a construction I invented. Synthetic fixtures had missed all of these for as long as the checks
// existed, which is the whole argument for taking test material from real reports.

// `product-overview.md` §9 says "Do not include remediation", so an author writes a lead-in saying exactly
// that — and a bare `/修复建议/` reported the disclaimer as the violation it announces the absence of. The
// author then reworded it, which created a new substantive paragraph needing its own claim, and finally
// folded it into the previous sentence to get a green audit.
test("a disclaimer about advice is not itself advice", () => {
  const real = "本章只列出可归因于本次审阅快照的问题。每条给出问题、快照中的依据、当前代码允许发生什么、优先级与置信度。不给出修复建议。";
  assert.deepEqual(unnegatedAdvice(real), [], "the natural §9 lead-in must pass");
  assert.deepEqual(unnegatedAdvice("…优先级与置信度，不涉及如何改动代码。"), [], "and so must the reworded form");
  assert.deepEqual(unnegatedAdvice("本节未提供解决方案，只列出当前代码允许发生什么。"), []);
  assert.deepEqual(unnegatedAdvice("This chapter states current behaviour and does not include recommendations."), []);
});

// The gate still has to work. Negation is scoped to a sentence: a full stop ends its reach.
test("advice with nothing negating it is still reported", () => {
  assert.equal(unnegatedAdvice("修复建议见附录，请将超时下调。").length, 1);
  assert.equal(unnegatedAdvice("We recommend switching the payment provider to live mode.").length, 1);
  assert.equal(unnegatedAdvice("该检查不属于本次范围。修复建议见附录。").length, 1,
    "the negator governs its own sentence only");
  assert.equal(unnegatedAdvice("第 12 章给出解决方案概览。").length, 1);
});

// THREE WAYS REAL ADVICE WALKED THROUGH the first version of the negation rule, found by probing the
// loosening direction rather than by review. Worth pinning because a gate that stops working fails GREEN:
// nothing red, advice simply stops being reported.
//
// All three share a cause: the negator's reach ended only at sentence punctuation, so it leaked across
// structural boundaries that start a new assertion — a bullet, a table cell, an English subordinate clause.
test("a negator does not reach across a structural boundary", () => {
  assert.equal(unnegatedAdvice("- 不涉及改动代码\n- 修复建议见附录").length, 1, "a newline starts a new bullet");
  assert.equal(unnegatedAdvice("| 不适用 | 修复建议见附录 |").length, 1, "a pipe starts a new cell");
  assert.equal(unnegatedAdvice("There is no doubt that we recommend switching to live mode.").length, 1,
    "`that` starts a new clause, so the subordinate `no` does not license the main clause");
});

// And the boundaries must not be so eager that a single disclaiming sentence stops working: an enumeration
// inside one clause is still governed by its negator.
test("a negator still governs an enumeration inside its own clause", () => {
  assert.deepEqual(unnegatedAdvice("本节不涉及改动、修复建议与迁移步骤。"), []);
});

// `镜像` is a container image in Chinese and `等价` is ordinary for semantic equivalence. Both were BARE
// patterns in the comparative-wording list, so three sentences from a real engineering overview were flagged
// as cross-source equivalence claims and the author rewrote 镜像 as 容器层 — trading terminology accuracy for
// a green audit, which is the wrong thing to make an author do.
test("container images and semantic equivalence are not cross-source comparisons", () => {
  for (const real of [
    "上层镜像把时区固定为 Europe/Vienna",
    "生产镜像把实例目录做成挂载点并交给运行账户",
    "整个表达式等价于命名空间自身的真值",
    "六份容器镜像定义与流水线脚本",
  ]) {
    assert.equal(comparativeWording(real), false, real);
  }
});

// And the check must still catch a real equivalence assertion — the connective is what distinguishes them.
test("a genuine equivalence assertion still trips the comparative check", () => {
  for (const real of [
    "该配置与上游声明等价",
    "两者等价，均以标识列为主键",
    "公共表与实例表共享同一命名",
    "两份生产镜像与测试镜像互为镜像",
  ]) {
    assert.equal(comparativeWording(real), true, real);
  }
});
