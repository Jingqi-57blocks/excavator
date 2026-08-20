/**
 * DETERMINISTIC UNIT ASSEMBLY — front matter, contents, navigation, and the collected units' own bytes.
 *
 * IT IS A PURE FUNCTION OF (recorded plan, collected units, companion paths). No I/O, no clock, no random, no
 * model. That is not a style preference: the acceptance for this slice is that two runs of one fixture assemble to
 * the same bytes and that assembling twice does not move one, and the cheapest way to make both true is to have
 * nothing in here that could differ. Anything volatile a reader needs — the run id, the epoch digest, the plan
 * digest — arrives as a value the caller read off the run's own sealed artifacts.
 *
 * THE ORDER IS THE PLAN'S ONE ORDER. `unit-plan-view.ts` publishes `collectionOrder` (documents ascending, then
 * each document's recorded `authoringOrder`, children before parents) and this file consumes it as given. There is
 * no second "presentation order" derived here, because a second order is a second authority: the day they disagree,
 * a reader cannot tell which one the run actually wrote in. Children therefore appear BEFORE their parent, which is
 * the order a synthesis was written in, and the contents table names each unit's parent so the tree is still
 * readable from the flat sequence.
 *
 * THE FRONT MATTER PINS, AND CLAIMS NOTHING. It states the request row (scope, audience, intent, detail budget,
 * language), the two policy references the request was resolved against, the knowledge epoch and digest, and the
 * plan catalog digest and revision. It states no coverage figure and no completeness of any kind: gate 10's account
 * is the coverage companion, which names the ledger behind every number it gives, and a document header that said
 * "complete" beside a companion reading `vacuous` would be 57B-449 one level up. The link to the companion is in
 * the front matter and in the body, so the account travels with the deliverable.
 *
 * EVERY NAVIGATION TARGET IS EMITTED, NEVER ASSUMED. Markdown heading anchors are a renderer convention, not a
 * guarantee, and a unit's own first heading is model prose. So each unit gets an explicit `<a id="unit-<key>">`
 * whose key is `unitPathKey` — the same collision-free encoding the on-disk directory uses, so two units cannot
 * share one anchor for the same reason they cannot share one directory. Every link this file writes points at an
 * anchor this file also wrote, which is a property a test can state over the whole document rather than per link.
 */

import { assertNever } from "../base/artifact-result.ts";
import type { AuthoringUnitKind } from "./plan-proposal.ts";
import type { ReportRequestRecord } from "./report-requests-artifact.ts";
import type { UnitDocumentCompanionPaths } from "./unit-assembly-paths.ts";
import { assertDistinctUnitPathKeys, compareUnitIds, unitPathKey } from "./unit-paths.ts";

export const UNIT_ASSEMBLY_VERSION = "unit-assembly-v1";

/** The anchor the contents table and the navigation lines return to. */
export const CONTENTS_ANCHOR = "contents";

/** One collected unit, as assembly consumes it. Every field required: an absent one would be a silent omission. */
export interface AssemblyUnit {
  readonly unitId: string;
  readonly kind: AuthoringUnitKind;
  /** The plan's title for this unit, not a heading fished out of the prose. */
  readonly title: string;
  /** The unit whose child this is, or `null` for the document root. */
  readonly parentUnitId: string | null;
  /** The bytes of this unit's `content.md`, as its ledger row vouches for them. */
  readonly content: string;
}

/** What the run sealed, restated in the deliverable. Values, never re-derived here. */
export interface AssemblyIdentity {
  readonly runId: string;
  readonly knowledgeEpoch: number;
  readonly knowledgeDigest: string;
  readonly planCatalogDigest: string;
  readonly planRevision: number;
  /**
   * Whether this run's artifacts hold verbatim source text or redacted text.
   *
   * It travels with the report for the reason the section path's front matter states: the report is the artifact
   * that LEAVES the machine, and with redaction defaulting off a quoted excerpt may be verbatim source.
   */
  readonly sourceText: "verbatim" | "redacted";
}

export interface UnitDocumentAssembly {
  readonly documentId: string;
  /** The document's title: the plan's title for its root unit. */
  readonly title: string;
  readonly identity: AssemblyIdentity;
  readonly request: ReportRequestRecord;
  readonly companions: UnitDocumentCompanionPaths;
  /** Every unit of this document, in the plan's one collection order. Never empty. */
  readonly units: readonly AssemblyUnit[];
}

/** The anchor id one unit is reachable at. `unitPathKey`, so distinct units cannot share one anchor. */
export function unitAnchorId(unitId: string): string {
  return `unit-${unitPathKey(unitId)}`;
}

/**
 * The assembled markdown of one document.
 *
 * Three construction refusals, all about the same failure mode — a document that looks assembled and is not. An
 * empty unit list would render a header and a contents table over nothing; a repeated unit id would put one unit's
 * bytes in twice while the contents table said one; and two ids encoding to one anchor would make every link to
 * either of them land on the first.
 */
