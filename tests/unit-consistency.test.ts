/**
 * R7c - the six content-level classes (`unit-consistency.ts`), each injected and each removed, over VALUES.
 *
 * WHY THE VALUE-LEVEL TESTS ARE HERE AND THE RUN-LEVEL ONES ARE NOT. The checker is a pure function, so a class is
 * best exercised by handing it the one shape it is about and then handing it the same shape with the defect taken
 * out — a pair per class, both asserted, so a class that stopped firing and a class that fires on everything are
 * both caught. What a real run adds is that the defect SURVIVES the collect gates, and that is
 * `tests/unit-consistency-e2e.test.ts`'s business: it drafts and collects the same shapes through the real commands
 * and shows the gates staying green before the checker goes red.
 *
 * EVERY CLASS IS ASSERTED TO NAME ITS UNITS, because a finding nobody can locate is worth nothing to a repair set.
 *
 * THE THREE-STATE DISCIPLINE IS ASSERTED AS THREE DIFFERENT SENTENCES, not as a boolean: "checked 2 objects, 0
 * findings" and "nothing to check" have to be distinguishable in the artifact, which is the whole reason
 * `ClassObjects` is a union.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { InvestigationWorkItem, SectionClaim, WorkItemStatus } from "../src/base/types.ts";
import { CONTENTS_ANCHOR, unitAnchorId } from "../src/report/unit-assembly.ts";
import {
  CONSISTENCY_FINDING_KINDS,
  UNIT_CONSISTENCY_VERSION,
  checkUnitConsistency,
  describeClassReading,
  describeFinding,
  whyCollectCannotSee,
  type ConsistencyDocument,
  type ConsistencyFinding,
  type ConsistencyFindingKind,
  type ConsistencyResult,
  type ConsistencyUnit
} from "../src/report/unit-consistency.ts";
import { numberedChapters } from "../src/report/chapter-inventory.ts";
import { headingSlug, readDocumentAnchors } from "../src/report/unit-document-anchors.ts";
import { UNIT_SUMMARY_VERSION, type UnitSummary, type UnitTerminologyEntry } from "../src/report/unit-output.ts";

const DOCUMENT = "overview-product";
const LEAF = `${DOCUMENT}::leaf::one`;
const OTHER = `${DOCUMENT}::leaf::two`;
const ROOT = `${DOCUMENT}::synthesis::document`;
const EVIDENCE = "S-b524a4194f";

function summary(unitId: string, terminology: readonly UnitTerminologyEntry[] = [], unknowns: readonly string[] = []): UnitSummary {
  return {
    version: UNIT_SUMMARY_VERSION,
    unitId,
    documentId: DOCUMENT,
    kind: unitId === ROOT ? "synthesis" : "leaf",
    coveredTopicIds: [],
    keyStatements: [`${unitId} 记录当前状态。`],
    unknowns: [...unknowns],
    terminology: [...terminology],
    contentDigest: "0".repeat(64),
    claimsDigest: "1".repeat(64),
    childSummaryDigests: []
  };
}

function unit(unitId: string, options: {
  content?: string;
  claims?: readonly SectionClaim[];
  terminology?: readonly UnitTerminologyEntry[];
  unknowns?: readonly string[];
} = {}): ConsistencyUnit {
  return {
    unitId,
    documentId: DOCUMENT,
    kind: unitId === ROOT ? "synthesis" : "leaf",
    title: unitId,
    content: options.content ?? `## ${unitId}\n\n${unitId} 记录当前状态。\n`,
    claims: options.claims ?? [],
    summary: summary(unitId, options.terminology, options.unknowns)
  };
}

/**
 * The assembled markdown of a document, built the way `renderUnitDocument` builds it: one explicit anchor per unit,
 * one for the contents table, and each unit's prose verbatim.
 *
 * It is a stand-in and it is deliberately faithful on the two things the anchor classes read — the explicit anchors
 * and the headings. The real bytes are what `tests/unit-consistency-e2e.test.ts` runs against.
 */
function assembled(units: readonly ConsistencyUnit[]): string {
  return [
    `<a id="${CONTENTS_ANCHOR}"></a>`,
    "",
    "## Contents",
    "",
    ...units.flatMap((row, index) => ["", `<a id="${unitAnchorId(row.unitId)}"></a>`, "", numberFirstHeading(row.content.trim(), index + 1)])
  ].join("\n");
}

/**
 * Number a unit's own opening chapter heading by its position in the document.
 *
 * The stand-in is faithful on this too, now that it has to be: a real deliverable's chapters are numbered `1..N`,
 * so a stand-in that concatenated unnumbered headings would put every document this file builds outside the one
 * contract the document format states — and the chapter class would then be exercised by nothing but its own
 * dedicated tests. Only the FIRST `## ` heading of a unit is touched, and `###` sub-headings never are.
 */
