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

// THE COMMA — the main clause boundary in Chinese, and the one the boundary set still missed after the two
// fixes above. Review probed it and found seven NATURAL sentences (not adversarial constructions) that
// silently passed, every one of which the old bare word list had caught. Twice in this file the boundary set
// was assembled from examples instead of from structure; these are the examples that finally forced the
// structural reading.
test("a negator does not reach across a clause boundary", () => {
  for (const real of [
    "服务无法自动恢复，解决方案是重启守护进程。",
    "不过，修复建议是下调超时。",
    "无论如何，解决方案概览在第 12 章。",
    "不含业务逻辑——解决方案是引入网关。",
    "There is no rate limit, so we recommend adding one.",
    "The cache is not shared and we recommend enabling it.",
    "非常推荐采用队列化改造。",
  ]) {
    assert.equal(unnegatedAdvice(real).length, 1, real);
  }
});

// And the boundaries must not be so eager that a single disclaiming sentence stops working: an enumeration
// inside one clause is still governed by its negator.
test("a negator still governs an enumeration inside its own clause", () => {
  assert.deepEqual(unnegatedAdvice("本节不涉及改动、修复建议与迁移步骤。"), []);
});

// THE COLON IS DOUBLE-SIDED, and a regex cannot tell its two uses apart. Pinned to leave the ruling
// visible rather than to celebrate the behaviour.
//
// An object-list disclaimer puts the advice words AFTER the colon while the negation stays before it, so
// treating the colon as a boundary reports a genuine disclaimer. An explanatory colon starts a new
// assertion and must still be caught. Separating them needs to know whether a complete clause precedes the
// colon — beyond what this check can see. The colon stays a boundary because the failure direction is
// visible (a false positive prints its excerpt and can be argued) and the shape does not occur anywhere in
// 658 archived report sections; the honest fix is tokenizer-level negation, recorded for ruling.
test("the colon boundary reports an object-list disclaimer — known cost, not an endorsement", () => {
  assert.equal(unnegatedAdvice("报告不包含以下内容：修复建议、迁移步骤与优先级。").length, 1,
    "false positive, accepted: visible, arguable, and absent from the corpus");
  assert.equal(unnegatedAdvice("问题不在配置：解决方案是升级内核。").length, 1,
    "and the explanatory colon must keep being caught — the same boundary earns its place here");
});

// English negation scope conventionally coordinates with `or`, which stays inside the negation.
test("an English disclaimer coordinating with or is not reported", () => {
  assert.deepEqual(unnegatedAdvice("This report does not include fixes or recommendations."), []);
  assert.equal(unnegatedAdvice("This report does not include analysis and recommendations.").length, 1,
    "`and` is a boundary — known cost, and the pinned `not shared and we recommend` case depends on it");
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
