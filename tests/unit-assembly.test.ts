/**
 * The pure half of unit assembly: where the bytes land, and what the bytes are.
 *
 * The two properties that make an assembled document trustworthy are stated STRUCTURALLY here, not by comparing
 * against a list of expected entries — an expected-entry list is a second copy of the plan, and it would go green
 * against a renderer that dropped a unit as long as somebody remembered to delete the row too:
 *
 *   * CONTENTS CONSERVATION — the contents table's rows are in bijection with the document's planned units, in the
 *     plan's own order. Falsified below by handing the renderer a units list with one member removed and watching
 *     the derived bijection break, and by the renderer's own refusals for the shapes that would corrupt it.
 *   * ANCHOR RESOLUTION — every `(#anchor)` this document links to is an anchor this document also emits. Extracted
 *     from the rendered text by regex on both sides, so a link the renderer invents has nowhere to hide.
 *
 * The conflict refusal gets both sides as parameters, so the negative case is a real overlapping pair rather than a
 * shape the real derivation cannot produce — and the pair used is the one a real request produces: `plannedDocumentId`
 * names a product overview `overview-product`, and `reportFileName` names a FEATURE document whose subject slugs to
 * `overview` exactly the same thing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { DocumentPlan } from "../src/base/types.ts";
import { reportFileName } from "../src/report/authoring-plan.ts";
import { plannedDocumentId } from "../src/report/legacy-request-mapping.ts";
import { reportRequestRecordFor } from "../src/report/report-requests-artifact.ts";
import {
  assertNoSectionPathConflict,
  assertDistinctUnitDocumentTargets,
  assertUsableUnitDocumentId,
  documentTargetFoldKey,
  runRelativePath,
  UNIT_COVERAGE_COMPANION_PATH,
  unitDocumentCompanionPaths,
  unitDocumentReportPath,
  unitDocumentTargets
} from "../src/report/unit-assembly-paths.ts";
import {
  assemblyUnitsInOrder,
  CONTENTS_ANCHOR,
  parentUnitIdByChild,
  renderUnitDocument,
  unitAnchorId,
  UNIT_ASSEMBLY_VERSION,
  type AssemblyIdentity,
  type AssemblyUnit,
  type UnitDocumentAssembly
} from "../src/report/unit-assembly.ts";

const DOCUMENT_ID = "overview-product";

const IDENTITY: AssemblyIdentity = {
  runId: "run-2026_01_02_03_04-overview-aaaa-bbbb-cccc",
  knowledgeEpoch: 3,
  knowledgeDigest: "a".repeat(64),
  planCatalogDigest: "b".repeat(64),
  planRevision: 1,
  sourceText: "verbatim"
};

const REQUEST = reportRequestRecordFor({
  documentId: DOCUMENT_ID,
  kind: "overview",
  audience: "product",
  featureKey: null,
  detailLevel: "standard",
  language: "zh-CN"
});

const UNITS: readonly AssemblyUnit[] = [
  { unitId: `${DOCUMENT_ID}::leaf::route`, kind: "leaf", title: "Routes", parentUnitId: `${DOCUMENT_ID}::synthesis::document`, content: "## Routes\n\nleaf prose\n" },
  { unitId: `${DOCUMENT_ID}::appendix::coverage`, kind: "appendix", title: "Coverage and unknowns", parentUnitId: `${DOCUMENT_ID}::synthesis::document`, content: "## Coverage and unknowns\n\nappendix prose\n" },
  { unitId: `${DOCUMENT_ID}::synthesis::document`, kind: "synthesis", title: "Product overview", parentUnitId: null, content: "## Product overview\n\nsynthesis prose\n" }
];

function assembly(units: readonly AssemblyUnit[] = UNITS): UnitDocumentAssembly {
  return {
    documentId: DOCUMENT_ID,
    title: "Product overview",
    identity: IDENTITY,
    request: REQUEST,
    companions: unitDocumentCompanionPaths(DOCUMENT_ID),
    units
  };
}

/** Every `(#anchor)` target the rendered document links to. */
function linkedAnchors(markdown: string): string[] {
  return [...markdown.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1]!);
}