function numberFirstHeading(content: string, ordinal: number): string {
  return content.replace(/^## (?!\d+\.)/mu, `## ${ordinal}. `);
}

/**
 * A document for the checker, clean in every class unless the caller injects a defect.
 *
 * `plannedChapterCount` DEFAULTS TO WHAT THE MARKDOWN HOLDS, which makes the chapter-contract class silent for
 * every test that is about another class — the same service the other defaults perform. It is therefore NOT how
 * that class is exercised: the tests below that are about it state a count, `tests/chapter-inventory.test.ts`
 * covers the extraction and the four failing shapes over values, and on a real run the count is the run's own
 * recorded requirement rows, which no test can talk it out of.
 */
function document(units: readonly ConsistencyUnit[], overrides: Partial<ConsistencyDocument> = {}): ConsistencyDocument {
  const markdown = overrides.markdown ?? assembled(units);
  return {
    documentId: DOCUMENT,
    markdown,
    audience: overrides.audience ?? "product-manager",
    identifierPlacement: overrides.identifierPlacement ?? "evidence-only",
    // `Object.hasOwn`, not `??`: null is a MEANING here (this run recorded no chapter contract for the document),
    // and `null ?? default` would silently hand back the default — the caller asking for the vacuous arm would
    // have got the examined one and the test would have passed for the wrong reason.
    plannedChapterCount: Object.hasOwn(overrides, "plannedChapterCount")
      ? overrides.plannedChapterCount!
      : Math.max(1, numberedChapters(markdown).length),
    units
  };
}

/** A document whose units write the given chapter ordinals, one heading each, in the order given. */
function chaptered(ordinals: readonly number[], plannedChapterCount: number): ConsistencyDocument {
  const only = unit(LEAF);
  // The markdown is stated rather than assembled, so the position-numbering above cannot renumber these ordinals:
  // the whole point of this helper is to control what the document says its chapter numbers are.
  const markdown = [
    `<a id="${CONTENTS_ANCHOR}"></a>`,
    "",
    "## Contents",
    "",
    `<a id="${unitAnchorId(LEAF)}"></a>`,
    "",
    ...ordinals.map((ordinal) => `## ${ordinal}. 章 ${ordinal}\n\n${LEAF} 记录当前状态。\n`)
  ].join("\n");
  return document([only], { markdown, plannedChapterCount });
}

function workItem(id: string, status: WorkItemStatus): InvestigationWorkItem {
  return {
    id,
    dimension: "discarded-errors",
    scope: "project",
    hypothesis: "a synthetic obligation",
    status,
    material: true,
    requiredFor: [DOCUMENT],
    evidenceIds: [],
    traceIds: [],
    origin: "default"
  };
}

const LEDGER = new Map<string, InvestigationWorkItem>([
  ["project:unanswered", workItem("project:unanswered", "cannot-determine")],
  ["project:absent", workItem("project:absent", "searched-not-found")],
  ["project:settled", workItem("project:settled", "found")]
]);

function check(documents: readonly ConsistencyDocument[], frozenEvidenceIds: readonly string[] = [EVIDENCE]): ConsistencyResult {
  return checkUnitConsistency({ documents, workItems: LEDGER, frozenEvidenceIds });
}

function of(result: ConsistencyResult, kind: ConsistencyFindingKind): readonly ConsistencyFinding[] {
  return result.findings.filter((finding) => finding.kind === kind);
}

function reading(result: ConsistencyResult, kind: ConsistencyFindingKind): ConsistencyResult["readings"][number] {
  const row = result.readings.find((entry) => entry.kind === kind);
  assert.ok(row, `the result must hold a reading for ${kind}`);
  return row!;
}

/** Every finding of a result names at least one unit, and every named unit is one of the document's. */
function assertLocated(result: ConsistencyResult, documents: readonly ConsistencyDocument[]): void {
  const known = new Set(documents.flatMap((row) => row.units.map((entry) => entry.unitId)));
  for (const finding of result.findings) {
    assert.ok(finding.unitIds.length > 0, `${finding.kind} must name a unit: ${finding.statement}`);
    for (const unitId of finding.unitIds) assert.ok(known.has(unitId), `${finding.kind} names unknown unit ${unitId}`);
  }
}

// --- the closed union ---------------------------------------------------------------------------------

test("the six classes are the union, and every one of them answers why no collect gate sees it", () => {
  assert.deepEqual([...CONSISTENCY_FINDING_KINDS], [
    "terminology-drift", "unknown-overclaim", "cross-unit-contradiction", "dangling-reference", "policy-violation", "chapter-contract"
  ]);
  for (const kind of CONSISTENCY_FINDING_KINDS) {
    // Deleting one arm of `whyCollectCannotSee` makes its parameter stop being `never` and the build stops; the
    // clause itself is asserted non-trivial here so an arm cannot be satisfied with an empty string.
    assert.ok(whyCollectCannotSee(kind).length > 40, `${kind} must state why the collect gates cannot see it`);
  }
});

// --- 1. terminology drift ----------------------------------------------------------------------------

test("two units defining one term differently is a finding naming both; agreeing is not", () => {
  const drifted = [
    unit(LEAF, { terminology: [{ term: "Tenant", meaning: "一个付费客户" }] }),
    unit(OTHER, { terminology: [{ term: "tenant", meaning: "一个数据库 schema" }] })
  ];
  const result = check([document(drifted)]);
  const findings = of(result, "terminology-drift");
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0]!.unitIds, [LEAF, OTHER]);
  assert.match(findings[0]!.statement, /defines term "tenant" with 2 different meanings/);
  assert.match(findings[0]!.statement, /一个付费客户/);
  assert.match(findings[0]!.statement, /一个数据库 schema/);
  assertLocated(result, [document(drifted)]);

  // Removed: the same two units, one meaning. Case and surrounding whitespace are not a disagreement.
  const agreed = [
    unit(LEAF, { terminology: [{ term: "Tenant", meaning: "一个付费客户" }] }),
    unit(OTHER, { terminology: [{ term: "tenant", meaning: " 一个付费客户 " }] })
  ];
  assert.deepEqual(of(check([document(agreed)]), "terminology-drift"), []);
  assert.equal(reading(check([document(agreed)]), "terminology-drift").objects.state, "examined");
});

