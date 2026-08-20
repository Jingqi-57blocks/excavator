/**
 * ADMISSION AGAINST A RUN DIRECTORY: read the candidates, decide with R6a's plan, and re-enter what may be reused
 * through the EXISTING draft and collect doors (R6b).
 *
 * ONE DOOR, NOT A SECOND WRITE PATH. Every admitted unit goes through `draftUnit` (the summary agreement check, the
 * output budget, the path safety check, a NEW receipt) and then through `collectUnits` (the promised-artifact
 * digests, the child-summary checks, the grounding audit, the synthesis backlink check, the timeline append, the
 * single-writer ledger). Nothing here writes a ledger row, a timeline event or a receipt of its own. That is the
 * whole safety argument for reusing a draft at all: the identity decides WHETHER to re-enter, and the gates decide
 * whether the re-entry may be recorded — so an identity that was wrong produces a named refusal, never a record.
 *
 * STALE RECEIPTS ARE NEVER FORGIVEN. A candidate's own receipt was deleted when it was collected, and admission
 * mints a new one for the plan now in force. `collect`'s refusals of a foreign epoch and a superseded plan are
 * untouched and unreachable from here.
 *
 * WHY THE CANDIDATE'S IDENTITY IS A RECORDED DIGEST AND NOT A COMPUTATION. Once the run is re-planned, the plan the
 * candidate was drafted under is gone from disk — there is nothing left to recompute its identity from. The
 * `packetIdentityDigest` its ledger row recorded (v2) is the whole of what is knowable, which is exactly why
 * `draftUnit` computes and records it rather than accepting one.
 *
 * THE ONE EXCEPTION TO "NOTHING IS RECOMPUTED": A SYNTHESIS. Its packet is its children's verified summaries, and
 * those summaries are still on disk, still vouched for by the rows that verified them. So the candidate side of a
 * synthesis IS computable — from `verified-candidates` child summaries — and R6a's rule does the rest: the moment
 * one child is not reusable, the synthesis is a rebuild naming that child, because the summaries its candidate
 * identity would be measured against are about to be replaced.
 *
 * ORDER, AND WHY IT IS THE PLAN'S. Units are attempted in `collectionOrder` — children before parents — because a
 * synthesis cannot be DRAFTED until its children are collected under the plan now in force. Each admitted unit is
 * drafted and collected on its own, so a refusal is attributable to exactly one unit; and a refusal HALTS the pass,
 * because it leaves its receipt on disk (as it must, so a correction can be re-collected) and that pending receipt
 * would make every later collect refuse the same unit again. The units not reached are reported as such by name.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RunManifest, SectionClaim } from "../base/types.ts";
import { readJson } from "../base/util.ts";
import { assertCurrentKnowledgeEpochForAuthoring } from "../freeze/freeze.ts";
import { draftUnit } from "./unit-draft.ts";
import { collectUnits, describePromisedArtifactProblem, pendingUnitReceipts, promisedArtifactProblems } from "./unit-collect.ts";
import { readUnitLedger, type CollectedUnit } from "./unit-ledger.ts";
import { unitIdentityOf } from "./unit-cache-identity.ts";
import {
  admissionReportOf,
  deriveUnitAdmissionPlan,
  outcomeOfUnattemptedIntent,
  type CandidateLedgerRow,
  type CandidateVerification,
  type UnitAdmissionIntent,
  type UnitAdmissionOutcome,
  type UnitAdmissionPlan,
  type UnitAdmissionReport
} from "./unit-cache-admission.ts";
import { deriveUnitCachePlan, type CandidateIdentity, type CandidateSource, type PlannedUnitIdentity, type UnitCachePlan } from "./unit-cache-plan.ts";
import { loadUnitPacketSource } from "./unit-packet-source.ts";
import { compareUnitIds, unitPaths } from "./unit-paths.ts";
import { assertPlanEpoch, loadUnitPlanView, requireKnowledgeEpoch, type UnitPlanView } from "./unit-plan-view.ts";
import { describeAuthorship, type UnitAuthorship, type UnitCacheAdmissionSource } from "./unit-provenance.ts";
import type { UnitDraftReceipt } from "./unit-receipt.ts";

/** The three artifacts of one verified candidate, read once and re-entered unchanged. */
interface CandidateArtifacts {
  readonly content: string;
  /** The claims ARRAY out of the sidecar, which is what `draftUnit` takes and re-validates into the same file. */
  readonly claims: readonly SectionClaim[];
  /** Untrusted on purpose: `draftUnit` parses and re-checks it against the plan and the bytes beside it. */
  readonly summary: unknown;
}

