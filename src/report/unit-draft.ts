/**
 * Draft one authoring unit: the parallel-safe half of a unit checkpoint.
 *
 * THE SAFETY ARGUMENT IS THE SAME ONE THE SECTION PATH MAKES, and it is about write sets, not locks. Every byte
 * this function writes is under `units/<key>/`, a directory derived from the unit id alone, so N drafts of N
 * distinct units have provably disjoint write sets. It appends nothing to `timeline.jsonl` and it changes neither
 * `run.json` nor `metrics.json` — `collect` is the only writer of those. It READS the collect-written ledger
 * (a synthesis may not be written before its children are collected), and a read is not a write set.
 *
 * A BAD UNIT FAILS HERE, NOT AT COLLECT. Everything is validated before anything is written: the epoch gate, the
 * plan gate, the unit id as a path segment, the unit's presence in the validated plan, the claims, the summary
 * against both the plan and the bytes about to land, and — for a synthesis — that every child is already
 * collected. Only then does the archive-and-write sequence start, and the receipt is written LAST, so a draft
 * that dies mid-write leaves no commit marker for `collect` to believe.
 *
 * THE SUMMARY IS AN ARGUMENT OF THIS FUNCTION, NOT AN OPTION. Same for the claims. Both are required parameters
 * rather than optional ones, which is what makes every call site state them: an optional summary is a summary
 * most units would not have, and the synthesis path would then be built on a field that is usually absent.
 *
 * THE CACHE IDENTITY IS COMPUTED HERE AND NOT ACCEPTED FROM ANYONE (R6b). The receipt records the identity of the
 * packet this unit was written from, and the only way that record can be trusted is for the function that writes it
 * to derive it — from the same loader the packet command uses and the same identity function the reading uses. A
 * parameter would let a caller state an identity its bytes were never written for, which is exactly the assertion a
 * cache must not take on trust. It is computed LAST, after every existing refusal has had its say, so no message
 * and no order this function already had moves.
 *
 * `authorship` AND `provenance` ARE REQUIRED PARAMETERS for the same reason the summary is: an optional author is an
 * author most calls would omit, and a cache whose records do not say who wrote them cannot refuse to hand one
 * family's draft to another. `provenance` is how a re-entered draft is distinguishable from a fresh one FOREVER —
 * the receipt is deleted at collect, so if it is not in the record it is nowhere.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RunManifest, SectionClaim } from "../base/types.ts";
import { assertNever } from "../base/artifact-result.ts";
import { atomicWrite, exists, nowIso, readJson, sha256, writeJson } from "../base/util.ts";
import { assertCurrentKnowledgeEpochForAuthoring } from "../freeze/freeze.ts";
import { normalizeSection } from "./checkpoint.ts";
import type { PlanCatalogUnit } from "./plan-artifacts.ts";
import { collectedUnitsFor, readUnitLedger, type CollectedUnit } from "./unit-ledger.ts";
import {
  parseUnitSummary,
  unitClaimsDigest,
  unitContentDigest,
  unitSummaryAgreementProblems,
  unitSummaryDigest,
  validateUnitClaims,
  type UnitChildSummaryDigest
} from "./unit-output.ts";
import { documentBudgetRow } from "./plan-budget.ts";
import { measureUnitOutput, unitOutputBudgetProblems } from "./unit-output-budget.ts";
import { compareUnitIds, unitPaths, type UnitPaths } from "./unit-paths.ts";
import { assertPlanEpoch, loadUnitPlanView, planUnit, requireKnowledgeEpoch } from "./unit-plan-view.ts";
import { unitIdentityOf } from "./unit-cache-identity.ts";
import { loadUnitPacketSource } from "./unit-packet-source.ts";
import type { UnitAuthorship, UnitProvenance } from "./unit-provenance.ts";
import { UNIT_RECEIPT_VERSION, type UnitDraftReceipt } from "./unit-receipt.ts";

export interface UnitDraftInput {
  readonly unitId: string;
  /** The unit's markdown. Normalized under the plan's title, exactly as a section is. */
  readonly content: string;
  /** May be empty, but never absent: the sidecar is always written, so its digest always means something. */
  readonly claims: readonly SectionClaim[];
  /** Untrusted: parsed and checked against the plan and the bytes beside it. */
  readonly summary: unknown;
  /** Who would have written these bytes. Required, closed, no default — it is part of the cache identity. */
  readonly authorship: UnitAuthorship;
  /**
   * Whether these bytes were written for this draft or admitted from a prior verified unit.
   *
   * The `cache-admitted` arm carries the row it came from, so a caller cannot claim an admission without naming
   * what it admitted. There is no arm a hand-written draft can use to look like a cache hit.
   */
  readonly provenance: UnitProvenance;
}