test("one unit defining one term twice with two meanings is drift too, and it names that unit", () => {
  const units = [unit(LEAF, { terminology: [{ term: "Tenant", meaning: "客户" }, { term: "Tenant", meaning: "schema" }] })];
  const findings = of(check([document(units)]), "terminology-drift");
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0]!.unitIds, [LEAF]);
});

test("no definition and no comparable definition are two different vacuous reasons", () => {
  const none = reading(check([document([unit(LEAF), unit(OTHER)])]), "terminology-drift");
  const disjoint = reading(check([document([
    unit(LEAF, { terminology: [{ term: "Tenant", meaning: "客户" }] }),
    unit(OTHER, { terminology: [{ term: "Schema", meaning: "表结构" }] })
  ])]), "terminology-drift");
  assert.equal(none.objects.state, "vacuous");
  assert.equal(disjoint.objects.state, "vacuous");
  assert.match(none.objects.state === "vacuous" ? none.objects.reason : "", /no unit of overview-product defines a term/);
  assert.match(disjoint.objects.state === "vacuous" ? disjoint.objects.reason : "", /no term is defined more than once/);
  assert.notEqual(none.statement, disjoint.statement);
});

// --- 2. unknown overclaim ----------------------------------------------------------------------------

test("a fact claim on an unanswered obligation is an overclaim; the unavailable claim beside it is not", () => {
  const claims: readonly SectionClaim[] = [
    { id: "U-1", marker: "unavailable", statement: "无法判定。", workItemIds: ["project:unanswered"] },
    { id: "F-1", marker: "fact", statement: "审批在 24 小时内完成。", workItemIds: ["project:unanswered"] }
  ];
  const units = [unit(LEAF, { claims })];
  const result = check([document(units)]);
  const findings = of(result, "unknown-overclaim");
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0]!.unitIds, [LEAF]);
  assert.match(findings[0]!.statement, /states claim F-1 as "fact" and links it to obligation project:unanswered, which this run's ledger records as "cannot-determine"/);
  // The reading counts BOTH links as objects: the legal one was examined and cleared, not skipped.
  const row = reading(result, "unknown-overclaim");
  assert.deepEqual(row.objects, { state: "examined", objects: 2, subject: "claim link(s) to obligations recorded as cannot-determine or searched-not-found" });

  // Removed: the same obligation with only the unavailable claim.
  assert.deepEqual(of(check([document([unit(LEAF, { claims: [claims[0]!] })])]), "unknown-overclaim"), []);
});