interface AdmissionState {
  readonly runDir: string;
  readonly manifest: RunManifest;
  /** The structured author: the plan and the report publish the sentence, the re-entry needs the value. */
  readonly authorship: UnitAuthorship;
  readonly knowledgeEpoch: number;
  readonly view: UnitPlanView;
  readonly ledgerRows: readonly CandidateLedgerRow[];
  /** The offered candidates by unit id, drifted ones included: a drift is a downgrade, not an omission. */
  readonly offered: ReadonlyMap<string, CollectedUnit>;
  /** The artifacts of the offered candidates whose bytes verified. */
  readonly artifacts: ReadonlyMap<string, CandidateArtifacts>;
  readonly cachePlan: UnitCachePlan;
  readonly plan: UnitAdmissionPlan;
}

/** What admission WOULD do, read-only: nothing is drafted, collected or written. */
export async function planUnitAdmission(runDir: string, authorship: UnitAuthorship): Promise<UnitAdmissionPlan> {
  return (await loadAdmissionState(runDir, authorship)).plan;
}

/**
 * Admit every unit whose identity and bytes still answer, through draft and collect. Returns what happened.
 *
 * A pending receipt is refused before anything is read: `collect` records everything pending, so an admission
 * starting on top of one would account for a unit it did not admit.
 */
export async function admitUnits(runDirInput: string, authorship: UnitAuthorship): Promise<UnitAdmissionReport> {
  const runDir = resolve(runDirInput);
  const pending = await pendingUnitReceipts(runDir);
  if (pending.length > 0) {
    throw new Error(`This run has ${pending.length} drafted unit(s) awaiting collect (${pending.map((receipt) => receipt.unitId).join(", ")}); collect them before admitting from the cache, or the admission's account would cover units it did not admit`);
  }
  const state = await loadAdmissionState(runDir, authorship);
  const intents = new Map(state.plan.intents.map((intent) => [intent.unit.unitId, intent]));
  const outcomes: UnitAdmissionOutcome[] = [];
  let halted: string | null = null;
  for (const unitId of state.view.collectionOrder) {
    const intent = intents.get(unitId);
    if (!intent) throw new Error(`The admission plan holds no intent for planned unit ${JSON.stringify(unitId)}; every unit of the plan is decided or nothing is`);
    if (intent.intent !== "admit") {
      outcomes.push(outcomeOfUnattemptedIntent(intent));
      continue;
    }
    if (halted !== null) {
      outcomes.push({
        outcome: "fell-to-rebuild",
        unit: intent.unit,
        cause: "halted-by-earlier-refusal",
        statement: `unit ${unitId} was admissible, but this pass stopped at ${halted}: that unit's receipt is left on disk, so every later collect would refuse it again. Fix ${halted} and re-run the admission.`
      });
      continue;
    }
    const admitted = await admitOne(state, intent);
    outcomes.push(admitted.outcome);
    if (admitted.outcome.outcome !== "admitted") halted = unitId;
  }
  return admissionReportOf(state.plan, outcomes, state.ledgerRows);
}

/**
 * Re-enter ONE candidate: draft its verified bytes, assert the re-entry changed nothing, then collect it.
 *
 * The byte-identity assertion is a THROW and not an outcome. A drifted candidate is a downgrade decided before any
 * write; bytes that came out different from what went in mean the draft path rewrote a verified artifact, and there
 * is no reading of that which is safe to record as "this unit was re-drawn".
 */
