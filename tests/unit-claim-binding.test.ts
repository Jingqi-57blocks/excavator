import test from "node:test";
import assert from "node:assert/strict";
import {
  auditUnitClaimBinding,
  foldUnitText,
  substantiveUnitSegments,
  visibleUnitText
} from "../src/report/unit-claim-binding.ts";
import type { SectionClaim } from "../src/base/types.ts";

// THE ENGINE REJECTING ITS OWN OUTPUT — the corpus, moved to the unit key (57B-491).
//
// Every construction below is VERBATIM from a real authoring run on a Perl/Catalyst target. Nothing here was
// synthesised, and that is the point of keeping it: synthetic fixtures and review had both missed this defect for
// as long as the check existed, and it took a real report — ~30 errors in one document — to surface it.
//
// The defect: the two halves of the contract folded text differently. The segmenter dropped `**`, while the
// comparator turned it into a SPACE. So `产品名为 **CMS3000**，其源码` became `… CMS3000 ，其源码` on the audit
// side — a space before the comma that appears in no rendering of the prose and in nothing an author would write.
// Every claim binding a bold lead-in failed, including the ones the engine emitted itself. Two engine rules were
// therefore in direct contradiction: `writing-rules.md` asks every chapter for bold lead-ins, and the audit made
// bold lead-ins unbindable. The only way through was deleting every bold marker from the prose.
//
// WHAT MOVED AND WHAT DID NOT. The unit path had no binding check at all, so this file is the check arriving
// there, not a second copy of one. The corpus sentences are byte-identical to the section-path file
// (`tests/claim-statement-binding.test.ts`, which stays where it is until 57B-481 retires `section-audit.ts`);
// the shape around them is unit-keyed. FOUR cases changed DIRECTION, and each says so at its own site: they are
// the ones whose outcome came from the section path's LEGACY folding generation, which is deliberately not
// migrated because no unit product predates the current folding. Their sentences are kept verbatim precisely so
// the record of what a single-generation fold costs is a running assertion rather than a memory.

const CITED = ["FACT-1"];

function claim(statement: string, id = "claim-1"): SectionClaim {
  return { id, marker: "fact", statement, evidenceIds: CITED, workItemIds: [] } as unknown as SectionClaim;
}

/**
 * Claim stubs built from the unit's OWN segmentation — the generator, kept in the test rather than in `src/`.
 *
 * On the section path this was `scaffoldSectionClaims`, a production module whose only remaining caller is a
 * test. Reproducing it here (segment, minus the terminator the table join adds) keeps the property the corpus
 * exists to defend — a statement EQUAL TO A SEGMENT must bind to the very unit that produced it — without adding
 * a `src/` module nothing in the product reaches.
 */
function stubs(content: string): SectionClaim[] {
  return substantiveUnitSegments(content).map((segment, index) =>
    claim(segment.replace(/[；;。！？!?]+$/u, "").trim(), `claim-${index + 1}`));
}

function audit(content: string, claims: SectionClaim[]) {
  return auditUnitClaimBinding({ unitId: "overview-product::leaf::route", documentId: "overview-product", content, claims });
}

/** The `statement-absent` class alone — the same slice the section-path corpus measured. */
function bindingErrors(content: string, claims: SectionClaim[]): string[] {
  return audit(content, claims).problems.filter((problem) => problem.kind === "statement-absent").map((problem) => problem.message);
}

function problemKinds(content: string, claims: SectionClaim[]): string[] {
  return audit(content, claims).problems.map((problem) => problem.kind);
}

// The exact sentence from the real report, with the exact marker placement.
const REAL_UNIT = [
  "## 1. 项目目的与边界",
  "",
  "本项目是一套自建的内容管理系统，产品名为 **CMS3000**，其源码自述为「基于 Catalyst 的内容管理系统」 `事实`。",
  ""
].join("\n");

// ── 1 ────────────────────────────────────────────────────────────────────────────────────────────────────────
test("a stub built from the unit's own segmentation binds to the unit that produced it", () => {
  const built = stubs(REAL_UNIT);
  assert.ok(built.length > 0, "the unit has substantive prose to segment");
  assert.deepEqual(bindingErrors(REAL_UNIT, built), [],
    "the engine must accept the claims the engine's own segmentation implies");
});

// ── 2 ────────────────────────────────────────────────────────────────────────────────────────────────────────
test("a bold lead-in does not make a hand-written statement unbindable", () => {
  // What an author naturally writes: the sentence as it RENDERS, with no markup and no injected space.
  const statement = "本项目是一套自建的内容管理系统，产品名为 CMS3000，其源码自述为「基于 Catalyst 的内容管理系统」";
  assert.deepEqual(bindingErrors(REAL_UNIT, [claim(statement)]), [],
    "writing-rules asks for bold lead-ins; the audit must not punish them");
});