test("inferred overclaims too, verified does not, and a settled obligation is not this class's subject", () => {
  const inferred = check([document([unit(LEAF, { claims: [{ id: "I-1", marker: "inferred", statement: "推断。", workItemIds: ["project:absent"] }] })])]);
  assert.equal(of(inferred, "unknown-overclaim").length, 1);
  // `verified` reusing the search receipt is exactly what `searched-not-found` REQUIRES, so it may not be a finding.
  const verified = check([document([unit(LEAF, { claims: [{ id: "V-1", marker: "verified", statement: "已核实不存在。", workItemIds: ["project:absent"] }] })])]);
  assert.deepEqual(of(verified, "unknown-overclaim"), []);
  const settled = check([document([unit(LEAF, { claims: [{ id: "F-2", marker: "fact", statement: "事实。", workItemIds: ["project:settled"] }] })])]);
  assert.deepEqual(of(settled, "unknown-overclaim"), []);
  assert.equal(reading(settled, "unknown-overclaim").objects.state, "vacuous");
});

// --- 3. cross-unit contradiction ---------------------------------------------------------------------

test("one obligation asserted by one unit and disclaimed by another is a finding naming both", () => {
  const units = [
    unit(LEAF, { claims: [{ id: "F-1", marker: "fact", statement: "事实。", workItemIds: ["project:settled"] }] }),
    unit(OTHER, { claims: [{ id: "U-1", marker: "unavailable", statement: "无法判定。", workItemIds: ["project:settled"] }] })
  ];
  const result = check([document(units)]);
  const findings = of(result, "cross-unit-contradiction");
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0]!.unitIds, [LEAF, OTHER]);
  assert.equal(findings[0]!.kind === "cross-unit-contradiction" ? findings[0]!.conflict.shape : null, "incompatible-markers");
  assert.match(findings[0]!.statement, /both asserts and disclaims obligation project:settled/);

  // Removed: one unit holding both markers is NOT this class — it is within one unit, where the per-claim rules
  // and the overclaim class live.
  const oneUnit = [unit(LEAF, {
    claims: [
      { id: "F-1", marker: "fact", statement: "事实。", workItemIds: ["project:settled"] },
      { id: "U-1", marker: "unavailable", statement: "无法判定。", workItemIds: ["project:settled"] }
    ]
  })];
  assert.deepEqual(of(check([document(oneUnit)]), "cross-unit-contradiction"), []);
});

test("an inferred claim in one unit against an unavailable claim in another is a contradiction too", () => {
  // One reading of `inferred` across the two classes: the overclaim class treats an inference as a statement about
  // the system, so this class must too — otherwise a document infers a conclusion about an obligation while another
  // unit records that nobody could reach one, and nothing says so.
  const units = [
    unit(LEAF, { claims: [{ id: "I-1", marker: "inferred", statement: "推断为是。", workItemIds: ["project:settled"] }] }),
    unit(OTHER, { claims: [{ id: "U-1", marker: "unavailable", statement: "无法判定。", workItemIds: ["project:settled"] }] })
  ];
  const findings = of(check([document(units)]), "cross-unit-contradiction");
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0]!.unitIds, [LEAF, OTHER]);
  const conflict = findings[0]!.kind === "cross-unit-contradiction" ? findings[0]!.conflict : null;
  assert.deepEqual(conflict?.shape === "incompatible-markers" ? conflict.asserting.map((row) => row.marker) : null, ["inferred"]);
});

test("one disagreement between two claims is ONE finding, however many evidence pairs it spans", () => {
  // `[[E1,E2,E3]]` against `[[E1],[E2],[E3]]` disagrees about three pairs and is one disagreement between one pair
  // of claims. Reporting it three times tripled the finding count and the examined objects for one repair.
  const together: SectionClaim = { id: "S-1", marker: "fact", statement: "两者共享同一阈值。", evidenceIds: ["E-1", "E-2", "E-3"], sides: [["E-1", "E-2", "E-3"], ["E-4"]] };
  const apart: SectionClaim = { id: "S-2", marker: "fact", statement: "两者共享同一阈值。", evidenceIds: ["E-1", "E-2", "E-3"], sides: [["E-1"], ["E-2"], ["E-3"]] };
  const result = check([document([unit(LEAF, { claims: [{ ...together, evidenceIds: ["E-1", "E-2", "E-3", "E-4"] }] }), unit(OTHER, { claims: [apart] })])]);
  const findings = of(result, "cross-unit-contradiction");
  assert.equal(findings.length, 1, findings.map((row) => row.statement).join("\n"));
  const conflict = findings[0]!.kind === "cross-unit-contradiction" ? findings[0]!.conflict : null;
  assert.deepEqual(conflict?.shape === "comparison-side-disagreement" ? conflict.evidencePairs : null,
    [["E-1", "E-2"], ["E-1", "E-3"], ["E-2", "E-3"]]);
  assert.match(findings[0]!.statement, /disagrees about 3 evidence pair\(s\)/);
});

