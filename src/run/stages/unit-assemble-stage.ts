/**
 * `assemble --units` — the one place unit-path bytes reach the filesystem.
 *
 * TWO MODES, NEITHER DEFAULTED. `plan-only` computes the whole assembly, runs every refusal, and writes nothing;
 * `write` writes it. The flag is required at the command for the reason `unit-cache-admit --mode` is: one arm
 * mutates the run and the other cannot, and a mode with a default is a mode somebody gets by forgetting. Both arms
 * run the SAME loader, so a `plan-only` pass that succeeds is a real statement about what `write` would do rather
 * than a lighter check.
 *
 * NOTHING IS COMPUTED HERE. `loadUnitAssembly` returns paths and bytes; this file writes them, appends one timeline
 * event, and updates the two counters. That split is what makes "assemble is a pure function of the plan, the
 * collected units and the companions" a property of the code rather than a claim in a comment.
 *
 * IT DOES NOT TOUCH THE SECTION STATE MACHINE. `manifest.state`, `documents[].sections[]` and `metrics.claims`
 * belong to the section world; a unit assembly is recorded in the timeline and in the files it wrote, and nowhere
 * else. `assembleRun` sets `state = "assembled"`; this does not, deliberately, so a run that assembled units and a
 * run that assembled sections cannot be confused for one another by anything reading the manifest.
 *
 * THE CONCURRENCY BASELINE IS TAKEN BEFORE THE LOAD, WHICH IS THE WHOLE POINT OF HAVING ONE. `loadUnitAssembly`
 * is the expensive window — it re-validates the plan gate, reads the ledger and reads every collected unit's three
 * artifacts — so a `collect` that lands DURING it makes the assembly stale. A baseline captured after the load
 * could only ever trip on a writer that arrived between two adjacent reads, which is to say: never. So `run.json`
 * is read once, before anything else, and the same manifest is the one this stage later writes back.
 *
 * THE TIMELINE EVENT IS NOT A TIMESTAMP IN THE DELIVERABLE. Nothing this writes into `reports/` carries a clock
 * reading, which is what makes a second `write` over an unchanged run leave every assembled byte identical. The
 * event and `run.json`'s `updatedAt` do move, and that is the point of an append-only account: the deliverable is
 * idempotent, the record of having produced it is not.
 */

import { join, resolve } from "node:path";
import { assertNever } from "../../base/artifact-result.ts";
import type { RunManifest } from "../../base/types.ts";
import { appendTimeline } from "../../base/timeline.ts";
import { atomicWrite, nowIso, readJson, writeJson } from "../../base/util.ts";
import { assembledJsonBytes } from "../../report/unit-assembly.ts";
import { runRelativePath } from "../../report/unit-assembly-paths.ts";
import { loadUnitAssembly } from "../../report/unit-assembly-source.ts";
import type { ShippedCoverageArm } from "../../report/unit-assembly-coverage.ts";

/** The two arms. No default: see the file header. */
export const UNIT_ASSEMBLE_MODES = ["plan-only", "write"] as const;
export type UnitAssembleMode = (typeof UNIT_ASSEMBLE_MODES)[number];

export interface AssembledDocumentReading {
  readonly documentId: string;
  readonly path: string;
  readonly bytes: number;
  readonly units: readonly string[];
  readonly claimsCompanion: { readonly path: string; readonly claims: number; readonly bytes: number };
  readonly tracesCompanion: { readonly path: string; readonly traces: number; readonly bytes: number };
}

export interface UnitAssembleResult {
  readonly mode: UnitAssembleMode;
  readonly written: boolean;
  readonly runId: string;
  readonly knowledgeEpoch: number;
  readonly planCatalogDigest: string;
  readonly documents: readonly AssembledDocumentReading[];
  /** The companion, and the arm every coverage statement in it took — see `unit-assembly-coverage.ts`. */
  readonly coverageCompanion: { readonly path: string; readonly bytes: number; readonly arms: readonly ShippedCoverageArm[] };
  readonly readPaths: readonly string[];
}

