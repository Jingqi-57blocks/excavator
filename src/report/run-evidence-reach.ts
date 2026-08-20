/**
 * One run's evidence records and the mechanism-A reach over them, loaded once.
 *
 * WHY IT IS ITS OWN FILE. Three callers now need exactly this pair — the plan stage (its budget check renders every
 * packet), the authoring gate (it re-validates the recorded plan, which means measuring it again) and the unit
 * packet loader — and a fourth spelling of "open evidence.json, then work out which records nothing binds" is a
 * fourth chance for the numbers a packet prints to disagree with the numbers a gate checked. The derivation itself
 * stays in `unit-packet.ts`, beside the type it produces; this file is only the read.
 *
 * IT IS A READ, AND IT RECORDS WHAT IT READ. `readPaths` is published rather than assumed so the forbidden-input
 * assertion over a caller's path list keeps working: the plan side may not open `sections/`, `reports/`, `prompts/`
 * or the target's source, and the way that is enforced is by every read naming itself.
 */

import type { EvidenceItem } from "../base/types.ts";
import { readEvidenceCatalog } from "../investigation/evidence-store.ts";
import type { TopicCatalogSource } from "./topic-catalog-source.ts";
import { evidenceReachOf, type RunEvidenceReach } from "./unit-packet.ts";

export interface RunEvidenceInputs {
  readonly evidenceById: ReadonlyMap<string, EvidenceItem>;
  readonly reach: RunEvidenceReach;
  /** Run-relative paths this load opened, sorted. */
  readonly readPaths: readonly string[];
}

/**
 * Load `evidence.json` and derive the reach against the ledgers the epoch sealed.
 *
 * `source` is required rather than re-read: it is the digest-checked projection the caller already holds, so the
 * work items and the frozen evidence id set come from bytes that were verified against the seal instead of from a
 * second, unchecked open of the same files.
 */
export async function loadRunEvidenceReach(runDir: string, source: TopicCatalogSource): Promise<RunEvidenceInputs> {
  const catalog = await readEvidenceCatalog(runDir);
  const evidenceById = new Map(catalog.evidence.map((item) => [item.id, item]));
  return {
    evidenceById,
    reach: evidenceReachOf(source.knowledge.evidenceIds ?? [], source.workItems, evidenceById),
    readPaths: ["evidence.json"]
  };
}