test("two units disagreeing about which side of a comparison a pair of evidence is on is a finding", () => {
  const together: SectionClaim = {
    id: "S-1",
    marker: "fact",
    statement: "两者共享同一阈值。",
    evidenceIds: ["E-1", "E-2", "E-3"],
    sides: [["E-1", "E-2"], ["E-3"]]
  };
  const apart: SectionClaim = {
    id: "S-2",
    marker: "fact",
    statement: "两者共享同一阈值。",
    evidenceIds: ["E-1", "E-2"],
    sides: [["E-1"], ["E-2"]]
  };
  const result = check([document([unit(LEAF, { claims: [together] }), unit(OTHER, { claims: [apart] })])]);
  const findings = of(result, "cross-unit-contradiction");
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0]!.unitIds, [LEAF, OTHER]);
  const conflict = findings[0]!.kind === "cross-unit-contradiction" ? findings[0]!.conflict : null;
  assert.equal(conflict?.shape, "comparison-side-disagreement");
  assert.deepEqual(conflict?.shape === "comparison-side-disagreement" ? conflict.evidencePairs : null, [["E-1", "E-2"]]);

  // Removed: two units grouping the same pair the same way is agreement, and it is still an EXAMINED object.
  const agreeing = check([document([unit(LEAF, { claims: [together] }), unit(OTHER, { claims: [{ ...together, id: "S-3" }] })])]);
  assert.deepEqual(of(agreeing, "cross-unit-contradiction"), []);
  assert.equal(reading(agreeing, "cross-unit-contradiction").objects.state, "examined");
});

// --- 4. dangling reference ---------------------------------------------------------------------------

test("a prose link the assembled document cannot resolve is a finding; a heading slug resolves", () => {
  const dangling = unit(LEAF, { content: `## ${LEAF}\n\n见 [下文](#nowhere-at-all)。\n` });
  const result = check([document([dangling])]);
  const findings = of(result, "dangling-reference");
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0]!.unitIds, [LEAF]);
  assert.match(findings[0]!.statement, /links to "#nowhere-at-all"/);

  // Removed: a link to a heading THIS document holds. The slug convention is part of the resolvable set precisely
  // so a link that works in a reader's renderer is not reported as a repair.
  const resolvable = unit(LEAF, { content: `## ${LEAF}\n\n### Current behaviour\n\n见 [下文](#current-behaviour)。\n` });
  assert.deepEqual(of(check([document([resolvable])]), "dangling-reference"), []);
  // And a link to the assembler's own contents anchor resolves.
  const toContents = unit(LEAF, { content: `## ${LEAF}\n\n见 [目录](#${CONTENTS_ANCHOR})。\n` });
  assert.deepEqual(of(check([document([toContents])]), "dangling-reference"), []);
});

test("a link inside a fenced code block is an example, not a dangling reference", () => {
  // A unit documenting markdown syntax writes a literal link nobody follows. Reporting it would put that unit AND
  // every ancestor into a repair set for nothing, and a repair set is required to be exact.
  const fenced = unit(LEAF, { content: `## ${LEAF}\n\n写法如下：\n\n\`\`\`markdown\n[见下文](#nowhere-at-all)\n<a id="${CONTENTS_ANCHOR}"></a>\n\`\`\`\n` });
  const result = check([document([fenced])]);
  assert.deepEqual(of(result, "dangling-reference"), [], result.findings.map((row) => row.statement).join("\n"));
  // And the same two shapes OUTSIDE the fence are still findings, so the exclusion is not a hole.
  const bare = unit(LEAF, { content: `## ${LEAF}\n\n[见下文](#nowhere-at-all)\n<a id="${CONTENTS_ANCHOR}"></a>\n` });
  assert.equal(of(check([document([bare])]), "dangling-reference").length, 2);
  // An inline code span is code too.
  const inline = unit(LEAF, { content: `## ${LEAF}\n\n锚点写法是 \`[x](#nowhere-at-all)\`。\n` });
  assert.deepEqual(of(check([document([inline])]), "dangling-reference"), []);
});

test("a titled link is a reference like any other, counted and resolved", () => {
  // The regex used to require `](#target)` exactly, so `](#target "title")` was neither resolved nor counted — a
  // silent fourth state for a legal markdown shape.
  const titled = unit(LEAF, { content: `## ${LEAF}\n\n见 [下文](#nowhere-at-all "说明")。\n` });
  const findings = of(check([document([titled])]), "dangling-reference");
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.statement, /links to "#nowhere-at-all"/);
  const resolvable = unit(LEAF, { content: `## ${LEAF}\n\n见 [目录](#${CONTENTS_ANCHOR} '说明')。\n` });
  assert.deepEqual(of(check([document([resolvable])]), "dangling-reference"), []);
});

