/**
 * Collect the drafted authoring units: the single-writer serial barrier of the unit path.
 *
 * ONE WRITER, ONE ORDER, ONE CHAIN. Every append to `timeline.jsonl`, every touch of `run.json` and
 * `metrics.json`, and every byte of `units/collected.json` happens here, one unit at a time, in an order that is
 * a pure function of the plan (`unit-plan-view.ts`) filtered to the receipts on disk. That is what makes the hash
 * chain contiguous by construction rather than by luck, and it is why the emitted event sequence does not depend
 * on which draft finished first.
 *
 * WHAT IT DOES NOT TOUCH. `documents[].sections[]`, `manifest.state`, `metrics.claims` — the section world's state
 * machine and its counters. A unit collection is recorded in the unit ledger and the timeline, and nowhere else,
 * so a run that authored units and a run that authored sections do not write over each other's accounting.
 *
 * THE ORDER OF THE REFUSALS IS PART OF THE CONTRACT. A receipt from a superseded epoch is refused BEFORE the plan
 * is read, because after a re-freeze the recorded plan no longer matches the new epoch and the plan gate would
 * otherwise answer first — with a true statement about the plan that hides the fact the operator needs: the draft
 * in hand belongs to knowledge that has been superseded, and re-drawing it is the fix.
 *
 * IT IS ALSO WHERE GATE 1b LANDS. Before a unit is recorded, its claims are audited against every material
 * obligation it OWNS (`unit-grounding-reading.ts`; R5a derives the owner, R4b's version said "reachable"). A unit
 * that leaves one ungrounded is refused by name, with the obligation ids, and nothing is written — which is what
 * closes the window 57B-453 measured on the section path, where `audit --document` skipped the grounding loop until
 * the last section landed and 28% of one section's obligations were mis-grounded the whole time.
 *
 * AND IT IS WHERE A SYNTHESIS IS HELD TO ITS CHILDREN. A synthesis may re-state a child's fact and may not mint one
 * of its own, so before it is recorded every evidence and trace id its claims cite is checked against the claims of
 * its children — which this barrier has just confirmed are collected (`synthesis-claim-backlink.ts`). That read is
 * Core reading deterministic bytes already on disk inside the serial barrier; nothing is handed to a model, and it
 * is the only thing standing between "a synthesis writes from summaries" and a parent quietly citing raw evidence.
 *
 * FAIL CLOSED, AND NEVER PERMANENTLY. A receipt is a promise that content, claims and summary are on disk and are
 * the bytes it digested. If any of that is untrue the barrier refuses by name and LEAVES THE RECEIPT, so a
 * corrected re-draft is collected on the next run: there is no state a bad draft can put a run into for good.
 */

