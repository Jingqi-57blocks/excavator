/**
 * The knowledge-side inputs a Topic Catalog is allowed to read, loaded once and checked against the frozen epoch.
 *
 * WHICH EPOCH IT PROJECTS. The one the run manifest selects, mapped to a path by `currentKnowledgeRelativePath`
 * in `src/freeze/` — the single owner of the epoch-number-to-path mapping. This file never names an epoch file
 * itself: epoch 0 lives at `knowledge.json` and every later epoch under `knowledge/epochs/epoch-N.json`, so a
 * literal here would have projected epoch 0 forever and a re-freeze would have left the report side behind the
 * knowledge with nothing saying so. The manifest arrives as a REQUIRED parameter for the same reason: an optional
 * one would have let each new call site quietly re-acquire the old behaviour.
 *
 * WHAT IT REFUSES. A run whose selected epoch record is absent, of another version, or missing its epoch/
 * `frozenAt` is refused by name — the catalog is a projection OF a sealed epoch, and projecting an unsealed run
 * would date a planning artifact to a moment the knowledge could still move. The record found at the selected
 * path must also BE that epoch: a record whose own epoch number maps to a different file is refused rather than
 * projected, which is the structural tripwire against this file ever going back to a hardcoded path. Every
 * declared digest is recomputed against the ledger on disk (`workitemsDigest`, `readObligationsDigest`,
 * `boundaryFunctionsDigest`, and the two context ledgers when declared): a ledger edited after freeze fails here
 * rather than becoming a topic. And the optional pair is checked BOTH ways — a digest with no file, or a file
 * with no digest, is a named failure, never a quietly skipped facet.
 *
 * WHAT IT MAY NOT READ. `sections/`, `claims/`, `context/authoring/`, `reports/` and `prompts/` are the authoring
 * side. A catalog that read them would be deriving its plan from a previous draft, which is how a report starts
 * agreeing with itself instead of with the code. The rule is enforced, not documented: every read goes through
 * one helper that records the run-relative path, `readPaths` publishes the whole list, and
 * `FORBIDDEN_INPUT_PREFIXES` is asserted against it in test. The target repository's source is not read either —
 * nothing here opens a file outside the run directory.
 */

import { join } from "node:path";
import type { ArtifactResult } from "../base/artifact-result.ts";
import type { InvestigationPlan, InvestigationWorkItem, KnowledgeArtifact, RunManifest } from "../base/types.ts";
import { canonicalJson, exists, readJson, sha256, stableJson } from "../base/util.ts";
import { currentKnowledgeRelativePath, knowledgeEpochRelativePath } from "../freeze/freeze.ts";
import type { RunIntent, RunIntentFeature } from "../contract/bound-run-contract.ts";
import type { CrossFeatureRelationships } from "../context/cross-feature.ts";
import type { CrossRepoArtifact } from "../crossrepo/crossrepo-artifact.ts";
import type { ProducerFactSet } from "../facts/envelope.ts";
import type { BoundaryFunctionsArtifact } from "../facts/probe/boundary-functions.ts";
import type { ReadObligationsArtifact } from "../obligation/read-obligations.ts";
import type { ReadCoverageReport } from "../investigation/read-coverage.ts";

/** Run-relative directories a Topic Catalog may never read. Asserted against `readPaths` in test. */
export const FORBIDDEN_INPUT_PREFIXES = ["claims/", "context/authoring/", "prompts/", "reports/", "sections/"] as const;

/** The three layer-3 producer envelopes the catalog projects. Each must exist on every run, by registry. */
export const PROJECTED_PRODUCERS = ["codegraph", "crossrepo", "db-schema"] as const;
export type ProjectedProducer = (typeof PROJECTED_PRODUCERS)[number];

/**
 * A ledger whose presence is itself a fact about the run. Two states, both carrying their reason, so a facet
 * built on an absent ledger can say WHICH file was not there instead of reporting zero rows.
 */
export type LedgerPresence<T> =
  | { readonly state: "present"; readonly value: T }
  | { readonly state: "absent"; readonly reason: string };

export interface TopicCatalogSource {
  readonly runDir: string;
  readonly knowledge: KnowledgeArtifact;
  /** sha256 over the canonical bytes of the frozen epoch record — this catalog's input identity. */
  readonly knowledgeDigest: string;
  readonly workItems: readonly InvestigationWorkItem[];
  /** The bound contract's feature keys. The catalog never re-derives a feature key from a work item scope. */
  readonly features: readonly RunIntentFeature[];
  readonly obligations: ReadObligationsArtifact;
  readonly residual: ReadCoverageReport;
  readonly boundaryFunctions: BoundaryFunctionsArtifact;
  readonly crossFeature: LedgerPresence<CrossFeatureRelationships>;
  readonly crossRepoLinks: LedgerPresence<CrossRepoArtifact>;
  readonly producers: ReadonlyMap<ProjectedProducer, ArtifactResult<ProducerFactSet>>;
  /** Every run-relative path this load actually opened, sorted. The input contract, as data. */
  readonly readPaths: readonly string[];
}

