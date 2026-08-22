import { readFile } from "node:fs/promises";
import type { DocumentPlan, SectionClaim, SectionClaimsFile } from "../base/types.ts";
import { exists } from "../base/util.ts";
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
 * Extracted from the section path's companion WRITER so the unit path could refuse to assemble into a name that
 * path already owns without spelling these three names a second time. The writer itself was deleted with the
 * section audit (57B-481); these names outlived it because the refusal still has to know them — an assembled unit
 * document must not land on a section run's companion path.
 */
export function sectionCompanionRelativePaths(documentId: string): { readonly claims: string; readonly traces: string; readonly coverage: string } {
  const base = `reports/companions/${documentId}`;
  return { claims: `${base}.claims.json`, traces: `${base}.traces.json`, coverage: `${base}.coverage.json` };
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