async function admitOne(state: AdmissionState, intent: UnitAdmissionIntent & { readonly intent: "admit" }): Promise<{ readonly outcome: UnitAdmissionOutcome }> {
  const unitId = intent.unit.unitId;
  const row = state.offered.get(unitId);
  const artifacts = state.artifacts.get(unitId);
  if (!row || !artifacts) throw new Error(`Unit ${JSON.stringify(unitId)} is intended for admission but its verified candidate artifacts were not read; nothing may be admitted from bytes nobody loaded`);
  const source = admissionSourceOf(row);
  const receipt = await draftUnit(state.runDir, {
    unitId,
    content: artifacts.content,
    claims: artifacts.claims,
    summary: artifacts.summary,
    authorship: state.authorship,
    provenance: { kind: "cache-admitted", source }
  });
  assertReEntryChangedNothing(receipt, source);
  try {
    const collected = await collectUnits(state.runDir);
    if (!collected.collected.some((entry) => entry.unitId === unitId)) {
      throw new Error(`collect recorded ${collected.collected.length} unit(s) and none of them is ${JSON.stringify(unitId)}`);
    }
  } catch (error) {
    return {
      outcome: {
        outcome: "fell-to-rebuild",
        unit: intent.unit,
        cause: "collect-refused",
        statement: `unit ${unitId} was re-entered with the bytes its candidate row verified, and collect refused to record it: ${(error as Error).message}`
      }
    };
  }
  return {
    outcome: {
      outcome: "admitted",
      unit: intent.unit,
      identityDigest: intent.identityDigest,
      source,
      statement: `unit ${unitId} was re-entered from the draft verified under plan ${source.planCatalogDigest.slice(0, 16)} and recorded again, byte for byte, with a new receipt`
    }
  };
}

/** The ledger row an admission re-entered, as the provenance a new record carries. */
function admissionSourceOf(row: CollectedUnit): UnitCacheAdmissionSource {
  return {
    knowledgeEpoch: row.knowledgeEpoch,
    planCatalogDigest: row.planCatalogDigest,
    packetIdentityDigest: row.packetIdentityDigest,
    contentDigest: row.contentDigest,
    claimsDigest: row.claimsDigest,
    summaryDigest: row.summaryDigest
  };
}

/**
 * The re-entry tripwire: the new receipt must record exactly what the candidate row promised.
 *
 * Four comparisons, and the fourth is the one a reader would forget: the identity the fresh draft COMPUTED must be
 * the identity the decision was made on. If it is not, the admission decided on inputs the draft did not see.
 */
function assertReEntryChangedNothing(receipt: UnitDraftReceipt, source: UnitCacheAdmissionSource): void {
  const problems: string[] = [];
  for (const [what, minted, promised] of [
    ["content", receipt.contentDigest, source.contentDigest],
    ["claims", receipt.claimsDigest, source.claimsDigest],
    ["summary", receipt.summaryDigest, source.summaryDigest],
    ["packet identity", receipt.packetIdentityDigest, source.packetIdentityDigest]
  ] as const) {
    if (minted !== promised) problems.push(`${what} came out as ${minted} where the candidate row recorded ${promised}`);
  }
  if (problems.length === 0) return;
  throw new Error(`Cache admission of unit ${JSON.stringify(receipt.unitId)} did not re-enter the verified bytes unchanged: ${problems.join("; ")}. An admission may only record the draft it admitted; nothing here re-draws a unit.`);
}

/**
 * Read the run, classify every ledger row, compute this plan's identities, and derive both plans.
 *
 * Every ledger row of this run appears in the reading with what was done with it — offered, at another epoch, or
 * already collected under the plan in force. A row that simply did not appear would be the silent loss the whole
 * unit ledger exists to prevent.
 */
