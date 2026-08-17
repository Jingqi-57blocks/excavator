import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DocumentPlan, InvestigationPlan, SectionClaim, SectionClaimsFile, TraceCatalog
} from "../core/types.ts";
import { exists, writeJson } from "../core/util.ts";

/**
 * Every claim in the run, keyed by document + section + claim id.
 *
 * A claim id is unique only WITHIN its section — sections number their claims `claim-1`, `claim-2`, … — so
 * keying on the id alone silently collapses the whole run into one section's worth. Measured: a real run
 * with 472 claims across 12 sections reported 81, because 74 ids appeared 12 times each. That number is
 * `metrics.claims` and it feeds `eval compare`, so it was a 5.8x undercount sitting in the cross-run
 * comparison. (Checked before fixing: no recorded conclusion ever came from it — `compare-runs.ts` asserts
 * improvement/regression only for time metrics, and counts stay neutral.)
 */
export async function collectClaims(runDir: string, documents: DocumentPlan[]): Promise<Map<string, SectionClaim>> {
  const claims = new Map<string, SectionClaim>();
  for (const document of documents) {
    for (const section of document.sections) {
      if (!await exists(section.claimsFile)) continue;
      const file = await readJsonFile<SectionClaimsFile>(section.claimsFile);
      for (const claim of file.claims) claims.set(`${document.id}#${section.index}#${claim.id}`, claim);
    }
  }
  return claims;
}

export async function writeReportCompanions(runDir: string, document: DocumentPlan, plan: InvestigationPlan, traces: TraceCatalog): Promise<void> {
  const claims: Array<SectionClaimsFile> = [];
  for (const section of document.sections) if (await exists(section.claimsFile)) claims.push(await readJsonFile<SectionClaimsFile>(section.claimsFile));
  const documentClaimIds = new Set(claims.flatMap((file) => file.claims.map((claim) => claim.id)));
  const documentTraces = traces.traces.filter((trace) => trace.documentIds.includes(document.id) || trace.steps.some((step) => (step.claimIds ?? []).some((id) => documentClaimIds.has(id))));
  const workItems = plan.items.filter((item) => item.requiredFor.includes(document.id));
  const base = join(runDir, "reports", "companions", document.id);
  await writeJson(`${base}.claims.json`, { version: 1, documentId: document.id, sections: claims });
  await writeJson(`${base}.traces.json`, { version: 1, documentId: document.id, traces: documentTraces });
  await writeJson(`${base}.coverage.json`, {
    version: 1,
    documentId: document.id,
    total: workItems.length,
    complete: workItems.filter((item) => !["pending", "in_progress"].includes(item.status)).length,
    material: workItems.filter((item) => item.material).length,
    items: workItems
  });
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
