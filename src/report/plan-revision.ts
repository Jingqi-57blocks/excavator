/**
 * `plan/revisions/` — the archive of every plan revision this epoch superseded, and the succession that ties them.
 *
 * WHY A REVISION EXISTS AT ALL. `plan/catalog.json` is written once per (epoch, revision) because a plan is what
 * the units downstream were written against; replacing it in place would leave every receipt pointing at a plan
 * that no longer says the same thing. But the report side legitimately needs to re-plan WITHOUT a knowledge
 * change: one more audience is requested, or a unit is divided differently, and neither touches the sealed epoch.
 * Minting an epoch for that would forge a knowledge change into the audit chain. So the second axis is the
 * REVISION: freeze owns the epoch, the report side owns the revision, and `(epoch, revision)` is the identity the
 * write-once law is stated over.
 *
 * WHAT THIS FILE OWNS. Deriving the next revision from the plan on disk; refusing a revision that supersedes
 * nothing; archiving the revision being replaced, append-only and write-once; and WALKING THE CHAIN back to
 * revision 0 so that "revision N+1 names revision N's digest" is a checked fact rather than a field somebody
 * filled in. `plan-artifacts.ts` owns the fields and refuses to replace a current plan whose predecessor is not
 * already archived at the path it is told — so neither file trusts the other to have done its half.
 *
 * WHY THE CONTENT COMPARISON EXCLUDES THE REVISION FIELDS. `planRevision` is inside the catalog's own bytes, so a
 * revision recorded over an unchanged plan would change `planCatalogDigest` and turn every current receipt into a
 * cache candidate — a whole run's units re-entered to record the same plan twice. Two plans that say the same
 * thing must therefore compare equal, which they only do with the succession fields removed.
 *
 * WHY THE ARCHIVE PATH CARRIES THE EPOCH. A re-frozen run re-plans onto its new epoch at revision 0 (revisions do
 * not carry across a re-freeze — the plan they revised is not this epoch's plan), so `plan/revisions/epoch-0/…`
 * and `plan/revisions/epoch-1/…` are different histories. Keying the archive by revision alone would make epoch
 * 1's first revision collide with epoch 0's, and a write-once archive would then refuse a legitimate re-plan.
 */

import { join } from "node:path";
import { canonicalJson, exists, readJson, sha256, stableJson, writeJson } from "../base/util.ts";
import {
  PLAN_REVISION_FIELDS,
  planCatalogDigest,
  planDagPath,
  planDagProblems,
  planRevisionProblems,
  readPlanDag,
  writePlanArtifacts,
  type PlanArtifacts,
  type PlanCatalogArtifact,
  type PlanDagArtifact,
  type PlanRevisionRef
} from "./plan-artifacts.ts";
import type { TopicCatalogArtifact } from "./topic-catalog.ts";

/** Where one superseded revision's two artifacts live. */
export interface PlanRevisionArchive {
  readonly catalog: string;
  readonly dag: string;
}

/** The directory every superseded revision of every epoch is archived under. */
function planRevisionsDir(runDir: string): string {
  return join(runDir, "plan", "revisions");
}

/** The archive paths of one (epoch, revision). Spelled once so no caller re-spells the layout. */
export function planRevisionArchive(runDir: string, knowledgeEpoch: number, planRevision: number): PlanRevisionArchive {
  const dir = join(planRevisionsDir(runDir), `epoch-${knowledgeEpoch}`, `revision-${planRevision}`);
  return { catalog: join(dir, "catalog.json"), dag: join(dir, "dag.json") };
}

/**
 * The revision that follows the plan on disk, with the reason it is being recorded.
 *
 * The predecessor's digest is COMPUTED from the artifact in hand, never taken from a caller: a succession whose
 * link was supplied by whoever wanted the write is not a succession.
 */
export function nextPlanRevision(current: PlanCatalogArtifact, reason: string): PlanRevisionRef {
  if (reason.trim() === "") throw new Error("A plan revision states why it was recorded; `--reason` may not be blank");
  const ref: PlanRevisionRef = {
    planRevision: current.planRevision + 1,
    previousPlanCatalogDigest: planCatalogDigest(current),
    revisionReason: reason
  };
  const problems = planRevisionProblems(ref);
  if (problems.length > 0) throw new Error(`The next plan revision is not coherent: ${problems.join("; ")}`);
  return ref;
}