/**
 * Load and check one frozen run's knowledge-side ledgers, at the epoch `manifest` selects.
 *
 * Every failure names the file and what is wrong with it — including which epoch file was actually opened, so a
 * re-frozen run's failure never reads as if epoch 0 were still the subject. There is no path that returns an
 * empty source because something was missing: a facet may be empty, a load may not be.
 */
export async function loadTopicCatalogSource(runDir: string, manifest: RunManifest): Promise<TopicCatalogSource> {
  const readPaths: string[] = [];
  const read = async <T>(relative: string): Promise<T> => {
    readPaths.push(relative);
    const path = join(runDir, relative);
    if (!await exists(path)) throw new Error(`${relative} is missing from ${runDir}; a Topic Catalog cannot be projected without it`);
    try {
      return await readJson<T>(path);
    } catch (error) {
      throw new Error(`${relative} could not be read as JSON: ${(error as Error).message}`);
    }
  };

  const epochPath = currentKnowledgeRelativePath(manifest);
  const knowledge = await read<KnowledgeArtifact>(epochPath);
  const epoch = assertFrozen(knowledge, epochPath);
  assertSelectedEpoch(epoch, epochPath);
  const plan = await read<InvestigationPlan>("workitems.json");
  if (!Array.isArray(plan.items)) throw new Error("workitems.json has no items array; the obligation ledger cannot be read");
  const workItems = plan.items;
  const recomputed = sha256(stableJson(workItems.map((item) => ({ id: item.id, status: item.status })).sort((a, b) => a.id.localeCompare(b.id))));
  if (recomputed !== knowledge.workitemsDigest) {
    throw new Error(`workitems.json does not match the workitemsDigest sealed in ${epochPath} (${recomputed} vs ${knowledge.workitemsDigest}); the ledger changed after freeze`);
  }

  // The 57B-453 check at the source, where it is cheap: a work item may only bind evidence and traces the epoch
  // sealed. `evidence.json` itself is never opened — the epoch's own id list is the frozen set, and reading the
  // excerpts would put source text one assignment away from a planning artifact.
  const frozenEvidence = new Set(knowledge.evidenceIds ?? []);
  const frozenTraces = new Set(knowledge.traceIds ?? []);
  for (const item of workItems) {
    for (const id of item.evidenceIds) {
      if (!frozenEvidence.has(id)) throw new Error(`Work item ${JSON.stringify(item.id)} binds evidence ${JSON.stringify(id)}, which ${epochPath} did not seal; the binding cannot be grounded`);
    }
    for (const id of item.traceIds) {
      if (!frozenTraces.has(id)) throw new Error(`Work item ${JSON.stringify(item.id)} binds trace ${JSON.stringify(id)}, which ${epochPath} did not seal; the binding cannot be grounded`);
    }
  }

  const intent = await read<RunIntent>("contract/run-intent.json");
  if (!Array.isArray(intent.features)) throw new Error("contract/run-intent.json has no features array; the bound feature keys cannot be read");

  const obligations = await read<ReadObligationsArtifact>("coverage/read-obligations.json");
  requireDigest("coverage/read-obligations.json", obligations, knowledge.readObligationsDigest, epochPath);
  const residual = await read<ReadCoverageReport>("coverage/read-residual.json");
  if (!Array.isArray(residual.items)) throw new Error("coverage/read-residual.json has no items array; the read residual cannot be read");
  const boundaryFunctions = await read<BoundaryFunctionsArtifact>("context/boundary-functions.json");
  requireDigest("context/boundary-functions.json", boundaryFunctions, knowledge.boundaryFunctionsDigest, epochPath);

  const crossFeature = await optionalLedger<CrossFeatureRelationships>(runDir, "context/cross-feature.json", knowledge.crossFeatureDigest, readPaths, epochPath);
  const crossRepoLinks = await optionalLedger<CrossRepoArtifact>(runDir, "context/crossrepo-links.json", knowledge.crossRepoLinksDigest, readPaths, epochPath);

  const producers = new Map<ProjectedProducer, ArtifactResult<ProducerFactSet>>();
  for (const producer of PROJECTED_PRODUCERS) {
    const relative = `facts/producers/${producer}.json`;
    const envelope = await read<ArtifactResult<ProducerFactSet>>(relative);
    if (envelope === null || typeof envelope !== "object" || typeof (envelope as { status?: unknown }).status !== "string") {
      throw new Error(`${relative} is not a producer envelope; a layer-3 producer records its outcome on every run`);
    }
    producers.set(producer, envelope);
  }

  return {
    runDir,
    knowledge,
    knowledgeDigest: sha256(canonicalJson(knowledge)),
    workItems,
    features: intent.features,
    obligations,
    residual,
    boundaryFunctions,
    crossFeature,
    crossRepoLinks,
    producers,
    readPaths: [...readPaths].sort((a, b) => a.localeCompare(b))
  };
}

