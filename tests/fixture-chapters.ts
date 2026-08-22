/**
 * THE NUMBERED-CHAPTER CONTRACT, IN THE MODEL-FREE FIXTURES' CANNED PROSE.
 *
 * WHY THE FIXTURES CARRY CHAPTERS AT ALL. Every report template states that its `##` chapters are the fixed
 * contract of the deliverable — prd-feature.md says so in words ("keep all eleven, in this order, numbered 1..11")
 * and the other four say it by numbering their own headings. A checker whose subject is the ASSEMBLED DELIVERABLE
 * therefore has to be exercised against a deliverable shaped like the ones it will see. Before this, every fixture
 * document held headings like `## Material coverage topics` and not one numbered chapter, so the fixture runs were
 * silently outside the one contract the whole document format is built on.
 *
 * THE COUNT IS DERIVED, NEVER WRITTEN DOWN. `plannedChapterCounts` reads the run's OWN `contract/requirements.json`
 * — one row per level-two template section, materialized before any producer ran. A hard-coded 10 would make the
 * fixture drift the day a template gains or loses a chapter, and it would drift GREEN: the fixture would still
 * assert "the chapters I wrote" against "the chapters I wrote", which is worse than having no fixture at all.
 *
 * THE ALLOCATION IS CONTIGUOUS AND IN ASSEMBLY ORDER, so the assembled document reads `1..N` ascending. A document
 * with N chapters and k units gives unit i the ordinals `floor(N*i/k)+1 .. floor(N*(i+1)/k)`: every ordinal is
 * dealt exactly once, the blocks are in the order the assembler concatenates the units
 * (`assemblyUnitsInOrder` filters the plan's collection order down to the document), and a unit that gets an empty
 * block when there are more units than chapters is a defined arm rather than a crash.
 *
 * IT IS NOT A PRETEND DEFECT. The gate this prose lets a run reach is a gate a real run has already violated (a
 * measured deliverable wrote 11 numbered chapters against 10 recorded requirement rows). Making the canned draft
 * obey the contract is what lets "the fixture run has zero findings" keep meaning "this checker does not
 * misfire" — the red evidence comes from fixtures built to be red, never from the clean one.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Requirements } from "../src/contract/bound-run-contract.ts";
import type { PlanCatalogUnit } from "../src/report/plan-artifacts.ts";
import type { UnitPlanView } from "../src/report/unit-plan-view.ts";

/**
 * How many numbered chapters this run recorded for each planned document: one per template-section requirement row.
 *
 * Run-level rows carry no `documentId` and no `sectionIndex`, so they are not chapters of anything and are skipped.
 */
export async function plannedChapterCounts(runDir: string): Promise<ReadonlyMap<string, number>> {
  const requirements = JSON.parse(await readFile(join(runDir, "contract", "requirements.json"), "utf8")) as Requirements;
  const counts = new Map<string, number>();
  for (const row of requirements.rows) {
    if (row.documentId === null || row.sectionIndex === null) continue;
    counts.set(row.documentId, (counts.get(row.documentId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Which ordinals each unit of one document writes, keyed by unit id.
 *
 * `unitIds` must already be in the document's assembly order; the blocks are dealt in that order, so the assembled
 * bytes read `1..chapters` ascending.
 */
export function chapterAllocation(unitIds: readonly string[], chapters: number): ReadonlyMap<string, readonly number[]> {
  if (!Number.isInteger(chapters) || chapters < 1) {
    throw new Error(`fixture cannot allocate ${JSON.stringify(chapters)} chapter(s); a planned document records at least one requirement row per template section`);
  }
  const allocation = new Map<string, readonly number[]>();
  for (const [index, unitId] of unitIds.entries()) {
    const from = Math.floor((chapters * index) / unitIds.length);
    const to = Math.floor((chapters * (index + 1)) / unitIds.length);
    allocation.set(unitId, Array.from({ length: to - from }, (_unused, offset) => from + offset + 1));
  }
  return allocation;
}

/**
 * The ordinals one unit of one run writes. Fails closed on every step: a document with no recorded chapter count
 * and a unit the collection order does not place are both named refusals, never an empty chapter list that would
 * quietly produce a deliverable with fewer chapters than the run recorded.
 */
export async function chapterOrdinalsFor(runDir: string, view: UnitPlanView, unit: PlanCatalogUnit): Promise<readonly number[]> {
  // No recorded row for this document means NO CHAPTER CONTRACT, which is a real state of a real run rather than a
  // fixture fault: `contract/requirements.json` is written once by prepare and the `request-append` door grows
  // `plan/requests.json` only, so a document added to a shipped run has no chapter count to write to. The draft
  // then carries no numbered chapter, which is exactly what the checker reads as vacuous. The other refusal below
  // stays a refusal, because a unit the collection order does not place IS a fixture fault.
  const chapters = (await plannedChapterCounts(runDir)).get(unit.documentId);
  if (chapters === undefined) return [];
  const siblings = view.collectionOrder.filter((unitId) => view.byId.get(unitId)?.documentId === unit.documentId);
  const ordinals = chapterAllocation(siblings, chapters).get(unit.unitId);
  if (!ordinals) {
    throw new Error(`fixture cannot draft ${unit.unitId}: the plan's collection order does not place it in document ${unit.documentId}`);
  }
  return ordinals;
}

/**
 * The canned prose of one unit: its allocated chapters, the first of which carries the sentence the unit's canned
 * claim quotes verbatim.
 *
 * The claim sentence stays in the FIRST chapter and stays byte-identical to what `unitClaims` states, because the
 * claim-binding audit resolves a claim against the prose that carries it. The extra chapters carry their own
 * sentence rather than an empty body: a chapter heading with nothing under it is not a shape any deliverable has.
 */
export function chapteredProse(unit: PlanCatalogUnit, ordinals: readonly number[]): string {
  return chapteredBody(unit, ordinals, `${unit.unitId} 记录当前状态。\`事实\``);
}

/**
 * The chapters one unit owes, with a caller's own text as the FIRST chapter's body.
 *
 * This is what lets a test inject a defect into one unit's prose without also taking that unit's chapters out of
 * the deliverable. Before it, a fixture that overrode a unit's prose silently dropped the chapters dealt to it and
 * the document came out short — so every injection test would have tripped the chapter contract as well as the
 * class it was actually about, and the finding under test would have arrived buried in noise it caused itself.
 */
export function chapteredBody(unit: PlanCatalogUnit, ordinals: readonly number[], body: string): string {
  if (ordinals.length === 0) return `## ${unit.title}\n\n${body}\n`;
  const [first, ...rest] = ordinals;
  const blocks = [
    `## ${first}. ${unit.title}`,
    "",
    body,
    ...rest.flatMap((ordinal) => ["", `## ${ordinal}. ${unit.title}`, "", `${unit.unitId} 第 ${ordinal} 章记录当前状态。\`事实\``])
  ];
  return `${blocks.join("\n")}\n`;
}
