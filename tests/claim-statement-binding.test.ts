import test from "node:test";
import assert from "node:assert/strict";
import { auditSectionClaims, substantiveSegments } from "../src/report/section-audit.ts";
import { scaffoldSectionClaims } from "../src/report/claims-scaffold.ts";
import type { SectionClaim } from "../src/base/types.ts";

// THE ENGINE REJECTING ITS OWN OUTPUT.
//
// `claims scaffold` emits one stub per substantive segment and its own doc comment promises the stub "can
// never drift from `auditSectionClaims`". That promise held for paragraph coverage and failed for the
// statement-present check, because the two sides folded text differently: the segmenter dropped `**`, while
// the audit turned it into a SPACE. So `产品名为 **CMS3000**，其源码` became `… CMS3000 ，其源码` on the audit
// side — a space before the comma that appears in no rendering of the prose and in nothing an author would
// write. Every claim binding a bold lead-in failed, including hand-written ones.
//
// Two engine rules were therefore in direct contradiction: `writing-rules.md` asks every chapter for bold
// lead-ins, and the audit made bold lead-ins unbindable. A real authoring run on a Perl/Catalyst target hit
// ~30 of these in one report and the only way through was deleting every bold marker from the prose.
//
// The constructions below are verbatim from that run, not synthesised — synthetic fixtures and review had
// both missed this for as long as the check existed.

const cited = new Set(["FACT-1"]);
const traces = new Set<string>();

function claim(statement: string): SectionClaim {
  return { id: "claim-1", marker: "fact", statement, evidenceIds: ["FACT-1"], workItemIds: [] } as unknown as SectionClaim;
}

function bindingErrors(section: string, claims: SectionClaim[]): string[] {
  return auditSectionClaims({
    documentId: "doc", sectionIndex: 1, sectionText: section,
    claimsFile: { version: 2, documentId: "doc", section: 1, claims } as never,
    evidenceIds: cited, traceIds: traces,
  })
    .filter((finding) => /is not present in section/.test(finding.message))
    .map((finding) => finding.message);
}

// The exact sentence from the real report, with the exact marker placement.
const REAL_SECTION = [
  "## 1. 项目目的与边界",
  "",
  "本项目是一套自建的内容管理系统，产品名为 **CMS3000**，其源码自述为「基于 Catalyst 的内容管理系统」 `事实`。",
  "",
].join("\n");

test("a scaffolded stub binds to the section that produced it", () => {
  const stubs = scaffoldSectionClaims(REAL_SECTION).map((stub) => ({ ...stub, evidenceIds: ["FACT-1"] }));
  assert.ok(stubs.length > 0, "the section has substantive prose to scaffold");
  assert.deepEqual(bindingErrors(REAL_SECTION, stubs), [],
    "the engine must accept the claims the engine itself emitted");
});

test("a bold lead-in does not make a hand-written statement unbindable", () => {
  // What an author naturally writes: the sentence as it RENDERS, with no markup and no injected space.
  const statement = "本项目是一套自建的内容管理系统，产品名为 CMS3000，其源码自述为「基于 Catalyst 的内容管理系统」";
  assert.deepEqual(bindingErrors(REAL_SECTION, [claim(statement)]), [],
    "writing-rules asks for bold lead-ins; the audit must not punish them");
});

// A SECOND, INDEPENDENT DRIFT of the same kind, and one my first fix did NOT cure — found only by running
// the scaffold through the real audit path instead of hand-writing the statement.
//
// The segmenter removed the marker TOKEN outright (`substantiveSegments` → `.replace(EVIDENCE_MARKER_TOKEN,
// "")`), while the audit's folding removed only the backticks and left `事实` standing as a bare word. So
// the stub read `凭据被写在代码里 ：三处配置各自声明` and the folded section read
// `凭据被写在代码里 事实：三处配置各自声明` — again a segment absent from its own section.
//
// A hand-written statement (`凭据被写在代码里`) passes either way, which is why the first version of this
// test proved nothing: it asserted the easy case. Both sides now share `foldInlineDecoration`.
test("a scaffolded stub binds when a marker is followed by non-terminating punctuation", () => {
  const section = "## 2. 组成\n\n凭据被写在代码里 `事实`：三处配置各自声明。\n";
  const stubs = scaffoldSectionClaims(section).map((stub) => ({ ...stub, evidenceIds: ["FACT-1"] }));
  assert.equal(stubs.length, 1, "one substantive segment");
  assert.match(stubs[0].statement, /：/, "the stub really does span the colon — this is the failing shape");
  assert.deepEqual(bindingErrors(section, stubs), []);
});

test("a hand-written statement in the same shape also binds", () => {
  const section = "## 2. 组成\n\n凭据被写在代码里 `事实`：三处配置各自声明。\n";
  assert.deepEqual(bindingErrors(section, [claim("凭据被写在代码里")]), []);
});