/**
 * What a plan SAYS, with the record of which revision it is removed.
 *
 * Two revisions with the same content digest are the same plan recorded twice, which is what makes the refusal
 * below possible at all.
 */
export function planContentDigest(catalog: PlanCatalogArtifact): string {
  const content: Record<string, unknown> = { ...catalog };
  for (const field of PLAN_REVISION_FIELDS) delete content[field];
  return sha256(canonicalJson(content));
}

/** A revision must supersede something. A plan identical to the recorded one is a named refusal, not a no-op write. */
export function assertRevisionSupersedes(next: PlanCatalogArtifact, current: PlanCatalogArtifact): void {
  const digest = planContentDigest(current);
  if (planContentDigest(next) !== digest) return;
  throw new Error(`The proposed plan is field for field the plan this run already records at revision ${current.planRevision} (content digest ${digest}); nothing is superseded, so no revision is recorded. Change the plan — or the recorded request set — before revising.`);
}

/**
 * Archive one revision's two artifacts. Identical bytes are a no-op; anything else at that path is a refusal.
 *
 * Append-only in the strong sense: an archived revision is the premise a later succession check stands on, so a
 * path that already holds different bytes is not overwritten and not merged — it is reported.
 */
export async function archivePlanRevision(runDir: string, artifacts: PlanArtifacts): Promise<PlanRevisionArchive> {
  const archive = planRevisionArchive(runDir, artifacts.planCatalog.knowledgeEpoch, artifacts.planCatalog.planRevision);
  await archiveOnce(archive.catalog, artifacts.planCatalog, "plan catalog");
  await archiveOnce(archive.dag, artifacts.dag, "authoring DAG");
  return archive;
}

async function archiveOnce(path: string, value: unknown, what: string): Promise<void> {
  if (await exists(path)) {
    const recorded = await readJson<unknown>(path).catch(() => null);
    if (recorded !== null && stableJson(recorded) === stableJson(value)) return;
    throw new Error(`${path} already archives a ${what} that is not the one being archived; an archived plan revision is written once and never replaced`);
  }
  await writeJson(path, value);
}

/**
 * Walk the succession from one catalog back to revision 0, through the archive, and return what it says.
 *
 * EVERY LINK IS RE-COMPUTED. Each archived revision's digest is taken from its own bytes and compared to the
 * predecessor its successor names, so a hand-edited archive, a missing revision or a renumbered chain is a named
 * failure here. A revision 0 that names a predecessor, or a chain that does not reach 0, fails the same way.
 */
export async function readPlanRevisionSuccession(runDir: string, catalog: PlanCatalogArtifact): Promise<readonly string[]> {
  const statements: string[] = [];
  let successor = { planRevision: catalog.planRevision, previousPlanCatalogDigest: catalog.previousPlanCatalogDigest };
  while (successor.planRevision > 0) {
    const revision = successor.planRevision - 1;
    const path = planRevisionArchive(runDir, catalog.knowledgeEpoch, revision).catalog;
    const archived = await readArchivedPlanCatalog(path);
    if (archived.planRevision !== revision) {
      throw new Error(`${path} archives revision ${archived.planRevision} where the succession expects revision ${revision}; the archived chain is renumbered`);
    }
    const digest = planCatalogDigest(archived);
    if (digest !== successor.previousPlanCatalogDigest) {
      throw new Error(`Plan revision ${successor.planRevision} names predecessor ${JSON.stringify(successor.previousPlanCatalogDigest)}, and the revision ${revision} archived at ${path} digests to ${digest}; the succession is broken`);
    }
    statements.push(`revision ${successor.planRevision} supersedes revision ${revision} (${digest})`);
    successor = { planRevision: revision, previousPlanCatalogDigest: archived.previousPlanCatalogDigest };
  }
  if (successor.previousPlanCatalogDigest !== null) {
    throw new Error(`Revision 0 of epoch ${catalog.knowledgeEpoch} names predecessor ${JSON.stringify(successor.previousPlanCatalogDigest)}; the first plan of an epoch supersedes nothing`);
  }
  return statements.reverse();
}

/**
 * One archived catalog, read for its succession fields and its digest.
 *
 * It is NOT re-validated against the topics catalog: an archived plan is a superseded plan, and re-deriving its
 * obligation accounting would say nothing about the succession while making the chain unreadable the moment the
 * epoch it belonged to moves. What the chain stands on is the digest, which is computed from these exact bytes —
 * so a tampered archive breaks the chain rather than passing a weaker check.
 */
