import type { EvidenceItem } from "../base/types.ts";
import { buildCrossRepoArtifact, mintCrossRepoEvidence, type CrossRepoArtifact } from "./crossrepo-artifact.ts";
import { scanCrossRepoLinks, type CrossRepoScan } from "./crossrepo-scan.ts";

/**
 * Resolve cross-repo HTTP links for a multi-module target. A single-repo run has no cross-repo edge to find;
 * an advisory resolver failure is recorded as a warning and cannot fail preparation.
 *
 * It lives in `src/crossrepo/` rather than under `src/run/stages/` because layer 5 now needs it: candidate
 * admission happens inside `prepare`, and the orchestration tree sits ABOVE every layer — a layer importing from
 * it is an upward edge the layer-order test refuses. Nothing about the logic moved; only its address did.
 */
export async function resolveCrossRepoLinks(
  target: string,
  modules: Array<{ id: string; dir: string; path: string }> | undefined,
  snapshotId: string,
  warnings: string[],
  redact: boolean,
): Promise<{ scan: CrossRepoScan; artifact: CrossRepoArtifact; evidence: EvidenceItem[] } | null> {
  if (!modules?.length) return null;
  try {
    const scan = await scanCrossRepoLinks(target, modules.map((module) => ({ id: module.id, dir: module.dir, databasePath: module.path })));
    warnings.push(...scan.warnings.slice(0, 20));
    const binding = mintCrossRepoEvidence(scan, snapshotId, redact);
    return { scan, artifact: buildCrossRepoArtifact(scan, snapshotId, binding, redact), evidence: binding.evidence };
  } catch (error) {
    warnings.push(`cross-repo link resolution skipped: ${(error as Error).message}`);
    return null;
  }
}