test("a prose anchor id the document already holds is a duplicate, named to the unit that wrote it", () => {
  const duplicate = unit(LEAF, { content: `## ${LEAF}\n\n<a id="${CONTENTS_ANCHOR}"></a>\n\n正文。\n` });
  const findings = of(check([document([duplicate])]), "dangling-reference");
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0]!.unitIds, [LEAF]);
  const reference = findings[0]!.kind === "dangling-reference" ? findings[0]!.reference : null;
  assert.deepEqual(reference, { shape: "duplicate-anchor", anchorId: CONTENTS_ANCHOR, occurrences: 2 });

  // Two units writing the same id name both of them: either one changing resolves it, and Core does not choose.
  const both = [
    unit(LEAF, { content: `## ${LEAF}\n\n<a id="glossary"></a>\n` }),
    unit(OTHER, { content: `## ${OTHER}\n\n<a id="glossary"></a>\n` })
  ];
  const shared = of(check([document(both)]), "dangling-reference");
  assert.equal(shared.length, 1);
  assert.deepEqual(shared[0]!.unitIds, [LEAF, OTHER]);
});

test("a claim citing a work item this run's ledger does not hold is a dangling reference", () => {
  const units = [unit(LEAF, { claims: [{ id: "F-1", marker: "fact", statement: "事实。", workItemIds: ["project:invented"] }] })];
  const findings = of(check([document(units)]), "dangling-reference");
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0]!.unitIds, [LEAF]);
  assert.match(findings[0]!.statement, /citing work item project:invented, which this run's obligation ledger does not hold/);
  // And it is not ALSO reported as an overclaim: a status cannot be read off a row that does not exist.
  assert.deepEqual(of(check([document(units)]), "unknown-overclaim"), []);
});

test("a document whose units write no reference at all is vacuous, not zero", () => {
  const row = reading(check([document([unit(LEAF, { content: `## ${LEAF}\n\n正文。\n` })])]), "dangling-reference");
  assert.equal(row.objects.state, "vacuous");
  assert.match(row.statement, /^vacuous: dangling-reference had no object to check/);
});

test("the anchor reading resolves explicit ids and heading slugs, and counts duplicates over explicit ids only", () => {
  // `## Contents` slugs to `contents` and the assembler ALSO emits `<a id="contents">`: intended, and not a
  // duplicate — folding the two conventions together would report the assembler's own document as broken.
  const anchors = readDocumentAnchors(`<a id="contents"></a>\n\n## Contents\n\n## Contents\n`);
  assert.deepEqual(anchors.duplicateAnchorIds, []);
  assert.ok(anchors.resolvable.has("contents"));
  assert.ok(anchors.resolvable.has("contents-1"), "a repeated heading takes the -1 suffix a slugger gives it");
  assert.equal(headingSlug("Current Behaviour & Limits"), "current-behaviour--limits");
  assert.equal(headingSlug("当前状态"), "当前状态");
  // Both spellings are resolvable, because renderers differ on whether the removed `&` leaves one hyphen or two,
  // and a link a reader's renderer resolves must never be reported as a repair.
  const punctuated = readDocumentAnchors("## Current Behaviour & Limits\n");
  assert.ok(punctuated.resolvable.has("current-behaviour--limits"));
  assert.ok(punctuated.resolvable.has("current-behaviour-limits"));
});

// --- 5. audience / policy violation ------------------------------------------------------------------

test("an evidence id in visible prose violates an evidence-only lens and not an in-prose one", () => {
  const leaking = unit(LEAF, { content: `## ${LEAF}\n\n证据 ${EVIDENCE} 显示当前行为。\n` });
  const strict = check([document([leaking])]);
  const findings = of(strict, "policy-violation");
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0]!.unitIds, [LEAF]);
  assert.match(findings[0]!.statement, /puts evidence id S-b524a4194f in the visible prose/);

  const relaxed = check([document([leaking], { audience: "engineer", identifierPlacement: "in-prose" })]);
  assert.deepEqual(of(relaxed, "policy-violation"), []);
  assert.match(reading(relaxed, "policy-violation").statement, /lens places identifiers in prose/);

  // THREE STATES, NOT TWO. A run that sealed no evidence id has no denominator for the rule — and it must not say
  // the lens allows identifiers in prose, because this lens does not. Folding the two into one boolean made the
  // reading state something false about the policy.
  const noIdentifiers = check([document([leaking])], []);
  assert.deepEqual(of(noIdentifiers, "policy-violation"), []);
  assert.match(reading(noIdentifiers, "policy-violation").statement,
    /lens IS evidence-only, but this run sealed no evidence id, so that rule had no object to check/);
  assert.notEqual(reading(noIdentifiers, "policy-violation").statement, reading(relaxed, "policy-violation").statement);

  // A longer id that merely CONTAINS a sealed one is not a match: the boundary is the id character class.
  const longer = unit(LEAF, { content: `## ${LEAF}\n\n证据 ${EVIDENCE}0 显示当前行为。\n` });
  assert.deepEqual(of(check([document([longer])]), "policy-violation"), []);
});

