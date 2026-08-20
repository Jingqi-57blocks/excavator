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
import { unitPathKey, unitPaths, unitsDir } from "./unit-paths.ts";
import { assertPlanEpoch, loadUnitPlanView, planUnit, requireKnowledgeEpoch } from "./unit-plan-view.ts";
import { parseUnitReceipt, type UnitDraftReceipt } from "./unit-receipt.ts";

export interface UnitCollectResult {
  readonly collected: readonly UnitDraftReceipt[];
  readonly ledger: UnitLedger;
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
  if (!pending.length) return { collected: [], ledger };

  for (const receipt of pending) {
    const unit = planUnit(view, receipt.unitId);
    if (receipt.planCatalogDigest !== view.planCatalogDigest) {
      throw new Error(`Unit draft receipt for ${JSON.stringify(receipt.unitId)} was written against plan ${receipt.planCatalogDigest.slice(0, 16)} but this run records plan ${view.planCatalogDigest.slice(0, 16)}; re-draft it against the recorded plan`);
    }
    if (receipt.documentId !== unit.documentId || receipt.kind !== unit.kind) {
      throw new Error(`Unit draft receipt for ${JSON.stringify(receipt.unitId)} records ${receipt.kind} in ${JSON.stringify(receipt.documentId)} but the plan records ${unit.kind} in ${JSON.stringify(unit.documentId)}`);
    }
  }

  const pendingById = new Map(pending.map((receipt) => [receipt.unitId, receipt]));
  const order = view.collectionOrder.filter((unitId) => pendingById.has(unitId));
  const collected: UnitDraftReceipt[] = [];
  let expectedUpdatedAt = manifest.updatedAt;

  for (const unitId of order) {
    await assertNotConcurrentlyModified(runPath, expectedUpdatedAt);
    const receipt = pendingById.get(unitId)!;
    const unit = planUnit(view, unitId);
    const paths = unitPaths(runDir, unitId);
    await assertPromisedArtifacts(receipt, paths);
    // The children of a synthesis were collected before it was drafted; if one has since been un-collected the
    // parent's summary references a digest this run no longer holds, and that is a refusal rather than a record.
    const alreadyCollected = new Set(collectedUnitsFor(ledger, knowledgeEpoch, view.planCatalogDigest).map((row) => row.unitId));
    for (const childUnitId of unit.childUnitIds) {
      if (!alreadyCollected.has(childUnitId)) {
        throw new Error(`Unit ${JSON.stringify(unitId)} cannot be collected: its child ${JSON.stringify(childUnitId)} is not collected, so the summary it was written from is not recorded`);
      }
    }

    const event = await appendTimeline(runDir, manifest.id, {
      stage: "authoring",
      action: receipt.revision ? "unit.revised" : "unit.checkpoint",
      documentId: receipt.documentId,
      evidenceIds: [...receipt.evidenceIds],
      traceIds: [...receipt.traceIds],
      data: { unitId, kind: receipt.kind, revision: receipt.revision, draftedAt: receipt.draftedAt, collected: true }
    });
    const row: CollectedUnit = {
      unitId,
      documentId: receipt.documentId,
      kind: receipt.kind,
      knowledgeEpoch,
      planCatalogDigest: view.planCatalogDigest,
      collectedAt: nowIso(),
      revision: receipt.revision,
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
  return { collected, ledger };
}

/**
 * The receipts on disk, ascending by unit id.
 *
 * The directory is scanned rather than derived from the plan, and that is what makes the epoch refusal above
 * reachable: after a re-freeze the recorded plan is superseded, so a plan-driven scan could not see the receipts
 * it needs to refuse. Each receipt's directory is checked against the key its own unit id encodes to — a receipt
 * filed under someone else's directory is the shape a path-collapse bug would take, and it is named here.
 */
async function pendingUnitReceipts(runDir: string): Promise<readonly UnitDraftReceipt[]> {
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
  return receipts.sort((a, b) => a.unitId.localeCompare(b.unitId));
}

/** Every artifact the receipt promised, present and still the bytes it digested. Any miss is a named refusal. */
async function assertPromisedArtifacts(receipt: UnitDraftReceipt, paths: { content: string; claims: string; summary: string }): Promise<void> {
  for (const [path, what] of [[paths.content, "content"], [paths.claims, "claims"], [paths.summary, "summary"]] as const) {
    if (!await exists(path)) {
      throw new Error(`Unit draft receipt for ${JSON.stringify(receipt.unitId)} promises ${what} that is not on disk: ${path}`);
    }
  }
  const content = sha256(await readFile(paths.content, "utf8"));
  if (content !== receipt.contentDigest) {
    throw new Error(`Unit ${JSON.stringify(receipt.unitId)} has content digesting to ${content}, but its receipt promises ${receipt.contentDigest}; re-draft the unit`);
  }
  for (const [path, recorded, what] of [[paths.claims, receipt.claimsDigest, "claims"], [paths.summary, receipt.summaryDigest, "summary"]] as const) {
    let parsed: unknown;
    try {
      parsed = await readJson<unknown>(path);
    } catch (error) {
      throw new Error(`${path} could not be read as JSON: ${(error as Error).message}`);
    }
    const digest = sha256(canonicalJson(parsed));
    if (digest !== recorded) {
      throw new Error(`Unit ${JSON.stringify(receipt.unitId)} has ${what} digesting to ${digest}, but its receipt promises ${recorded}; re-draft the unit`);
    }
  }
}

/** Weak concurrency guard, the same shape the section barrier uses: best-effort, and never a lock. */
async function assertNotConcurrentlyModified(runPath: string, expectedUpdatedAt: string): Promise<void> {
  const onDisk = await readJson<RunManifest>(runPath);
  if (onDisk.updatedAt !== expectedUpdatedAt) {
    throw new Error("Run was modified concurrently during unit collect (run.json updatedAt changed); rerun collect after the concurrent command finishes.");
  }
}