/** Draft one unit. Returns the receipt it wrote — the promise `collect` verifies. */
export async function draftUnit(runDirInput: string, input: UnitDraftInput): Promise<UnitDraftReceipt> {
  const runDir = resolve(runDirInput);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  await assertCurrentKnowledgeEpochForAuthoring(runDir, manifest);
  const knowledgeEpoch = requireKnowledgeEpoch(manifest, "drafted");
  const view = await loadUnitPlanView(runDir);
  assertPlanEpoch(view, knowledgeEpoch);
  const unit = planUnit(view, input.unitId);
  // Before any write, and before the content is even looked at: the id becomes a directory name here, and a
  // hostile one has to be refused while nothing has been created.
  const paths = unitPaths(runDir, unit.unitId);

  // Checked here rather than left to `normalizeSection`, whose only refusal names a SECTION — a concept the unit
  // path does not have. Everything else a unit author is told is unit-keyed; this was the one leak.
  if (input.content.trim() === "") {
    throw new Error(`Unit ${JSON.stringify(unit.unitId)} was drafted with empty content; a unit writes its own prose and cannot be recorded blank`);
  }
  const normalized = normalizeSection(input.content, unit.title);
  const contentDigest = unitContentDigest(normalized);
  const claims = validateUnitClaims(unit.unitId, unit.documentId, input.claims);
  const claimsDigest = unitClaimsDigest(claims);

  const ledger = await readUnitLedger(runDir, manifest.id);
  const collected = new Map(collectedUnitsFor(ledger, knowledgeEpoch, view.planCatalogDigest).map((row) => [row.unitId, row]));
  const childSummaryDigests = expectedChildSummaryDigests(unit, collected);

  const parsed = parseUnitSummary(input.summary);
  if (parsed.summary === null) {
    throw new Error(`The summary for unit ${JSON.stringify(unit.unitId)} is not a valid unit summary: ${parsed.problems.join("; ")}`);
  }
  const disagreements = unitSummaryAgreementProblems(parsed.summary, {
    unitId: unit.unitId,
    documentId: unit.documentId,
    kind: unit.kind,
    topicIds: unit.topics.map((topic) => topic.topicId),
    contentDigest,
    claimsDigest,
    childSummaryDigests
  });
  if (disagreements.length > 0) {
    throw new Error(`The summary for unit ${JSON.stringify(unit.unitId)} disagrees with this run: ${disagreements.join("; ")}`);
  }

  // The OUTPUT budget, checked before anything is written and against the plan's own row for this document — the
  // one authority for all four numbers. Over-budget is a named refusal that says "write more tightly"; Core never
  // deletes content to make a unit fit.
  const outputProblems = unitOutputBudgetProblems(
    unit.unitId,
    documentBudgetRow(view.planCatalog.budget, unit.documentId),
    measureUnitOutput(normalized, claims, parsed.summary)
  );
  if (outputProblems.length > 0) {
    throw new Error(`Unit ${JSON.stringify(unit.unitId)} is over its declared output budget: ${outputProblems.join("; ")}`);
  }

  // The identity of the packet this unit is written FROM, through the one loader and the one identity function.
  // Last, so every refusal above keeps its own message; `record-limitation` because an identity is a measurement
  // over a composition and not a verdict about a bound — the composition it digests carries no limitation line
  // either way, so this mode changes nothing about the digest and only keeps an over-budget unit identifiable.
  const packetSource = await loadUnitPacketSource(runDir, {
    unitId: unit.unitId,
    overBudget: "record-limitation",
    childSummaries: { from: "collected-for-this-plan" }
  });
  const packetIdentityDigest = unitIdentityOf(packetSource.input, input.authorship).digest;

  const revision = await archiveUnitRevision(paths);
  await atomicWrite(paths.content, normalized);
  await writeJson(paths.claims, claims);
  await writeJson(paths.summary, parsed.summary);
  const receipt: UnitDraftReceipt = {
    version: UNIT_RECEIPT_VERSION,
    runId: manifest.id,
    knowledgeEpoch,
    planCatalogDigest: view.planCatalogDigest,
    unitId: unit.unitId,
    documentId: unit.documentId,
    kind: unit.kind,
    draftedAt: nowIso(),
    revision,
    authorship: input.authorship,
    packetIdentityDigest,
    provenance: input.provenance,
    contentDigest,
    claimsDigest,
    summaryDigest: unitSummaryDigest(parsed.summary),
    evidenceIds: sortedIds(input.claims.flatMap((claim) => claim.evidenceIds ?? [])),
    traceIds: sortedIds(input.claims.flatMap((claim) => claim.traceIds ?? []))
  };
  await writeJson(paths.receipt, receipt);
  return receipt;
}

/**
 * The child summaries a unit of this kind must reference — exhaustive over the four kinds.
 *
 * The `assertNever` is what makes a fifth kind a typecheck failure instead of a kind whose child rule nobody
 * wrote: the alternative is a new kind that silently reads as "no children" and is allowed to skip the order gate.
 */
function expectedChildSummaryDigests(unit: PlanCatalogUnit, collected: ReadonlyMap<string, CollectedUnit>): readonly UnitChildSummaryDigest[] {
  switch (unit.kind) {
    case "leaf":
    case "bridge":
    case "appendix":
      return [];
    case "synthesis":
      return [...unit.childUnitIds]
        .sort(compareUnitIds)
        .map((childUnitId) => {
          const row = collected.get(childUnitId);
          if (!row) {
            throw new Error(`Synthesis unit ${JSON.stringify(unit.unitId)} cannot be drafted yet: its child ${JSON.stringify(childUnitId)} has not been collected, and a synthesis writes from child summaries only`);
          }
          return { childUnitId, summaryDigest: row.summaryDigest };
        });
  }
  return assertNever(unit.kind, "authoring unit kind");
}

/**
 * Archive the version this draft replaces, if there is one, and say whether there was.
 *
 * All three artifacts go into the unit's own `history/` under one timestamp, so a revision is recoverable as the
 * set it was written as — a content file archived without the summary that described it would be a history that
 * cannot be read back.
 */
async function archiveUnitRevision(paths: UnitPaths): Promise<boolean> {
  const stamp = nowIso().replace(/[:.]/g, "-");
  let archived = false;
  for (const [path, suffix] of [[paths.content, "md"], [paths.claims, "claims.json"], [paths.summary, "summary.json"]] as const) {
    if (!await exists(path)) continue;
    const content = await readFile(path, "utf8");
    await atomicWrite(join(paths.historyDir, `${stamp}-${sha256(content).slice(0, 8)}.${suffix}`), content);
    archived = true;
  }
  return archived;
}

function sortedIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort(compareUnitIds);
}