async function readArchivedPlanCatalog(path: string): Promise<PlanCatalogArtifact> {
  if (!await exists(path)) {
    throw new Error(`${path} is missing; a plan revision's predecessor is archived, and a succession cannot be read across a gap`);
  }
  let raw: unknown;
  try {
    raw = await readJson<unknown>(path);
  } catch (error) {
    throw new Error(`${path} could not be read as JSON: ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${path} is not an archived plan catalog object`);
  const artifact = raw as Record<string, unknown>;
  const problems = planRevisionProblems({
    planRevision: artifact.planRevision,
    previousPlanCatalogDigest: artifact.previousPlanCatalogDigest,
    revisionReason: artifact.revisionReason
  });
  if (problems.length > 0) throw new Error(`${path} does not record a readable plan revision: ${problems.join("; ")}`);
  return raw as PlanCatalogArtifact;
}

/**
 * The plan a revise supersedes, read from the run — completing an interrupted revise rather than wedging on it.
 *
 * THE ORDINARY CASE is the pair on disk. The other case exists because the pair is two files: a revise interrupted
 * after the DAG landed leaves the recorded catalog at revision N beside the DAG of revision N+1, which does not
 * read against it. That state is not a tampered graph and must not be treated as one, and it is told apart
 * STRUCTURALLY rather than by guessing: revision N's own archive exists only once a revise of N has begun (a run
 * sitting at revision N archives 0…N-1 and not N), so when it is there, its DAG — write-once, verified equal to
 * the on-disk one when it was written — is the graph of the revision being superseded. With no such archive, an
 * unreadable graph is exactly what it looks like and the refusal stands.
 */
export async function planToSupersede(runDir: string, planCatalog: PlanCatalogArtifact): Promise<PlanArtifacts> {
  const onDisk = await readPlanDag(runDir, planCatalog).catch((error: Error) => error);
  if (!(onDisk instanceof Error)) return { planCatalog, dag: onDisk };
  const archive = planRevisionArchive(runDir, planCatalog.knowledgeEpoch, planCatalog.planRevision);
  if (!await exists(archive.dag)) throw onDisk;
  const archived = await readJson<unknown>(archive.dag).catch(() => null);
  const problems = archived === null ? ["could not be read as JSON"] : planDagProblems(archived, planCatalog);
  if (problems.length > 0) {
    throw new Error(`${planDagPath(runDir)} does not read against the recorded plan revision ${planCatalog.planRevision} (${onDisk.message}), and the graph archived for that revision at ${archive.dag} does not either: ${problems.join("; ")}`);
  }
  return { planCatalog, dag: archived as PlanDagArtifact };
}

/** What one recorded revision produced: where the superseded one went, and the succession as it now reads. */
export interface RecordedPlanRevision {
  readonly artifacts: PlanArtifacts;
  readonly archive: PlanRevisionArchive;
  readonly succession: readonly string[];
}

/**
 * Record one revision: refuse an empty one, archive what it replaces, check the chain, then replace the plan.
 *
 * THE ORDER IS THE POINT. Nothing on the current path is touched until the revision it replaces is on disk in the
 * archive and the whole chain back to revision 0 has been re-computed. Every step is idempotent, so an interrupted
 * revise is completed by re-running the same one: the archive write is a no-op on identical bytes, the chain walk
 * is a read, and the pair write accepts both the state it started from and the state it would leave (see
 * `writePlanArtifacts`, which also refuses a pair that moved under it).
 */
export async function recordPlanRevision(
  runDir: string,
  artifacts: PlanArtifacts,
  catalog: TopicCatalogArtifact,
  superseded: PlanArtifacts
): Promise<RecordedPlanRevision> {
  assertRevisionSupersedes(artifacts.planCatalog, superseded.planCatalog);
  const archive = await archivePlanRevision(runDir, superseded);
  const succession = await readPlanRevisionSuccession(runDir, artifacts.planCatalog);
  await writePlanArtifacts(runDir, artifacts, catalog, {
    kind: "supersede",
    superseded,
    archivedCatalogPath: archive.catalog,
    archivedDagPath: archive.dag
  });
  return { artifacts, archive, succession };
}