/** Assemble one run's unit path. `plan-only` proves the assembly; `write` also puts it on disk. */
export async function assembleUnits(runDirInput: string, mode: UnitAssembleMode): Promise<UnitAssembleResult> {
  const runDir = resolve(runDirInput);
  const runPath = join(runDir, "run.json");
  // Before the load, not after it — see the file header.
  const manifest = await readJson<RunManifest>(runPath);
  const baseline = manifest.updatedAt;
  const assembly = await loadUnitAssembly(runDir);

  const files: Array<{ readonly path: string; readonly content: string }> = [];
  const documents: AssembledDocumentReading[] = [];
  for (const document of assembly.documents) {
    const claims = jsonBytes(document.claims.companion);
    const traces = jsonBytes(document.traces.companion);
    files.push(
      { path: document.path, content: document.markdown },
      { path: document.claims.path, content: claims },
      { path: document.traces.path, content: traces }
    );
    documents.push({
      documentId: document.documentId,
      path: document.path,
      bytes: Buffer.byteLength(document.markdown, "utf8"),
      units: document.units,
      claimsCompanion: { path: document.claims.path, claims: document.claims.companion.claims.length, bytes: Buffer.byteLength(claims, "utf8") },
      tracesCompanion: { path: document.traces.path, traces: document.traces.companion.traces.length, bytes: Buffer.byteLength(traces, "utf8") }
    });
  }
  files.push({ path: assembly.coverage.path, content: assembly.coverage.markdown });

  const reading: UnitAssembleResult = {
    mode,
    written: mode === "write",
    runId: assembly.runId,
    knowledgeEpoch: assembly.knowledgeEpoch,
    planCatalogDigest: assembly.planCatalogDigest,
    documents,
    coverageCompanion: { path: assembly.coverage.path, bytes: Buffer.byteLength(assembly.coverage.markdown, "utf8"), arms: assembly.coverage.arms },
    readPaths: assembly.readPaths
  };

  switch (mode) {
    case "plan-only":
      return reading;
    case "write": {
      // The weak concurrency guard the collect barrier uses, best-effort and never a lock, against the baseline
      // taken before the load: the first call is what catches a `collect` that landed while the assembly was being
      // computed, so stale bytes are refused instead of shipped. The second covers the writes themselves.
      await assertNotConcurrentlyModified(runPath, baseline);
      for (const file of files) await atomicWrite(runRelativePath(runDir, file.path), file.content);
      await assertNotConcurrentlyModified(runPath, baseline);
      await appendTimeline(runDir, manifest.id, {
        stage: "assemble",
        action: "units.assembled",
        data: { documents: assembly.documents.map((document) => document.documentId), planCatalogDigest: assembly.planCatalogDigest, files: files.length }
      });
      manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
      manifest.updatedAt = nowIso();
      await writeJson(runPath, manifest);
      await writeJson(join(runDir, "metrics.json"), manifest.metrics);
      return reading;
    }
  }
  return assertNever(mode, "unit assemble mode");
}

/**
 * Best-effort, never a lock: the same shape and the same message family the collect barrier uses.
 *
 * Exported so a fixture can make it fire. A guard whose only caller holds a baseline it just read is a guard nobody
 * has seen the shape of, and this one exists precisely to catch a writer that arrived a long way back.
 */
export async function assertNotConcurrentlyModified(runPath: string, expectedUpdatedAt: string): Promise<void> {
  const onDisk = await readJson<RunManifest>(runPath);
  if (onDisk.updatedAt !== expectedUpdatedAt) {
    throw new Error("Run was modified concurrently during unit assemble (run.json updatedAt changed); rerun assemble after the concurrent command finishes.");
  }
}

/**
 * The companion's bytes: `assembledJsonBytes`, the one spelling of the canonical JSON form with the trailing
 * newline `writeJson` also appends.
 *
 * Rendered here rather than handed to `writeJson` so the byte count in the reading is the count of the bytes that
 * were written, and so `plan-only` can report it without writing anything. The convention itself lives in
 * `unit-assembly.ts` because R7c's checker compares the bytes on disk against it.
 */
function jsonBytes(value: unknown): string {
  return assembledJsonBytes(value);
}