// A SECOND, INDEPENDENT DRIFT of the same kind, and one the first fix did NOT cure — found only by running the
// engine's own segmentation through the audit path instead of hand-writing the statement.
//
// The segmenter removed the marker TOKEN outright, while the fold removed only the backticks and left `事实`
// standing as a bare word. So the stub read `凭据被写在代码里 ：三处配置各自声明` and the folded prose read
// `凭据被写在代码里 事实：三处配置各自声明` — again a segment absent from its own unit.
//
// A hand-written statement (`凭据被写在代码里`) passes either way, which is why the first version of this test
// proved nothing: it asserted the easy case. Both sides share `foldUnitText`, which strips the token.

// ── 3 ────────────────────────────────────────────────────────────────────────────────────────────────────────
test("a stub binds when a marker is followed by non-terminating punctuation", () => {
  const content = "## 2. 组成\n\n凭据被写在代码里 `事实`：三处配置各自声明。\n";
  const built = stubs(content);
  assert.equal(built.length, 1, "one substantive segment");
  assert.match(built[0].statement, /：/, "the stub really does span the colon — this is the failing shape");
  assert.deepEqual(bindingErrors(content, built), []);
});

// ── 4 ────────────────────────────────────────────────────────────────────────────────────────────────────────
test("a hand-written statement in the same shape also binds", () => {
  const content = "## 2. 组成\n\n凭据被写在代码里 `事实`：三处配置各自声明。\n";
  assert.deepEqual(bindingErrors(content, [claim("凭据被写在代码里")]), []);
});

// ── 5 ────────────────────────────────────────────────────────────────────────────────────────────────────────
test("inline code in the middle of a sentence does not split it", () => {
  const content = "## 3. 入口\n\n控制单元 `ZMS::Controller::Content` 声明了内容树的入口 `事实`。\n";
  assert.deepEqual(bindingErrors(content, [claim("控制单元 ZMS::Controller::Content 声明了内容树的入口")]), []);
});

// Identifiers keep their separators: removing `-` or `_` would weld words together and silently change which
// statements match, which is a different way to break the same binding.
// ── 6 ────────────────────────────────────────────────────────────────────────────────────────────────────────
test("hyphens and underscores stay separators, so identifiers are not welded", () => {
  const content = "## 4. 表\n\n同名 zms_user 表存在两套声明，read-obligations 记录了分母 `事实`。\n";
  assert.deepEqual(bindingErrors(content, [claim("同名 zms user 表存在两套声明")]), [],
    "the underscore folds to a space on both sides, as it always did");
  assert.deepEqual(bindingErrors(content, [claim("read obligations 记录了分母")]), []);
});

// A statement that genuinely is not in the prose must still fail — the fix loosens folding, not the check.
// ── 7 ────────────────────────────────────────────────────────────────────────────────────────────────────────
test("a statement absent from the prose is still reported", () => {
  const errors = bindingErrors(REAL_UNIT, [claim("本系统由三个独立服务组成，彼此通过消息队列通信")]);
  assert.equal(errors.length, 1, "the binding guarantee survives the fix");
});

// ── 8 ── DIRECTION CHANGED, AND THIS IS THE RECORD OF WHY ─────────────────────────────────────────────────────
//
// On the section path this bound: a run authored against the OLD folding carries the injected space in its
// statement, and the legacy generation kept those archived reports inside the audit. The unit path has no
// archived generation — units exist only from R4a, all written under the current fold — so the legacy generation
// was not migrated, and a statement carrying that space is now exactly what it looks like: a statement whose
// bytes are not in the prose. The sentence is kept verbatim so the cost of the single-generation fold is an
// assertion rather than a memory. If a unit product ever DOES predate a fold change, this is the case that has
// to go back to binding, via a rebuilt per-generation judgement (see the file header of `unit-claim-binding.ts`).
test("a statement carrying the old injected space no longer binds, because there is one generation", () => {
  const legacyStatement = "本项目是一套自建的内容管理系统，产品名为 CMS3000 ，其源码自述为「基于 Catalyst 的内容管理系统」";
  assert.equal(bindingErrors(REAL_UNIT, [claim(legacyStatement)]).length, 1,
    "the injected space exists only in the legacy folding of the prose, and the unit path has no legacy folding");
});