async function loadAdmissionState(runDirInput: string, authorship: UnitAuthorship): Promise<AdmissionState> {
  const runDir = resolve(runDirInput);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  await assertCurrentKnowledgeEpochForAuthoring(runDir, manifest);
  const knowledgeEpoch = requireKnowledgeEpoch(manifest, "admitted from a prior verified draft");
  const view = await loadUnitPlanView(runDir);
  assertPlanEpoch(view, knowledgeEpoch);
  const ledger = await readUnitLedger(runDir, manifest.id);

  const ledgerRows: CandidateLedgerRow[] = [];
  const offered = new Map<string, CollectedUnit>();
  const artifacts = new Map<string, CandidateArtifacts>();
  // The rows that VOUCH for a summary on disk: every row of this epoch whose artifacts still verify, whether it is
  // an offered candidate or a unit already collected under the plan in force. A synthesis candidate's identity is
  // computed from these, and a row from another epoch vouches for nothing at this one.
  const vouching = new Map<string, CollectedUnit>();
  for (const row of [...ledger.units].sort((a, b) => compareUnitIds(a.unitId, b.unitId))) {
    const shared = {
      unitId: row.unitId,
      documentId: row.documentId,
      kind: row.kind,
      knowledgeEpoch: row.knowledgeEpoch,
      planCatalogDigest: row.planCatalogDigest,
      packetIdentityDigest: row.packetIdentityDigest
    };
    if (row.knowledgeEpoch !== knowledgeEpoch) {
      ledgerRows.push({
        ...shared,
        disposition: {
          state: "excluded",
          cause: "other-epoch",
          statement: `collected at knowledge epoch ${row.knowledgeEpoch} and this run is at epoch ${knowledgeEpoch}; a draft written from superseded knowledge is re-drawn, never admitted`
        }
      });
      continue;
    }
    const read = await verifyCandidate(runDir, row);
    if (read.verification.state === "verified") vouching.set(row.unitId, row);
    if (row.planCatalogDigest === view.planCatalogDigest) {
      ledgerRows.push({
        ...shared,
        disposition: {
          state: "excluded",
          cause: "collected-under-this-plan",
          statement: "already collected under the plan now in force, so there is nothing to admit for it"
        }
      });
      continue;
    }
    ledgerRows.push({ ...shared, disposition: { state: "offered", verification: read.verification } });
    offered.set(row.unitId, row);
    if (read.artifacts) artifacts.set(row.unitId, read.artifacts);
  }

  const candidates: readonly CandidateIdentity[] = [...offered.values()].map((row) => ({
    form: "recorded-digest",
    unitId: row.unitId,
    documentId: row.documentId,
    kind: row.kind,
    digest: row.packetIdentityDigest,
    recordedBy: `the ledger row collected at ${row.collectedAt} under plan ${row.planCatalogDigest.slice(0, 16)}`
  }));
  const cachePlan = deriveUnitCachePlan({
    planned: await plannedIdentities(runDir, view, vouching, authorship),
    candidates,
    candidateSource: candidateSourceOf(manifest.id, knowledgeEpoch, ledgerRows, offered)
  });
  const plan = deriveUnitAdmissionPlan({
    runId: manifest.id,
    knowledgeEpoch,
    planCatalogDigest: view.planCatalogDigest,
    authorship: describeAuthorship(authorship),
    plan: cachePlan,
    ledgerRows
  });
  return { runDir, manifest, authorship, knowledgeEpoch, view, ledgerRows, offered, artifacts, cachePlan, plan };
}

/**
 * The identity of every planned unit, through the one loader and the one identity function.
 *
 * A synthesis is measured against the summaries its CANDIDATE was written from — the children's verified summaries,
 * as the rows that vouch for them recorded them — because at this moment none of them is collected under the plan
 * now in force. When one child has no such row there is no summary to compute from, and the arm says so by name:
 * nothing here invents a placeholder summary.
 *
 * IT RELOADS THE RUN ONCE PER UNIT, deliberately. `loadUnitPacketSource` is the one spelling of "what a unit's
 * packet is rendered from", and assembling those inputs a second time here is exactly the second derivation R5b
 * paid nine times over for. The cost is measured rather than optimised away, and it is a read.
 */