test("advice a unit does not negate is a violation, and the negated disclaimer is not", () => {
  const advising = unit(LEAF, { content: `## ${LEAF}\n\n修复建议见附录，请将超时下调。\n` });
  const findings = of(check([document([advising])], []), "policy-violation");
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.statement, /tells the reader what to do and nothing negates it/);

  const disclaiming = unit(LEAF, { content: `## ${LEAF}\n\n本节不给出修复建议，只记录当前行为。\n` });
  assert.deepEqual(of(check([document([disclaiming])], []), "policy-violation"), []);
});

// --- the result as a whole ---------------------------------------------------------------------------

test("a clean document reports six readings, zero findings, and no boolean anywhere", () => {
  const units = [unit(LEAF), unit(OTHER), unit(ROOT)];
  const result = check([document(units)]);
  assert.equal(result.version, UNIT_CONSISTENCY_VERSION);
  assert.deepEqual(result.documents, [DOCUMENT]);
  assert.deepEqual(result.readings.map((row) => row.kind), [...CONSISTENCY_FINDING_KINDS]);
  assert.deepEqual(result.findings, []);
  assert.ok(!Object.keys(result).includes("passed"));
  for (const row of result.readings) assert.equal(row.statement, describeClassReading(row));
});

test("the readings of two documents are kept apart, and a finding is scoped to its own document", () => {
  const first = document([
    unit(LEAF, { terminology: [{ term: "Tenant", meaning: "客户" }] }),
    unit(OTHER, { terminology: [{ term: "Tenant", meaning: "schema" }] })
  ]);
  const second: ConsistencyDocument = { ...document([unit(`overview-engineering::leaf::one`)]), documentId: "overview-engineering" };
  const result = check([first, second]);
  assert.deepEqual(result.documents, [DOCUMENT, "overview-engineering"]);
  assert.equal(result.readings.length, CONSISTENCY_FINDING_KINDS.length * 2);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.documentId, DOCUMENT);
});

test("the same input twice is the same findings in the same order", () => {
  const units = [
    unit(LEAF, { content: `## ${LEAF}\n\n见 [x](#nope) 与 [y](#nope2)。修复建议见附录。\n`, terminology: [{ term: "T", meaning: "a" }] }),
    unit(OTHER, { terminology: [{ term: "T", meaning: "b" }] })
  ];
  const one = check([document(units)]);
  const two = check([document(units)]);
  assert.equal(JSON.stringify(one), JSON.stringify(two));
  assert.ok(one.findings.length >= 4, `the mixed fixture must fire several classes: ${one.findings.map((row) => row.kind).join(", ")}`);
  for (const finding of one.findings) assert.ok(describeFinding(finding).length > 10, finding.statement);
});

test("a document handed over with no unit is a named refusal, not an empty reading", () => {
  assert.throws(() => check([document([])]), /was handed to the consistency checker with no unit/);
});

// --- 6. chapter contract ------------------------------------------------------------------------------------