// ── 9 ── DIRECTION CHANGED, AND THE SECTION PATH ASKED FOR IT ─────────────────────────────────────────────────
//
// The section-path case was titled "the legacy fallback accepts a statement that swallowed the marker token" and
// its comment said in as many words: "Untidy, not a false binding … If the legacy path is ever removed, this test
// is the record of what changes." This is that record. Under the current fold alone the marker token is removed
// from the prose, so `事实` is not there to match, and a statement that swallowed the marker is rejected.
test("a statement that swallowed the marker token is rejected, which is what removing the legacy path changes", () => {
  const content = "## 1. 范围\n\n该检查不属于本次范围 `事实`。另有三处独立声明。\n";
  assert.equal(bindingErrors(content, [claim("该检查不属于本次范围 事实")]).length, 1,
    "the current folding removes the marker token from the prose, so the swallowed marker has nothing to match");
});

// The loosening must not extend to meaning. Dropping a negation is the cheapest way to check that.
// ── 10 ───────────────────────────────────────────────────────────────────────────────────────────────────────
test("folding does not let a negated sentence bind to its opposite", () => {
  const content = "## 1. 范围\n\n该检查不属于本次范围 `事实`。另有三处独立声明。\n";
  const errors = bindingErrors(content, [claim("该检查属于本次范围")]);
  assert.equal(errors.length, 1, "removing 不 must still fail to bind");
});

// Two shapes a real report uses that the old folding broke and the new one must keep working.
// ── 11 ───────────────────────────────────────────────────────────────────────────────────────────────────────
test("emphasis and inline code inside a sentence keep it bindable", () => {
  const emphasised = "## 3. 取值\n\n值为 **on**/**off** 两态 `事实`。\n";
  assert.deepEqual(bindingErrors(emphasised, [claim("值为 on/off 两态")]), []);
  assert.equal(bindingErrors(emphasised, [claim("值为 onoff 两态")]).length, 1,
    "and removing the asterisks must not weld the words together");

  const coded = "## 2. 配置\n\n配置项 `enabled` 与 `disabled` 各自声明 `事实`。\n";
  assert.deepEqual(bindingErrors(coded, [claim("配置项 enabled 与 disabled 各自声明")]), []);
});

// ── 12 ── the cross-generation invariant becomes an ABSOLUTE one ──────────────────────────────────────────────
//
// The section-path case asserted that WHICH PARTS survive the length filter does not depend on the folding
// generation, and pinned absolute counts under both. With one generation the comparison has no second side, but
// the load-bearing half survives unchanged: these five real shapes must produce exactly these counts. Absolute
// counts, not parity — parity stayed green when BOTH generations lost a part, which is the regression this
// exists to catch, so each fixture pins the number it must produce.
test("the length filter keeps exactly these parts of five real shapes", () => {
  const contents = [
    "## 1\n\n第一句足够长以形成独立段落 `事实`。第二句也足够长以形成独立段落 `事实`。\n",
    "## 2\n\n| 组件 | 职责 |\n| --- | --- |\n| **缓存层** | 保存对象与实例数据以降低查询 |\n",
    "## 3\n\n以 `-` 分隔的项：alpha-beta-gamma 与 delta-epsilon 两组各自独立声明 `事实`。\n",
    "## 4\n\n带下划线的标识：zms_user 与 zms_object 两表各自声明主键约束 `事实`。\n",
    "## 5\n\n**加粗引导**：其后跟随足够长的说明文字以形成一个独立段落 `验证`。\n"
  ];
  const expected = [2, 1, 1, 1, 1];
  for (const [index, content] of contents.entries()) {
    assert.equal(substantiveUnitSegments(content).length, expected[index], `fixture ${index}`);
  }
});

// ── 13 ── the de-duplication cost, on the one generation there is ─────────────────────────────────────────────
//
// Segments are de-duplicated with `new Set` AFTER folding, so a fold that makes two sentences identical merges
// them. Under the CURRENT fold these twins stay distinct, and that is the half that still has a subject: the
// section-path case's other half measured the legacy generation merging them, which does not exist here.
test("twin sentences differing only in decoration stay distinct under the current fold", () => {
  const twins = "## 1\n\n配置项 on`off`切换 生效于启动流程。配置项 on off 切换 生效于启动流程。\n";
  assert.equal(substantiveUnitSegments(twins).length, 2, "the current folding keeps them distinct");
});

// ── 14 ───────────────────────────────────────────────────────────────────────────────────────────────────────
//
// WHICH SEMANTICS JUDGES A UNIT — on the section path this pinned that a section written today is judged under
// the current generation, because a generation-preferring audit would drift from the generator again. On the unit
// path there is exactly one semantics, so the property the case defends is the one that remains checkable: prose
// written today binds the statements its own segmentation implies, with no finding of any kind.
test("a unit written under current semantics binds under current semantics", () => {
  const content = "## 1. 标题\n\n产品名为 **CMS3000**，其源码自述为内容管理系统 `事实`。\n";
  assert.deepEqual(audit(content, stubs(content)).problems, []);
});

