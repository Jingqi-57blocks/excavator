import { resolve } from "node:path";
import type { RunManifest } from "../../base/types.ts";
import { codegraphIdentity } from "../../codegraph/codegraph-identity.ts";
import type { SnapshotDrift } from "../../freeze/freeze.ts";
import { SCANNER_VERSION, createSnapshot } from "../../snapshot/snapshot.ts";

/** Caches live beside `runs/` inside the per-target project directory: `<workdir>/<project>/cache`. */
export function projectCacheDir(runDir: string): string {
  return resolve(runDir, "..", "..", "cache");
}

/**
 * Re-derive a run's two identities and say what can be concluded from the comparison.
 *
 * One function for freeze, search and audit so they cannot drift into different readings of the same facts.
 * Snapshot ids are comparable only when they were derived by the same scanner generation. The CodeGraph
 * identity is read from either its current manifest field or the historical snapshot field.
 */
export async function reDeriveIdentities(
  runDir: string,
  manifest: RunManifest,
): Promise<{ current: Awaited<ReturnType<typeof createSnapshot>>; drift: SnapshotDrift } | null> {
  if (!manifest.snapshot) return null;
  const current = await createSnapshot(manifest.request.target, manifest.request.budgets.maxFiles, { cacheDir: projectCacheDir(runDir) });
  const comparable = manifest.snapshot.scannerVersion === SCANNER_VERSION;
  const recordedCodegraph = manifest.codegraphDigest ?? (manifest.snapshot as { codegraphDigest?: string | null }).codegraphDigest ?? null;
  const currentCodegraph = await codegraphIdentity(manifest.request.codegraphModules ?? manifest.request.codegraph);
  return {
    current,
    drift: {
      comparable,
      recordedScannerVersion: manifest.snapshot.scannerVersion,
      currentScannerVersion: SCANNER_VERSION,
      snapshotChanged: comparable && current.snapshot.id !== manifest.snapshot.id,
      codegraphChanged: currentCodegraph !== recordedCodegraph,
    },
  };
}