/** Every anchor the rendered document emits. */
function emittedAnchors(markdown: string): string[] {
  return [...markdown.matchAll(/<a id="([^"]+)"><\/a>/g)].map((match) => match[1]!);
}

/** The contents table's rows, as (order, link target, kind, parent target). */
function contentsRows(markdown: string): Array<{ order: number; anchor: string; kind: string; parent: string }> {
  const body = markdown.split("## Contents")[1]!.split("## Companions")[0]!;
  return body
    .split("\n")
    .filter((line) => /^\| \d+ \|/.test(line))
    .map((line) => {
      const cells = line.split("|").map((cell) => cell.trim());
      return {
        order: Number(cells[1]),
        anchor: /\(#([^)]+)\)/.exec(cells[2]!)?.[1] ?? "",
        kind: cells[3]!,
        parent: /\(#([^)]+)\)/.exec(cells[4]!)?.[1] ?? cells[4]!
      };
    });
}

test("the contents table is in bijection with the document's units, in the order it was handed", () => {
  const markdown = renderUnitDocument(assembly());
  const rows = contentsRows(markdown);
  assert.equal(rows.length, UNITS.length, markdown);
  assert.deepEqual(rows.map((row) => row.order), UNITS.map((_, index) => index + 1));
  assert.deepEqual(rows.map((row) => row.anchor), UNITS.map((unit) => unitAnchorId(unit.unitId)));
  assert.deepEqual(rows.map((row) => row.kind), UNITS.map((unit) => unit.kind));
  assert.deepEqual(
    rows.map((row) => row.parent),
    UNITS.map((unit) => (unit.parentUnitId === null ? "(root)" : unitAnchorId(unit.parentUnitId)))
  );
  // And every unit's own bytes are in the document exactly once, so the table is not the only evidence it is there.
  for (const unit of UNITS) {
    assert.equal(markdown.split(unit.content.trim()).length - 1, 1, `${unit.unitId} must appear exactly once`);
  }
});

test("a unit missing from the assembly order is missing from the contents table — the conservation that catches it", () => {
  // The falsification for the assertion above: drop one unit and the bijection with the PLAN's units breaks. This
  // is what a renderer that silently skipped a unit would look like from the outside.
  const short = UNITS.slice(0, 2);
  const rows = contentsRows(renderUnitDocument(assembly(short)));
  assert.equal(rows.length, 2);
  assert.ok(!rows.some((row) => row.anchor === unitAnchorId(UNITS[2]!.unitId)), "the dropped unit must not be in the table");
  assert.notEqual(rows.length, UNITS.length, "a dropped unit must not still satisfy the plan-sized bijection");
});

test("every anchor the document links to is an anchor the document emits", () => {
  const markdown = renderUnitDocument(assembly());
  const emitted = new Set(emittedAnchors(markdown));
  assert.deepEqual([...emitted].sort(), [CONTENTS_ANCHOR, ...UNITS.map((unit) => unitAnchorId(unit.unitId))].sort());
  const linked = linkedAnchors(markdown);
  assert.ok(linked.length >= UNITS.length * 2, `${linked.length} link(s) is too few to be navigation`);
  for (const anchor of linked) assert.ok(emitted.has(anchor), `link target #${anchor} has no anchor in the document`);
});

test("navigation walks the order it was handed: no previous on the first unit, no next on the last, parent only where there is one", () => {
  const markdown = renderUnitDocument(assembly());
  const navigation = markdown.split("\n").filter((line) => line.startsWith("[contents](#"));
  assert.equal(navigation.length, UNITS.length);
  assert.ok(!navigation[0]!.includes("[previous:"), navigation[0]);
  assert.ok(navigation[0]!.includes(`[next: Coverage and unknowns](#${unitAnchorId(UNITS[1]!.unitId)})`), navigation[0]);
  assert.ok(!navigation[UNITS.length - 1]!.includes("[next:"), navigation[UNITS.length - 1]);
  assert.ok(!navigation[UNITS.length - 1]!.includes("[parent:"), "the root unit has no parent link");
  assert.ok(navigation[0]!.includes("[parent: Product overview]"), navigation[0]);
});

test("the front matter pins the request row, both policy references, the epoch and the plan, and claims no coverage", () => {
  const markdown = renderUnitDocument(assembly());
  // Framed with newlines on both sides so an assertion below cannot match a line only partially.
  const front = `\n${markdown.split("---\n")[1]!}`;
  for (const line of [
    `assembly: ${UNIT_ASSEMBLY_VERSION}`,
    'documentId: "overview-product"',
    "scope: project",
    "scopeIds: []",
    "audience: product-manager",
    "intent: overview",
    "detailBudget: standard",
    'language: "zh-CN"',
    `lensPolicy: "${REQUEST.lensPolicy.id}@${REQUEST.lensPolicy.version}"`,
    `lensPolicyDigest: ${REQUEST.lensPolicy.digest}`,
    `intentPolicy: "${REQUEST.intentPolicy.id}@${REQUEST.intentPolicy.version}"`,
    `intentPolicyDigest: ${REQUEST.intentPolicy.digest}`,
    "knowledgeEpoch: 3",
    `knowledgeDigest: ${IDENTITY.knowledgeDigest}`,
    `planCatalogDigest: ${IDENTITY.planCatalogDigest}`,
    "planRevision: 1",
    "units: 3",
    `coverageCompanion: "${UNIT_COVERAGE_COMPANION_PATH}"`,
    "sourceText: verbatim"
  ]) {
    assert.ok(front.includes(`\n${line}\n`), `front matter is missing ${JSON.stringify(line)}:\n${front}`);
  }
  // Gate 10's wording rule, one level up: the deliverable's header may not say a coverage word the companion did
  // not decide. No percentage, no "complete", no "covered" — the account is the companion and the header links to it.
  assert.ok(!/%/.test(front), front);
  assert.ok(!/complete|covered|coverage state/i.test(front), front);
  assert.ok(front.includes(`coverageCompanion: "${UNIT_COVERAGE_COMPANION_PATH}"`));
  assert.ok(markdown.includes("This document states no coverage figure of its own."));
  assert.ok(!/\d+%/.test(markdown), "an assembled document states no percentage anywhere");
});

test("redaction travels with the deliverable, exhaustively over both arms", () => {
  const redacted = renderUnitDocument({ ...assembly(), identity: { ...IDENTITY, sourceText: "redacted" } });
  assert.ok(redacted.includes("\nsourceText: redacted\n"));
  assert.ok(renderUnitDocument(assembly()).includes("\nsourceText: verbatim\n"));
});

test("nothing in an assembled document is a clock reading, which is what makes a second assemble idempotent", () => {
  const first = renderUnitDocument(assembly());
  const second = renderUnitDocument(assembly());
  assert.equal(first, second);
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(first), "an ISO instant in the deliverable would break byte idempotence");
});

test("a plan title that would break the table or the link is escaped, not passed through", () => {
  const hostile = [{ ...UNITS[2]!, title: "Pipes | and [brackets] and \\slash" }];
  const markdown = renderUnitDocument({ ...assembly(hostile), title: hostile[0]!.title, units: hostile });
  const rows = contentsRows(markdown);
  assert.equal(rows.length, 1, `an unescaped pipe would add a column:\n${markdown}`);
  assert.ok(markdown.includes("Pipes \\| and \\[brackets\\] and \\\\slash"));
  for (const anchor of linkedAnchors(markdown)) {
    assert.ok(new Set(emittedAnchors(markdown)).has(anchor), `link target #${anchor} has no anchor`);
  }
});

test("the three shapes that would corrupt a document are refused by name", () => {
  assert.throws(() => renderUnitDocument(assembly([])), /has no unit to assemble/);
  assert.throws(() => renderUnitDocument(assembly([UNITS[0]!, UNITS[0]!])), /lists unit "overview-product::leaf::route" twice/);
  // Two ids one anchor: the same collapse `assertDistinctUnitPathKeys` refuses for directories, restated for anchors.
  assert.throws(
    () => renderUnitDocument(assembly([UNITS[0]!, { ...UNITS[0]!, unitId: `${DOCUMENT_ID}::leaf::route` }])),
    /twice/
  );
});

test("assemblyUnitsInOrder takes the plan's order and refuses an order that misses a unit", () => {
  const ids = UNITS.map((unit) => unit.unitId);
  assert.deepEqual(assemblyUnitsInOrder(DOCUMENT_ID, UNITS, ids).map((unit) => unit.unitId), ids);
  // Reversed order: the units come back in the ORDER, not in the array's order — the plan is the authority.
  assert.deepEqual(assemblyUnitsInOrder(DOCUMENT_ID, UNITS, [...ids].reverse()).map((unit) => unit.unitId), [...ids].reverse());
  assert.throws(
    () => assemblyUnitsInOrder(DOCUMENT_ID, UNITS, ids.slice(0, 2)),
    /has 1 unit\(s\) the plan's collection order does not name \(overview-product::synthesis::document\)/
  );
});

test("the unit path's targets are named once and derived, never re-spelled", () => {
  assert.equal(unitDocumentReportPath(DOCUMENT_ID), "reports/overview-product.md");
  assert.deepEqual(unitDocumentCompanionPaths(DOCUMENT_ID), {
    claims: "reports/companions/overview-product.unit-claims.json",
    traces: "reports/companions/overview-product.unit-traces.json",
    coverage: UNIT_COVERAGE_COMPANION_PATH
  });
  assert.equal(UNIT_COVERAGE_COMPANION_PATH, "reports/companions/unit-coverage.md");
});

test("a document id that would escape the run cannot become a report file name", () => {
  for (const [documentId, expected] of [
    ["../../etc/passwd", /contains a path separator/],
    ["overview/product", /contains a path separator/],
    ["a..b", /contains a path traversal segment/],
    ["nul", /Windows reserved device name/],
    ["   ", /is blank/]
  ] as const) {
    assert.throws(() => assertUsableUnitDocumentId(documentId), expected, `accepted ${JSON.stringify(documentId)}`);
    assert.throws(() => unitDocumentReportPath(documentId), /cannot name a unit-path report file/);
    assert.throws(() => unitDocumentCompanionPaths(documentId), /cannot name a unit-path report file/);
  }
  // The refusal names the document, not only the rule: which document was about to be written where is the fix.
  assert.throws(() => unitDocumentReportPath("../x"), /Document "\.\.\/x" cannot name a unit-path report file/);
});

test("a unit target that a section report already names is refused, and the colliding pair is one a real request produces", () => {
  // The section path names a FEATURE document after its subject: `reportFileName` yields `overview-product.md` for a
  // feature whose subject slugs to "overview" at the product audience. The unit path names the product OVERVIEW
  // document `overview-product.md`, because that is the document id `plannedDocumentId` mints for it. So a run
  // asking for a product overview plus a feature called "overview" reaches this refusal with no file hand-edited.
  const overviewDocumentId = plannedDocumentId("overview", "product", null);
  assert.equal(overviewDocumentId, "overview-product");
  const featureDocument = { id: "feature-overview-abcdef0123-product", kind: "feature", audience: "product", subject: "overview", templatePath: "", contextPath: "", sections: [] } as unknown as DocumentPlan;
  assert.equal(reportFileName(featureDocument), "overview-product.md");

  const unitTargets = [{ documentId: overviewDocumentId, path: unitDocumentReportPath(overviewDocumentId) }];
  const sectionTargets = [{ documentId: featureDocument.id, path: `reports/${reportFileName(featureDocument)}` }];
  assert.throws(
    () => assertNoSectionPathConflict(unitTargets, sectionTargets),
    /Unit-path document "overview-product" would assemble into "reports\/overview-product\.md", which the section path already names for document "feature-overview-abcdef0123-product"/
  );
  // And the non-colliding case passes, so the guard is not simply always red.
  assert.doesNotThrow(() => assertNoSectionPathConflict(unitTargets, [{ documentId: "overview-product", path: "reports/product-overview.md" }]));
});

test("the conflict guard covers companions too, and reports the first section owner rather than guessing", () => {
  const companions = unitDocumentCompanionPaths("x");
  assert.throws(
    () => assertNoSectionPathConflict([{ documentId: "x", path: companions.claims }], [{ documentId: "y", path: companions.claims }]),
    /would assemble into "reports\/companions\/x\.unit-claims\.json", which the section path already names for document "y"/
  );
  assert.doesNotThrow(() => assertNoSectionPathConflict([], []));
});

test("the write-path builder resolves inside the run and refuses anything that climbs out", () => {
  // A construction tripwire is only worth having if its shape is known, so it is made to fire here: today every
  // input comes from `unitDocumentTargets`, which refused traversal in the document id already.
  const run = "/tmp/excavator-assembly-root";
  assert.equal(runRelativePath(run, "reports/overview-product.md"), join(run, "reports", "overview-product.md"));
  assert.equal(runRelativePath(run, UNIT_COVERAGE_COMPANION_PATH), join(run, "reports", "companions", "unit-coverage.md"));
  for (const path of unitDocumentTargets(DOCUMENT_ID)) {
    assert.ok(runRelativePath(run, path).startsWith(join(run, "reports")), path);
  }
  assert.throws(() => runRelativePath(run, "../escape.md"), /which is outside the run directory/);
  assert.throws(() => runRelativePath(run, "reports/../../escape.md"), /which is outside the run directory/);
});

test("a child the recorded graph gives two parents is refused, because the document prints one", () => {
  const edges = [
    { parentUnitId: "d::synthesis::a", childUnitId: "d::leaf::x" },
    { parentUnitId: "d::synthesis::b", childUnitId: "d::leaf::x" }
  ];
  // Nothing upstream forbids this shape — plan validation checks self-reference, existence and same-document, and
  // the one-root count still passes because it counts the SET of named children — so keeping the last edge seen
  // would print `synthesis::b` as the parent and say nothing about `synthesis::a`. Which one survived would be
  // decided by the edge sort order, which is not an answer.
  assert.throws(() => parentUnitIdByChild(edges),
    /Unit "d::leaf::x" is a child of both "d::synthesis::a" and "d::synthesis::b" in this run's recorded authoring graph/);
  // A repeated identical edge is not two parents, and the normal shape resolves.
  assert.deepEqual([...parentUnitIdByChild([edges[0]!, edges[0]!])], [["d::leaf::x", "d::synthesis::a"]]);
  assert.deepEqual([...parentUnitIdByChild([])], []);
  assert.deepEqual(
    [...parentUnitIdByChild(UNITS.filter((unit) => unit.parentUnitId !== null).map((unit) => ({ parentUnitId: unit.parentUnitId!, childUnitId: unit.unitId })))].sort(),
    [[UNITS[1]!.unitId, UNITS[2]!.unitId], [UNITS[0]!.unitId, UNITS[2]!.unitId]].sort()
  );
});

test("two document ids a filesystem would fold onto one report file are refused", () => {
  // The identity collapse `unit-paths.ts` solves for unit ids with a digest suffix. A report file name is a
  // deliverable name, so it is refused rather than re-encoded — the plan that produced the pair is the fix.
  assert.throws(
    () => assertDistinctUnitDocumentTargets(["overview-product", "Overview-Product"]),
    /Documents "Overview-Product" and "overview-product" would assemble into report files a case-insensitive or normalizing filesystem treats as one/
  );
  // NFC vs NFD spellings of one accented id: the other way a filesystem merges two names.
  const nfc = "feature-caf\u00e9-product";
  const nfd = "feature-cafe\u0301-product";
  assert.notEqual(nfc, nfd);
  assert.equal(documentTargetFoldKey(nfc), documentTargetFoldKey(nfd));
  assert.throws(() => assertDistinctUnitDocumentTargets([nfc, nfd]), /treats as one/);
  // And the real shapes pass, so the guard is not simply always red.
  assert.doesNotThrow(() => assertDistinctUnitDocumentTargets(["overview-product", "overview-engineering", "feature-x-abc0123456-product"]));
  assert.doesNotThrow(() => assertDistinctUnitDocumentTargets([]));
});