// ── 15 ── DIRECTION CHANGED, same reason as 8 ─────────────────────────────────────────────────────────────────
//
// The section-path case was "a statement only the legacy folding binds is still accepted", and it was the reverse
// half of the archived-run protection. With one generation the injected space is simply absent from the prose.
test("a statement only the legacy folding could bind is now reported", () => {
  const content = "## 1. 标题\n\n产品名为 **CMS3000**，其源码自述为内容管理系统 `事实`。\n";
  const legacyOnly = "产品名为 CMS3000 ，其源码自述为内容管理系统";
  assert.equal(bindingErrors(content, [claim(legacyOnly)]).length, 1,
    "the injected space exists only in the legacy folding of the prose");
});

// ── 16 ── DIRECTION CHANGED: the length threshold is fold-sensitive ───────────────────────────────────────────
//
// Folding decides the length. Decoration ADJACENT to text is removed by the current fold and was spaced by the
// legacy one, so `` `abc`de `` is 5 characters now and 6 before — below and above the binding threshold. The
// section path let the legacy generation rescue it; with one generation it is reported as too short, which is the
// honest reading: `abcde` is not a statement that binds to anything in particular.
//
// The construction matters and is kept verbatim: a marker-bearing statement like `` `事实` 共5项 `` does NOT
// demonstrate this, because segments strip the marker token either way. Decoration ADJACENT to text is the only
// shape that moves the length alone.
test("a statement only the legacy generation made long enough is reported as too short", () => {
  const content = "## 1. 项\n\n配置项 `abc`de 与其余项各自独立声明于主配置文件 `事实`。\n";
  assert.deepEqual(problemKinds(content, [claim("`abc`de")]), ["statement-too-short"],
    "5 folded characters is below the binding threshold, and the segment is still covered by it");
});

// ═══ THE SINGLE-FOLDING-AUTHORITY PROPERTY, ASSERTED AND THEN FALSIFIED ═══════════════════════════════════════
//
// The invariant that both drifts violated: every segment the segmenter produces is contained in the folded
// visible text of the unit that produced it. It holds by construction only because there is ONE fold, and it is
// the property that makes "a stub binds to its own unit" true rather than lucky.
test("every segment is contained in the folded visible text of the unit that produced it", () => {
  const corpus = [
    REAL_UNIT,
    "## 2. 组成\n\n凭据被写在代码里 `事实`：三处配置各自声明。\n",
    "## 3. 入口\n\n控制单元 `ZMS::Controller::Content` 声明了内容树的入口 `事实`。\n",
    "## 4. 表\n\n同名 zms_user 表存在两套声明，read-obligations 记录了分母 `事实`。\n",
    "## 3. 取值\n\n值为 **on**/**off** 两态 `事实`。\n",
    "## 2\n\n| 组件 | 职责 |\n| --- | --- |\n| **缓存层** | 保存对象与实例数据以降低查询 |\n",
    "## 5\n\n**加粗引导**：其后跟随足够长的说明文字以形成一个独立段落 `验证`。\n"
  ];
  for (const content of corpus) {
    const visible = foldUnitText(visibleUnitText(content));
    for (const segment of substantiveUnitSegments(content)) {
      assert.ok(visible.includes(segment), `segment ${JSON.stringify(segment)} must be present in ${JSON.stringify(visible)}`);
    }
  }
});

// AND THE FALSIFICATION: reproduce the original accident by folding the two halves differently, and watch the
// invariant above break on the very shape that produced ~30 errors in the real report. Without this the test
// above could be green because it asserts nothing hard; with it, the assertion is shown to be load-bearing.
test("folding the two halves differently reproduces the bold lead-in defect", () => {
  // The pre-fix folding: inline decoration became a SPACE instead of being removed.
  const spacingFold = (value: string) => value.replace(/[`*_>#-]/g, " ").replace(/\s+/g, " ").trim();
  const visible = spacingFold(visibleUnitText(REAL_UNIT));
  const segments = substantiveUnitSegments(REAL_UNIT);
  assert.ok(segments.length > 0, "the fixture has a segment to compare");
  assert.ok(segments.every((segment) => !visible.includes(segment)),
    "a segmenter that DROPS `**` against a comparator that SPACES it makes the segment absent from its own unit");
  // And the shape of the damage, named: the space before the comma that appears in no rendering of the prose.
  assert.match(visible, /CMS3000 ，其源码/);
  assert.doesNotMatch(foldUnitText(visibleUnitText(REAL_UNIT)), /CMS3000 ，其源码/);
});