import { readFile, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { RunManifest } from "../base/types.ts";
import { appendTimeline } from "../base/timeline.ts";
import { canonicalJson, exists, listDirectories, nowIso, readJson, sha256, writeJson } from "../base/util.ts";
import { assertCurrentKnowledgeEpochForAuthoring } from "../freeze/freeze.ts";
import {
  collectedUnitsFor,
  readUnitLedger,
  withCollectedUnit,
  writeUnitLedger,
  type CollectedUnit,
  type UnitLedger
} from "./unit-ledger.ts";
import { compareUnitIds, unitPathKey, unitPaths, unitsDir } from "./unit-paths.ts";
import { assertPlanEpoch, loadUnitPlanView, planUnit, requireKnowledgeEpoch } from "./unit-plan-view.ts";
import { parseUnitSummary, type UnitChildSummaryDigest } from "./unit-output.ts";
import { summariseUnitGrounding } from "./unit-grounding-audit.ts";
import { auditUnitFromDisk } from "./unit-grounding-reading.ts";
import { auditSynthesisBacklinkFromDisk, requiresChildClaimBacklink, summariseSynthesisBacklink } from "./synthesis-claim-backlink.ts";
import { describePromisedArtifactProblem, promisedArtifactProblems, type PromiseSubject } from "./unit-artifact-promise.ts";
import { parseUnitReceipt, type UnitDraftReceipt } from "./unit-receipt.ts";

export interface UnitCollectResult {
  readonly collected: readonly UnitDraftReceipt[];
  readonly ledger: UnitLedger;
  /**
   * Receipts on disk that name a unit this run's plan does not hold.
   *
   * REPORTED, NOT REFUSED, and the difference is the "never permanently" half of this module's contract. Such a
   * receipt can never be recorded (there is no plan row to record it against) AND can never be re-drafted
   * (`planUnit` refuses the id), so making it an error would mean one stray file stops every other unit of the
   * run from ever being collected, with no command that clears it. It is named here and in `unitStatus`'s
   * `superseded`, so nothing is silent, and the barrier still records the units it can.
   */
  readonly unplanned: readonly UnitDraftReceipt[];
}

/** Collect every pending unit draft. A no-op when nothing is pending, so it is safe to rerun. */
export async function collectUnits(runDirInput: string): Promise<UnitCollectResult> {
  const runDir = resolve(runDirInput);
  const runPath = join(runDir, "run.json");
  const metricsPath = join(runDir, "metrics.json");
  const manifest = await readJson<RunManifest>(runPath);
  await assertCurrentKnowledgeEpochForAuthoring(runDir, manifest);
  const knowledgeEpoch = requireKnowledgeEpoch(manifest, "collected");

  const pending = await pendingUnitReceipts(runDir);
  for (const receipt of pending) {
    // A receipt from another RUN is refused the way the ledger refuses another run's rows: without this, a
    // `units/<key>/` directory copied between two runs whose epoch and plan happen to match would be recorded
    // into the wrong run's ledger and timeline, and every count would still balance.
    if (receipt.runId !== manifest.id) {
      throw new Error(`Unit draft receipt for ${JSON.stringify(receipt.unitId)} belongs to run ${JSON.stringify(receipt.runId)}, not to ${JSON.stringify(manifest.id)}; a unit is collected by the run that drafted it`);
    }
    if (receipt.knowledgeEpoch !== knowledgeEpoch) {
      throw new Error(`Unit draft receipt for ${JSON.stringify(receipt.unitId)} was written from knowledge epoch ${receipt.knowledgeEpoch}; re-draft it from current epoch ${knowledgeEpoch}`);
    }
  }
  // The plan is loaded even when nothing is pending: "collected 0" on a run with no validated plan would read
  // as "there was nothing to collect", and an empty set that means two different things is the one thing this
  // barrier may not report. With no plan the refusal names the missing file instead.
  const view = await loadUnitPlanView(runDir);
  assertPlanEpoch(view, knowledgeEpoch);
  let ledger = await readUnitLedger(runDir, manifest.id);
  const unplanned = pending.filter((receipt) => !view.byId.has(receipt.unitId));
  const recordable = pending.filter((receipt) => view.byId.has(receipt.unitId));
  if (!recordable.length) return { collected: [], ledger, unplanned };

  for (const receipt of recordable) {
    const unit = planUnit(view, receipt.unitId);
    if (receipt.planCatalogDigest !== view.planCatalogDigest) {
      throw new Error(`Unit draft receipt for ${JSON.stringify(receipt.unitId)} was written against plan ${receipt.planCatalogDigest.slice(0, 16)} but this run records plan ${view.planCatalogDigest.slice(0, 16)}; re-draft it against the recorded plan`);
    }
    if (receipt.documentId !== unit.documentId || receipt.kind !== unit.kind) {
      throw new Error(`Unit draft receipt for ${JSON.stringify(receipt.unitId)} records ${receipt.kind} in ${JSON.stringify(receipt.documentId)} but the plan records ${unit.kind} in ${JSON.stringify(unit.documentId)}`);
    }
  }

  const pendingById = new Map(recordable.map((receipt) => [receipt.unitId, receipt]));
  const order = view.collectionOrder.filter((unitId) => pendingById.has(unitId));
  const collected: UnitDraftReceipt[] = [];
  let expectedUpdatedAt = manifest.updatedAt;

  for (const unitId of order) {
    await assertNotConcurrentlyModified(runPath, expectedUpdatedAt);
    const receipt = pendingById.get(unitId)!;
    const unit = planUnit(view, unitId);
    const paths = unitPaths(runDir, unitId);
    await assertPromisedArtifacts(receipt, paths);
    // What this checks, exactly: at the moment THIS unit is recorded, every child it names is in the ledger and
    // its summary still digests to what this unit's own summary says it read. A child re-drafted after this unit
    // was already collected is NOT caught here — nothing is re-examining an already-recorded parent, and that
    // staleness is the epic's gate-10 item ("child summary digest mismatch") which R7's cross-unit checker owns.
    const collectedRows = new Map(collectedUnitsFor(ledger, knowledgeEpoch, view.planCatalogDigest).map((row) => [row.unitId, row]));
    const recordedChildren = unit.childUnitIds.length ? await recordedChildDigests(paths.summary, unitId) : [];
    for (const childUnitId of unit.childUnitIds) {
      const row = collectedRows.get(childUnitId);
      if (!row) {
        throw new Error(`Unit ${JSON.stringify(unitId)} cannot be collected: its child ${JSON.stringify(childUnitId)} is not collected, so the summary it was written from is not recorded`);
      }
      const referenced = recordedChildren.find((child) => child.childUnitId === childUnitId)?.summaryDigest;
      if (referenced !== row.summaryDigest) {
        throw new Error(`Unit ${JSON.stringify(unitId)} was written from summary ${String(referenced)} of child ${JSON.stringify(childUnitId)}, but that child's recorded summary digests to ${row.summaryDigest}; re-draft ${JSON.stringify(unitId)} from the child's current summary`);
      }
    }

    // GATE 1b, AT THE MOMENT THE UNIT IS COMPLETED. Every material obligation this unit can reach must be grounded
    // by this unit's own claims. It runs BEFORE the timeline append, so a refused unit leaves no event and no
    // ledger row, and the receipt stays on disk — the same fail-closed-but-never-permanent contract as every other
    // refusal here. This is the only thing R4b changes in this barrier.
    const grounding = await auditUnitFromDisk(runDir, view, unit);
    if (grounding.verdict.conclusion === "violations") {
      throw new Error(`Unit ${JSON.stringify(unitId)} cannot be collected: ${summariseUnitGrounding(grounding)}. ${grounding.verdict.problems.join("; ")}. Fix the claims and re-draft this unit; its receipt is left in place.`);
    }

    // R5a, and it runs only for the kind that has children: a synthesis may re-state its children's facts and may
    // not add one. The children's claims are read from disk here, after the child checks above proved every one of
    // them is collected, so the permitted set is exactly what the run recorded rather than what a draft claimed.
    if (requiresChildClaimBacklink(unit.kind)) {
      const backlink = await auditSynthesisBacklinkFromDisk(runDir, unit);
      if (backlink.verdict.conclusion === "violations") {
        throw new Error(`Unit ${JSON.stringify(unitId)} cannot be collected: ${summariseSynthesisBacklink(backlink)}. ${backlink.verdict.problems.join("; ")}. Move the fact into the child that owns it, or cite that child's own id, then re-draft this unit; its receipt is left in place.`);
      }
    }

    const event = await appendTimeline(runDir, manifest.id, {
      stage: "authoring",
      action: receipt.revision ? "unit.revised" : "unit.checkpoint",
      documentId: receipt.documentId,
      evidenceIds: [...receipt.evidenceIds],
      traceIds: [...receipt.traceIds],
      // `provenance` is in the event because the chain is the tamper-evident half of the account: a unit that
      // entered the ledger by cache admission rather than by being written should say so where nothing can be
      // rewritten afterwards, not only in a file a later write could replace.
      data: { unitId, kind: receipt.kind, revision: receipt.revision, draftedAt: receipt.draftedAt, collected: true, provenance: receipt.provenance.kind }
    });
    const row: CollectedUnit = {
      unitId,
      documentId: receipt.documentId,
      kind: receipt.kind,
      knowledgeEpoch,
      planCatalogDigest: view.planCatalogDigest,
      collectedAt: nowIso(),
      revision: receipt.revision,
      // Copied verbatim from the receipt, which is deleted below: the ledger is the lasting account of who wrote
      // this unit, what identity it was written under, and whether it was written or admitted (R6b).
      authorship: receipt.authorship,
      packetIdentityDigest: receipt.packetIdentityDigest,
      provenance: receipt.provenance,
      contentDigest: receipt.contentDigest,
      claimsDigest: receipt.claimsDigest,
      summaryDigest: receipt.summaryDigest,
      timelineSequence: event.sequence
    };
    ledger = withCollectedUnit(ledger, row);
    await writeUnitLedger(runDir, ledger);
    manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
    manifest.updatedAt = nowIso();
    await writeJson(runPath, manifest);
    await writeJson(metricsPath, manifest.metrics);
    await rm(paths.receipt);
    expectedUpdatedAt = manifest.updatedAt;
    collected.push(receipt);
  }

  await assertNotConcurrentlyModified(runPath, expectedUpdatedAt);
  return { collected, ledger, unplanned };
}

/** The child summaries one unit's own summary says it read. Parsed, so a malformed one is named, not assumed. */
async function recordedChildDigests(summaryPath: string, unitId: string): Promise<readonly UnitChildSummaryDigest[]> {
  const parsed = parseUnitSummary(await readJson<unknown>(summaryPath));
  if (parsed.summary === null) {
    throw new Error(`${summaryPath} is no longer a valid summary for ${JSON.stringify(unitId)}: ${parsed.problems.join("; ")}`);
  }
  return parsed.summary.childSummaryDigests;
}

/**
 * The receipts on disk, ascending by unit id.
 *
 * The directory is scanned rather than derived from the plan, and that is what makes the epoch refusal above
 * reachable: after a re-freeze the recorded plan is superseded, so a plan-driven scan could not see the receipts
 * it needs to refuse. Each receipt's directory is checked against the key its own unit id encodes to — a receipt
 * filed under someone else's directory is the shape a path-collapse bug would take, and it is named here.
 */
export async function pendingUnitReceipts(runDir: string): Promise<readonly UnitDraftReceipt[]> {
  const root = unitsDir(runDir);
  if (!await exists(root)) return [];
  const receipts: UnitDraftReceipt[] = [];
  for (const dir of await listDirectories(root)) {
    const path = join(dir, "receipt.json");
    if (!await exists(path)) continue;
    let raw: unknown;
    try {
      raw = await readJson<unknown>(path);
    } catch (error) {
      throw new Error(`${path} could not be read as JSON: ${(error as Error).message}`);
    }
    const parsed = parseUnitReceipt(raw);
    if (parsed.receipt === null) throw new Error(`${path} is not a valid unit draft receipt: ${parsed.problems.join("; ")}`);
    const key = unitPathKey(parsed.receipt.unitId);
    if (key !== basename(dir)) {
      throw new Error(`${path} records unit ${JSON.stringify(parsed.receipt.unitId)}, which belongs in ${JSON.stringify(key)} and not in ${JSON.stringify(basename(dir))}`);
    }
    receipts.push(parsed.receipt);
  }
  return receipts.sort((a, b) => compareUnitIds(a.unitId, b.unitId));
}

/** Every artifact the receipt promised, present and still the bytes it digested. Any miss is a named refusal. */
async function assertPromisedArtifacts(receipt: UnitDraftReceipt, paths: { content: string; claims: string; summary: string }): Promise<void> {
  const problems = await promisedArtifactProblems(paths, receipt);
  if (problems.length === 0) return;
  const subject: PromiseSubject = { unitId: receipt.unitId, record: "Unit draft receipt", possessive: "its receipt" };
  throw new Error(problems.map((problem) => describePromisedArtifactProblem(subject, problem)).join("; "));
}

/** Weak concurrency guard, the same shape the section barrier uses: best-effort, and never a lock. */
async function assertNotConcurrentlyModified(runPath: string, expectedUpdatedAt: string): Promise<void> {
  const onDisk = await readJson<RunManifest>(runPath);
  if (onDisk.updatedAt !== expectedUpdatedAt) {
    throw new Error("Run was modified concurrently during unit collect (run.json updatedAt changed); rerun collect after the concurrent command finishes.");
  }
}