/**
 * The sealing check. `frozenAt` and `epoch` are what make this record an epoch rather than a snapshot of a run in
 * flight; a run that has not reached freeze has no epoch record at all, and one that has must carry both.
 *
 * Returns the epoch number so the caller gets it NARROWED. `Number.isSafeInteger` is a runtime check, not a type
 * guard, and every downstream use of the number would otherwise re-assert the same thing.
 */
function assertFrozen(knowledge: KnowledgeArtifact, epochPath: string): number {
  if (knowledge.version !== "knowledge-v1") {
    throw new Error(`${epochPath} is version ${JSON.stringify(knowledge.version)}, not knowledge-v1; this catalog projects only knowledge-v1 epochs`);
  }
  if (typeof knowledge.frozenAt !== "string" || knowledge.frozenAt.trim() === "") {
    throw new Error(`${epochPath} carries no frozenAt; the run is not frozen and its knowledge can still move`);
  }
  // `< 0` belongs here rather than being left to the path mapping: the mapping would throw its own generic
  // `Invalid knowledge epoch`, which names neither this file nor that a catalog was being projected from it.
  if (knowledge.epoch === undefined || !Number.isSafeInteger(knowledge.epoch) || knowledge.epoch < 0) {
    throw new Error(`${epochPath} carries no usable epoch number (${JSON.stringify(knowledge.epoch)}); an unsealed record cannot be projected`);
  }
  if (typeof knowledge.workitemsDigest !== "string" || knowledge.workitemsDigest.trim() === "") {
    throw new Error(`${epochPath} carries no workitemsDigest; the obligation ledger it sealed cannot be identified`);
  }
  return knowledge.epoch;
}

/**
 * The record found at the manifest-selected path must BE that epoch.
 *
 * This is the structural tripwire, and it is why it compares a MANIFEST-DERIVED path rather than the path the
 * read happened to use: the defect this replaces was a hardcoded `knowledge.json`, and any return to one puts an
 * epoch-0 record under a manifest that selects epoch N, which fails here on every re-frozen run. It deliberately
 * does not re-check `manifest.knowledgeDigest` — `assertCurrentKnowledgeEpochForAuthoring` and the freeze audit
 * own that rule, and a second copy of it here would be a second rule to keep in step.
 */
function assertSelectedEpoch(epoch: number, epochPath: string): void {
  const belongsAt = knowledgeEpochRelativePath(epoch);
  if (belongsAt !== epochPath) {
    throw new Error(`The knowledge record projected for this catalog carries epoch ${epoch}, which belongs at ${belongsAt}, but the run manifest selects ${epochPath}; a Topic Catalog projects the manifest-selected epoch and never another one`);
  }
}

/** A digest the epoch always declares. Absent means the run predates the seal; mismatched means it was edited. */
function requireDigest(relative: string, value: unknown, declared: string | undefined, epochPath: string): void {
  if (declared === undefined) {
    throw new Error(`${epochPath} declares no digest for ${relative}; this run was frozen before that ledger was sealed and cannot be projected`);
  }
  const recomputed = sha256(stableJson(value));
  if (recomputed !== declared) {
    throw new Error(`${relative} does not match the digest sealed in ${epochPath} (${recomputed} vs ${declared}); it changed after freeze`);
  }
}

/**
 * A ledger the epoch declares only when the run produced one. Checked in both directions: a declared digest with
 * no file is a deleted ledger, and a file with no declared digest is a ledger that arrived after the seal. Either
 * one, left unchecked, would put unsealed rows into a planning artifact.
 */
async function optionalLedger<T>(
  runDir: string,
  relative: string,
  declared: string | undefined,
  readPaths: string[],
  epochPath: string
): Promise<LedgerPresence<T>> {
  const path = join(runDir, relative);
  const present = await exists(path);
  if (!present && declared === undefined) {
    return { state: "absent", reason: `${relative} is absent from this run and ${epochPath} declares no digest for it` };
  }
  if (!present) throw new Error(`${epochPath} declares a digest for ${relative} but the file is gone; the sealed ledger cannot be re-read`);
  readPaths.push(relative);
  if (declared === undefined) throw new Error(`${relative} exists but ${epochPath} declares no digest for it; it was not part of the sealed epoch`);
  let value: T;
  try {
    value = await readJson<T>(path);
  } catch (error) {
    throw new Error(`${relative} could not be read as JSON: ${(error as Error).message}`);
  }
  requireDigest(relative, value, declared, epochPath);
  return { state: "present", value };
}
