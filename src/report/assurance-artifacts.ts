import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DocumentPlan, InvestigationPlan, SectionClaim, SectionClaimsFile, TraceCatalog
} from "../base/types.ts";
import { exists, writeJson } from "../base/util.ts";
import { sectionPaths } from "./section-paths.ts";

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
      const claimsPath = sectionPaths(runDir, document.id, section).claimsFile;
      if (!await exists(claimsPath)) continue;
      const file = await readJsonFile<SectionClaimsFile>(claimsPath);
      for (const claim of file.claims) claims.set(`${document.id}#${section.index}#${claim.id}`, claim);
    }
  }
  return claims;
}

/**
 * The three run-relative companion paths one SECTION-path document occupies.
 *
 * Extracted from `writeReportCompanions` below, which is its only writer, so the unit path can refuse to assemble
 * into a name this path already owns without spelling these three names a second time. Pure move: the writer joins
 * the same strings it built inline before.
 */
export function sectionCompanionRelativePaths(documentId: string): { readonly claims: string; readonly traces: string; readonly coverage: string } {
  const base = `reports/companions/${documentId}`;
  return { claims: `${base}.claims.json`, traces: `${base}.traces.json`, coverage: `${base}.coverage.json` };
}

export async function writeReportCompanions(runDir: string, document: DocumentPlan, plan: InvestigationPlan, traces: TraceCatalog): Promise<void> {
  const claims: Array<SectionClaimsFile> = [];
  for (const section of document.sections) {
    const claimsPath = sectionPaths(runDir, document.id, section).claimsFile;
    if (await exists(claimsPath)) claims.push(await readJsonFile<SectionClaimsFile>(claimsPath));
  }
  const documentClaimIds = new Set(claims.flatMap((file) => file.claims.map((claim) => claim.id)));
  const documentTraces = traces.traces.filter((trace) => trace.documentIds.includes(document.id) || trace.steps.some((step) => (step.claimIds ?? []).some((id) => documentClaimIds.has(id))));
  const workItems = plan.items.filter((item) => item.requiredFor.includes(document.id));
  const companions = sectionCompanionRelativePaths(document.id);
  await writeJson(join(runDir, companions.claims), { version: 1, documentId: document.id, sections: claims });
  await writeJson(join(runDir, companions.traces), { version: 1, documentId: document.id, traces: documentTraces });
  await writeJson(join(runDir, companions.coverage), {
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