test("inline code in the middle of a sentence does not split it", () => {
  const section = "## 3. 入口\n\n控制单元 `ZMS::Controller::Content` 声明了内容树的入口 `事实`。\n";
  assert.deepEqual(bindingErrors(section, [claim("控制单元 ZMS::Controller::Content 声明了内容树的入口")]), []);
});

// Identifiers keep their separators: removing `-` or `_` would weld words together and silently change
// which statements match, which is a different way to break the same binding.
test("hyphens and underscores stay separators, so identifiers are not welded", () => {
  const section = "## 4. 表\n\n同名 zms_user 表存在两套声明，read-obligations 记录了分母 `事实`。\n";
  assert.deepEqual(bindingErrors(section, [claim("同名 zms user 表存在两套声明")]), [],
    "the underscore folds to a space on both sides, as it always did");
  assert.deepEqual(bindingErrors(section, [claim("read obligations 记录了分母")]), []);
});

// A statement that genuinely is not in the prose must still fail — the fix loosens folding, not the check.
test("a statement absent from the prose is still reported", () => {
  const errors = bindingErrors(REAL_SECTION, [claim("本系统由三个独立服务组成，彼此通过消息队列通信")]);
  assert.equal(errors.length, 1, "the binding guarantee survives the fix");
});

// Backward compatibility: a run authored against the old folding may carry the injected space in its
// statement. Those runs must keep binding, or archived reports fall out of audit on this change alone.
test("a statement carrying the old injected space still binds", () => {
  const legacyStatement = "本项目是一套自建的内容管理系统，产品名为 CMS3000 ，其源码自述为「基于 Catalyst 的内容管理系统」";
  assert.deepEqual(bindingErrors(REAL_SECTION, [claim(legacyStatement)]), [],
    "an archived run that worked around the defect must not be broken by fixing it");
});

// KNOWN COST OF THE LEGACY FALLBACK, recorded rather than left silent.
//
// Under the new folding alone this would fail: the marker token is removed from the prose, so `事实` is not
// there to match. The legacy folding keeps it as a bare word, and "either folding binds" therefore accepts a
// statement that swallowed the marker. Untidy, not a false binding — every word of the statement really is
// in the prose, in that order — and it is the price of not breaking runs authored against the old behaviour.
// If the legacy path is ever removed, this test is the record of what changes.
test("the legacy fallback accepts a statement that swallowed the marker token", () => {
  const section = "## 1. 范围\n\n该检查不属于本次范围 `事实`。另有三处独立声明。\n";
  assert.deepEqual(bindingErrors(section, [claim("该检查不属于本次范围 事实")]), [],
    "accepted via the legacy folding only — the new folding removes the marker token");
});

// The loosening must not extend to meaning. Dropping a negation is the cheapest way to check that.
test("folding does not let a negated sentence bind to its opposite", () => {
  const section = "## 1. 范围\n\n该检查不属于本次范围 `事实`。另有三处独立声明。\n";
  const errors = bindingErrors(section, [claim("该检查属于本次范围")]);
  assert.equal(errors.length, 1, "removing 不 must still fail to bind");
});

// Two shapes a real report uses that the old folding broke and the new one must keep working.
test("emphasis and inline code inside a sentence keep it bindable", () => {
  const emphasised = "## 3. 取值\n\n值为 **on**/**off** 两态 `事实`。\n";
  assert.deepEqual(bindingErrors(emphasised, [claim("值为 on/off 两态")]), []);
  assert.equal(bindingErrors(emphasised, [claim("值为 onoff 两态")]).length, 1,
    "and removing the asterisks must not weld the words together");

  const coded = "## 2. 配置\n\n配置项 `enabled` 与 `disabled` 各自声明 `事实`。\n";
  assert.deepEqual(bindingErrors(coded, [claim("配置项 enabled 与 disabled 各自声明")]), []);
});

// WHICH GENERATION JUDGES A SECTION — the property that keeps `claims scaffold` and the audit consistent.
//
// The scaffold folds under the CURRENT generation. If the audit could prefer the legacy generation for a
// section whose statements were written today, the two would drift again — the same disease this fix
// removes, in a new place. The guard is that legacy is chosen only when it is STRICTLY better, and prose
// written today reads at least as well under the current folding.
//
// Measured on two real runs before pinning it: the run authored today is judged under the current
// generation in 23 of 23 sections (legacy never strictly better), while a 2026-08-13 archived run needs
// legacy for 4 of 23 — which is the evidence that keeping the legacy generation is load-bearing rather
// than defensive.
test("a section written under current semantics is judged under current semantics", () => {
  const section = "## 1. 标题\n\n产品名为 **CMS3000**，其源码自述为内容管理系统 `事实`。\n";
  const stubs = scaffoldSectionClaims(section).map((stub) => ({ ...stub, evidenceIds: ["FACT-1"] }));
  // No folding-sensitive finding at all: the current generation binds the scaffold it produced, so the
  // tie-break (newest on equal cost) keeps the section on current semantics.
  assert.deepEqual(bindingErrors(section, stubs), []);
});