async function plannedIdentities(
  runDir: string,
  view: UnitPlanView,
  vouching: ReadonlyMap<string, CollectedUnit>,
  authorship: UnitAuthorship
): Promise<readonly PlannedUnitIdentity[]> {
  const planned: PlannedUnitIdentity[] = [];
  for (const unit of view.units) {
    if (unit.kind !== "synthesis") {
      const source = await loadUnitPacketSource(runDir, {
        unitId: unit.unitId,
        overBudget: "record-limitation",
        childSummaries: { from: "collected-for-this-plan" }
      });
      planned.push({ derivation: "own-inputs", identity: unitIdentityOf(source.input, authorship) });
      continue;
    }
    const missing = [...unit.childUnitIds].filter((childUnitId) => !vouching.has(childUnitId)).sort(compareUnitIds);
    if (missing.length > 0) {
      planned.push({
        derivation: "children-unavailable",
        unitId: unit.unitId,
        documentId: unit.documentId,
        kind: unit.kind,
        childUnitIds: unit.childUnitIds,
        reason: `no verified summary is vouched for by any ledger row of this epoch for ${missing.length} of its ${unit.childUnitIds.length} child unit(s): ${missing.join(", ")}`
      });
      continue;
    }
    const source = await loadUnitPacketSource(runDir, {
      unitId: unit.unitId,
      overBudget: "record-limitation",
      childSummaries: { from: "verified-candidates", rows: vouching }
    });
    planned.push({
      derivation: "candidate-children-summaries",
      identity: unitIdentityOf(source.input, authorship),
      childUnitIds: unit.childUnitIds
    });
  }
  return planned;
}

/** Are one candidate's three artifacts still the bytes its ledger row promised — and what do they say. */
async function verifyCandidate(
  runDir: string,
  row: CollectedUnit
): Promise<{ readonly verification: CandidateVerification; readonly artifacts: CandidateArtifacts | null }> {
  const paths = unitPaths(runDir, row.unitId);
  const problems = await promisedArtifactProblems(paths, row);
  if (problems.length > 0) {
    const subject = { unitId: row.unitId, record: "The ledger row", possessive: "its ledger row" };
    return { verification: { state: "drifted", problems: problems.map((problem) => describePromisedArtifactProblem(subject, problem)) }, artifacts: null };
  }
  const sidecar = await readJson<{ readonly claims?: unknown }>(paths.claims);
  if (!Array.isArray(sidecar.claims)) {
    // The digest matched, so these ARE the verified bytes — and they are not a claims sidecar. That is a fact about
    // the record rather than a drift, and it is fatal: a unit cannot be re-entered without its claims.
    throw new Error(`${paths.claims} digests to what the ledger row for ${JSON.stringify(row.unitId)} promised but holds no claims array; the recorded sidecar is not a claims file`);
  }
  return {
    verification: { state: "verified" },
    artifacts: {
      content: await readFile(paths.content, "utf8"),
      claims: sidecar.claims as readonly SectionClaim[],
      summary: await readJson<unknown>(paths.summary)
    }
  };
}

/**
 * Where the candidates came from — and, when there are none, WHICH of the three reasons that is.
 *
 * A first authoring pass, a ledger holding only another epoch's work, and a ledger whose every row is already
 * collected under the plan in force are three different facts about a run. Reporting them as one "0 candidates"
 * would make "nothing to reuse" and "everything is already recorded" the same sentence.
 */
function candidateSourceOf(
  runId: string,
  knowledgeEpoch: number,
  ledgerRows: readonly CandidateLedgerRow[],
  offered: ReadonlyMap<string, CollectedUnit>
): CandidateSource {
  if (offered.size > 0) {
    return {
      origin: "prior-verified-units",
      runId,
      knowledgeEpoch,
      planCatalogDigests: [...new Set([...offered.values()].map((row) => row.planCatalogDigest))].sort((a, b) => a.localeCompare(b))
    };
  }
  const excluded = (cause: "other-epoch" | "collected-under-this-plan"): number =>
    ledgerRows.filter((row) => row.disposition.state === "excluded" && row.disposition.cause === cause).length;
  if (ledgerRows.length === 0) {
    return { origin: "no-prior-verified-units", reason: `this run's unit ledger records no collected unit at all, so nothing has ever been verified to admit at knowledge epoch ${knowledgeEpoch}` };
  }
  return {
    origin: "no-prior-verified-units",
    reason: `this run's unit ledger holds ${ledgerRows.length} row(s) and none is a candidate: ${excluded("other-epoch")} from another knowledge epoch and ${excluded("collected-under-this-plan")} already collected under the plan now in force`
  };
}