test("a document with one chapter more than the run recorded is a chapter-contract finding naming every unit", () => {
  // The measured defect, at the size it was measured: eleven numbered chapters against ten recorded rows.
  const eleven = chaptered([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 10);
  const findings = check([eleven]).findings.filter((finding) => finding.kind === "chapter-contract");
  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.equal(finding!.kind === "chapter-contract" && finding!.problem.shape, "chapter-count");
  assert.match(finding!.statement, /11 numbered chapter\(s\)/u);
  assert.match(finding!.statement, /10 requirement row\(s\)/u);
  assert.deepEqual(finding!.unitIds, [LEAF], "a finding nobody can locate is worth nothing to a repair set");
});

test("a document with one chapter fewer than the run recorded is a chapter-contract finding", () => {
  const findings = check([chaptered([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 11)]).findings.filter((finding) => finding.kind === "chapter-contract");
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.statement, /10 numbered chapter\(s\)/u);
  assert.match(findings[0]!.statement, /11 requirement row\(s\)/u);
});

test("chapters out of order and chapters with a gap are both chapter-contract findings, with the count intact", () => {
  for (const ordinals of [[1, 3, 2], [1, 2, 4]] as const) {
    const findings = check([chaptered(ordinals, 3)]).findings.filter((finding) => finding.kind === "chapter-contract");
    assert.equal(findings.length, 1, `${ordinals.join(",")} must be one finding`);
    const [finding] = findings;
    // The count matches, so this is the SEQUENCE shape: reporting it as a count problem would ask for the wrong
    // repair (write another chapter) instead of the right one (renumber).
    assert.equal(finding!.kind === "chapter-contract" && finding!.problem.shape, "chapter-sequence");
    assert.ok(finding!.statement.includes(`chapter(s) ${ordinals.join(", ")} rather than 1..3`), finding!.statement);
  }
});

test("a document numbered 1..N in order has no chapter-contract finding, and the class still says what it examined", () => {
  const clean = chaptered([1, 2, 3, 4, 5], 5);
  const result = check([clean]);
  assert.deepEqual(result.findings.filter((finding) => finding.kind === "chapter-contract"), []);
  const row = reading(result, "chapter-contract");
  // Never vacuous: the run recorded a contract, so there is always an object. A vacuous arm here would be the
  // cheapest escape from the gate — write no numbered chapter at all and be reported as having nothing to check.
  assert.equal(row.objects.state, "examined");
  assert.equal(row.objects.state === "examined" && row.objects.objects, 5);
  assert.match(row.statement, /5 template-section requirement row\(s\)/u);
});

test("the assembler's own Contents and Companions headings are not chapters", () => {
  // The assembled stand-in already emits `## Contents`; `## Companions` is added here so both of the headings the
  // real assembler writes are present. Neither carries a number, so a document that owes 2 chapters and writes 2
  // is clean with both of them in place — and would be short by two if they were counted.
  const withCompanions = chaptered([1, 2], 2);
  const markdown = `${withCompanions.markdown}\n\n## Companions\n\n| companion | path |\n`;
  const result = check([{ ...withCompanions, markdown }]);
  assert.deepEqual(result.findings.filter((finding) => finding.kind === "chapter-contract"), []);
  assert.equal(numberedChapters(markdown).length, 2, "the two assembler headings must not be counted as chapters");
  assert.ok(markdown.includes("## Contents") && markdown.includes("## Companions"), "both assembler headings are in these bytes");
});

test("a document this run recorded no chapter contract for is vacuous, and only that class is", () => {
  // The one vacuous arm, and it is about the CONTRACT rather than the document. A run that used the
  // `request-append` door assembles a document `contract/requirements.json` holds no row for; refusing it would
  // produce no reading for ANY document of that run, and holding it to 0 would call every chapter it wrote an
  // excess. `tests/unit-consistency-e2e.test.ts` drives the same state through the real append and re-plan doors.
  const result = check([document([unit(LEAF)], { plannedChapterCount: null })]);
  assert.deepEqual(result.findings.filter((finding) => finding.kind === "chapter-contract"), []);
  const row = reading(result, "chapter-contract");
  assert.equal(row.objects.state, "vacuous");
  assert.match(row.statement, /records no template-section requirement row/u);
  // A document that DOES have a contract and writes no chapter is still a finding: the vacuum is not an escape.
  const noChapters = check([{ ...document([unit(LEAF)]), markdown: "## 概述\n\n正文。\n", plannedChapterCount: 3 }]);
  assert.equal(noChapters.findings.filter((finding) => finding.kind === "chapter-contract").length, 1);
});

test("an unterminated code fence is named in the finding, because it is what swallowed the chapters", () => {
  // A renderer runs an unclosed fence to the end of the document, so the count is right about what a reader sees —
  // but the repair is one backtick, not the chapters an author would otherwise go looking for, and this class
  // seeds every unit of the document.
  const swallowed = { ...chaptered([1], 3), markdown: "## 1. 一\n\n```mermaid\ngraph TD\n\n## 2. 二\n\n## 3. 三\n", plannedChapterCount: 3 };
  const findings = check([swallowed]).findings.filter((finding) => finding.kind === "chapter-contract");
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.statement, /a code fence opened on line 3 of the assembled document is never closed/u);
});

test("the chapter class is reachable for every audience, not only the prd lens", () => {
  // The issue's review point: this gate is about the chapter contract every template states, so a document for an
  // engineer reader is held to it exactly as a prd one is — and its count comes from ITS OWN recorded rows.
  const engineering = { ...chaptered([1, 2, 3], 4), audience: "engineer" as const, identifierPlacement: "in-prose" as const };
  const findings = check([engineering]).findings.filter((finding) => finding.kind === "chapter-contract");
  assert.equal(findings.length, 1, "an engineering deliverable owes its recorded chapters too");
  assert.equal(reading(check([{ ...engineering, plannedChapterCount: 3 }]), "chapter-contract").findings, 0);
});