// And the reverse: a statement that ONLY the legacy folding can bind still binds, which is what protects
// archived runs. Together these two say legacy is a fallback, never a competitor.
test("a statement only the legacy folding binds is still accepted", () => {
  const section = "## 1. 标题\n\n产品名为 **CMS3000**，其源码自述为内容管理系统 `事实`。\n";
  const legacyOnly = "产品名为 CMS3000 ，其源码自述为内容管理系统";
  assert.deepEqual(bindingErrors(section, [claim(legacyOnly)]), [],
    "the injected space exists only in the legacy folding of the prose");
});

// THE SAFETY PROPERTY BEHIND "pick the generation with fewest folding errors" — stated correctly this time.
//
// The count is NOT generation-independent: `substantiveSegments` de-duplicates with `new Set` AFTER folding,
// so a folding that makes two sentences identical merges them (pinned separately below).
//
// What IS generation-independent is which parts survive the length filter: the marker token and `**bold**`
// are stripped before splitting, the folding then only touches punctuation-class characters, and the
// `semanticLength >= 8` filter counts letters and digits. So no generation can drop a part the other keeps.
test("which parts survive the length filter does not depend on the folding generation", () => {
  const legacyFold = (value: string) => value.replace(/[`*_>#-]/g, " ").replace(/\s+/g, " ").trim();
  const sections = [
    "## 1\n\n第一句足够长以形成独立段落 `事实`。第二句也足够长以形成独立段落 `事实`。\n",
    "## 2\n\n| 组件 | 职责 |\n| --- | --- |\n| **缓存层** | 保存对象与实例数据以降低查询 |\n",
    "## 3\n\n以 `-` 分隔的项：alpha-beta-gamma 与 delta-epsilon 两组各自独立声明 `事实`。\n",
    "## 4\n\n带下划线的标识：zms_user 与 zms_object 两表各自声明主键约束 `事实`。\n",
    "## 5\n\n**加粗引导**：其后跟随足够长的说明文字以形成一个独立段落 `验证`。\n",
  ];
  // Absolute counts, not parity. Parity stays green if BOTH generations lose a part — the regression this
  // is meant to catch — so each fixture pins the number it must produce, under both foldings.
  const expected = [2, 1, 1, 1, 1];
  for (const [index, section] of sections.entries()) {
    assert.equal(substantiveSegments(section).length, expected[index], `current folding, fixture ${index}`);
    assert.equal(substantiveSegments(section, legacyFold).length, expected[index], `legacy folding, fixture ${index}`);
  }
});

// THE KNOWN COST of de-duplicating after folding, recorded rather than asserted away.
//
// Two sentences differing only in decoration fold to one string under the legacy generation, so that
// generation reports one fewer segment and can look cheaper. It is NOT a hole this fix opened: the old
// `normalizeText` WAS the legacy folding, so main folded and de-duplicated both sides identically and
// accepted exactly this shape. Grandfathered, therefore, rather than newly permitted.
//
// Deliberately NOT fixed by requiring "a generation may not reduce the segment count": that would force
// archived sections which main accepted back onto current semantics and turn them red — breaking the
// compatibility this whole change exists to keep.
test("folding can merge twin sentences on de-duplication, as it always could", () => {
  const legacyFold = (value: string) => value.replace(/[`*_>#-]/g, " ").replace(/\s+/g, " ").trim();
  const twins = "## 1\n\n配置项 on`off`切换 生效于启动流程。配置项 on off 切换 生效于启动流程。\n";
  assert.equal(substantiveSegments(twins).length, 2, "the current folding keeps them distinct");
  assert.equal(substantiveSegments(twins, legacyFold).length, 1, "the legacy folding merges them — known, grandfathered");
});

// `too short to bind` IS generation-sensitive, so it has to participate in the cost comparison. Folding
// decides the length: decoration ADJACENT to text is removed by the current folding and spaced by the legacy
// one, so `` `abc`de `` is 5 characters now and 6 before — below and above the binding threshold.
//
// The construction matters: a marker-bearing statement like `` `事实` 共5项 `` does NOT demonstrate this,
// because segments strip the marker token under BOTH generations, so such a claim fails coverage under
// legacy too and both generations cost the same. Decoration ADJACENT to text is the only shape that moves
// the length alone.
test("a statement only one generation makes long enough is not reported as too short", () => {
  const section = "## 1. 项\n\n配置项 `abc`de 与其余项各自独立声明于主配置文件 `事实`。\n";
  const findings = auditSectionClaims({
    documentId: "doc", sectionIndex: 1, sectionText: section,
    claimsFile: { version: 2, documentId: "doc", section: 1, claims: [claim("`abc`de")] } as never,
    evidenceIds: cited, traceIds: traces,
  });
  assert.deepEqual(findings.filter((finding) => /too short to bind|not present in section|unclaimed substantive/.test(finding.message)), [],
    "the legacy generation reads this section consistently, so the section passes under it");
});