export function renderUnitDocument(input: UnitDocumentAssembly): string {
  if (input.units.length === 0) {
    throw new Error(`Document ${JSON.stringify(input.documentId)} has no unit to assemble; a document with no unit is not a document this run wrote`);
  }
  const seen = new Set<string>();
  for (const unit of input.units) {
    if (seen.has(unit.unitId)) {
      throw new Error(`Document ${JSON.stringify(input.documentId)} lists unit ${JSON.stringify(unit.unitId)} twice in its assembly order; one unit would be written into the document twice under one contents entry`);
    }
    seen.add(unit.unitId);
  }
  assertDistinctUnitPathKeys(input.units.map((unit) => unit.unitId), unitPathKey);

  const titles = new Map(input.units.map((unit) => [unit.unitId, unit.title]));
  const lines: string[] = [
    frontMatter(input),
    "",
    `# ${escapeInline(input.title)}`,
    "",
    `Assembled by Excavator from ${input.units.length} authoring unit(s) of this run's recorded plan, in the one`,
    "order the plan records (`plan/dag.json`: children before their parent, because a synthesis is written from",
    "summaries that already exist). Nothing below was written at assembly time: each unit's bytes are the bytes its",
    "collected ledger row vouches for. Every path named in this document is relative to the RUN directory, not to",
    "this file.",
    "",
    `This document states no coverage figure of its own. The coverage account of this run is \`${input.companions.coverage}\`,`,
    "which names the one ledger behind every number it gives and reports an empty denominator as `vacuous` rather",
    "than as covered.",
    "",
    `<a id="${CONTENTS_ANCHOR}"></a>`,
    "",
    "## Contents",
    "",
    "| # | unit | kind | parent |",
    "| --- | --- | --- | --- |"
  ];
  for (const [index, unit] of input.units.entries()) {
    const parent = unit.parentUnitId === null
      ? "(root)"
      : anchorLink(titles.get(unit.parentUnitId) ?? unit.parentUnitId, unit.parentUnitId);
    lines.push(`| ${index + 1} | ${anchorLink(unit.title, unit.unitId)} | ${unit.kind} | ${parent} |`);
  }

  lines.push(
    "",
    "## Companions",
    "",
    "| companion | path |",
    "| --- | --- |",
    `| claims | \`${input.companions.claims}\` |`,
    `| traces | \`${input.companions.traces}\` |`,
    `| coverage | \`${input.companions.coverage}\` |`
  );

  for (const [index, unit] of input.units.entries()) {
    lines.push(
      "",
      "---",
      "",
      `<a id="${unitAnchorId(unit.unitId)}"></a>`,
      "",
      // Trimmed at the seams and otherwise verbatim: the same join the section path performs, so a unit's own
      // trailing newline cannot decide how many blank lines the document has.
      unit.content.trim(),
      "",
      navigationLine(input.units, index, titles)
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * The navigation line under one unit: back to contents, then the neighbours in the plan's order and the parent.
 *
 * Every part points at an anchor `renderUnitDocument` emitted above, which is what makes "every navigation target
 * resolves" a property of the whole document rather than a per-link hope.
 */
function navigationLine(units: readonly AssemblyUnit[], index: number, titles: ReadonlyMap<string, string>): string {
  const unit = units[index]!;
  const parts = [`[contents](#${CONTENTS_ANCHOR})`];
  const previous = units[index - 1];
  if (previous) parts.push(`[previous: ${escapeInline(previous.title)}](#${unitAnchorId(previous.unitId)})`);
  const next = units[index + 1];
  if (next) parts.push(`[next: ${escapeInline(next.title)}](#${unitAnchorId(next.unitId)})`);
  if (unit.parentUnitId !== null) {
    parts.push(`[parent: ${escapeInline(titles.get(unit.parentUnitId) ?? unit.parentUnitId)}](#${unitAnchorId(unit.parentUnitId)})`);
  }
  return parts.join(" · ");
}

/**
 * The YAML front matter.
 *
 * Every scalar goes through `JSON.stringify`, which is a legal YAML double-quoted scalar for every string this can
 * hold — a plan title carrying a colon or a quote would otherwise produce a header no YAML parser accepts, and a
 * deliverable whose header does not parse is worse than one with an awkward title.
 */
function frontMatter(input: UnitDocumentAssembly): string {
  const { identity, request } = input;
  const row = request.request;
  return [
    "---",
    `assembly: ${UNIT_ASSEMBLY_VERSION}`,
    `title: ${yamlScalar(input.title)}`,
    `documentId: ${yamlScalar(input.documentId)}`,
    `scope: ${row.scope}`,
    `scopeIds: [${row.scopeIds.map(yamlScalar).join(", ")}]`,
    `audience: ${row.audience}`,
    `intent: ${row.intent}`,
    `detailBudget: ${row.detailBudget}`,
    `language: ${yamlScalar(row.language)}`,
    `policyVersion: ${yamlScalar(row.policyVersion)}`,
    `lensPolicy: ${yamlScalar(`${request.lensPolicy.id}@${request.lensPolicy.version}`)}`,
    `lensPolicyDigest: ${request.lensPolicy.digest}`,
    `intentPolicy: ${yamlScalar(`${request.intentPolicy.id}@${request.intentPolicy.version}`)}`,
    `intentPolicyDigest: ${request.intentPolicy.digest}`,
    `requestMappingVersion: ${yamlScalar(request.mappingVersion)}`,
    `run: ${yamlScalar(identity.runId)}`,
    `knowledgeEpoch: ${identity.knowledgeEpoch}`,
    `knowledgeDigest: ${identity.knowledgeDigest}`,
    `planCatalogDigest: ${identity.planCatalogDigest}`,
    `planRevision: ${identity.planRevision}`,
    `units: ${input.units.length}`,
    `claimsCompanion: ${yamlScalar(input.companions.claims)}`,
    `tracesCompanion: ${yamlScalar(input.companions.traces)}`,
    `coverageCompanion: ${yamlScalar(input.companions.coverage)}`,
    `sourceText: ${sourceTextWord(identity.sourceText)}`,
    "---"
  ].join("\n");
}

/** Exhaustive over the two arms, so a third source-text state has to be given its own word before this compiles. */
function sourceTextWord(sourceText: AssemblyIdentity["sourceText"]): string {
  switch (sourceText) {
    case "verbatim":
      return "verbatim";
    case "redacted":
      return "redacted";
  }
  return assertNever(sourceText, "assembled document source text");
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

/** One markdown link to a unit's anchor, with its text escaped. */
function anchorLink(text: string, unitId: string): string {
  return `[${escapeInline(text)}](#${unitAnchorId(unitId)})`;
}

/**
 * Escape the characters that would make a title stop being text: the link brackets and the table cell separator.
 *
 * A plan title is model-supplied (`parsePlanProposal` asks only for a non-empty string), so a title carrying `|`
 * would silently add a column to the contents table and a title carrying `]` would truncate a link. Deterministic
 * and total: every input maps to one output.
 */
function escapeInline(value: string): string {
  return value.replace(/([\\|[\]])/g, "\\$1").replace(/\r?\n/g, " ");
}

/** The plan's units of one document, ordered by the plan's collection order. A missing id is a named refusal. */
export function assemblyUnitsInOrder<T extends { readonly unitId: string }>(
  documentId: string,
  units: readonly T[],
  collectionOrder: readonly string[]
): readonly T[] {
  const byId = new Map(units.map((unit) => [unit.unitId, unit]));
  const ordered = collectionOrder.filter((unitId) => byId.has(unitId)).map((unitId) => byId.get(unitId)!);
  if (ordered.length !== units.length) {
    const named = new Set(collectionOrder);
    const missing = [...byId.keys()].filter((unitId) => !named.has(unitId)).sort(compareUnitIds);
    throw new Error(`Document ${JSON.stringify(documentId)} has ${missing.length} unit(s) the plan's collection order does not name (${missing.join(", ")}); assembling from an order that misses a unit would leave it out in silence`);
  }
  return ordered;
}

/**
 * Child -> parent, from the recorded DAG's edge list.
 *
 * A CHILD WITH TWO PARENTS IS REFUSED, not resolved. An assembled document names ONE parent per unit — in the
 * contents table and in the navigation line — so keeping the last edge seen would print one parent and say nothing
 * about the other, and because `plan-artifacts.ts` sorts the edges, which one survived would be decided by
 * lexicographic order. Nothing upstream forbids the shape today: plan validation checks self-reference, existence
 * and same-document, and the root count still comes out at one because it counts the SET of named children. So the
 * refusal lives here, where the singular field is, rather than being implied by a type.
 */
export function parentUnitIdByChild(
  edges: readonly { readonly parentUnitId: string; readonly childUnitId: string }[]
): ReadonlyMap<string, string> {
  const parents = new Map<string, string>();
  for (const edge of edges) {
    const taken = parents.get(edge.childUnitId);
    if (taken !== undefined && taken !== edge.parentUnitId) {
      throw new Error(`Unit ${JSON.stringify(edge.childUnitId)} is a child of both ${JSON.stringify(taken)} and ${JSON.stringify(edge.parentUnitId)} in this run's recorded authoring graph; an assembled document names one parent per unit, so printing either would hide the other`);
    }
    parents.set(edge.childUnitId, edge.parentUnitId);
  }
  return parents;
}
