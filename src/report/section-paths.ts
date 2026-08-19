import { basename, join } from "node:path";

/**
 * Where a run's section markdown and its claims sidecar live — derived from the run directory the caller was
 * handed, never from the absolute path `run.json` happened to record when the run was prepared.
 *
 * `DocumentPlan.sections[].file` / `.claimsFile` are a RECORD of where the run was prepared, not an
 * instruction about where to write. Reading them as an instruction split a copied run in two: the ledger
 * (`timeline.jsonl`, `run.json`, `metrics.json`) follows `--run`, so it landed in the copy while the section
 * and its claims landed in the original, and each half stayed internally consistent — the manifest in the
 * copy said "complete" with no file beside it, the original grew a file no ledger mentioned, and neither
 * side audited as wrong. A directory that cannot be moved is not an archive, so the run directory passed in
 * is the single authority for every path inside it.
 *
 * Only the file NAME is honoured from the record. The `NN-<slug>` stem is content, not location, and taking
 * it as recorded keeps runs whose stems predate the current scheme (bare `NN.md`) resolving to the file that
 * is actually on their disk. The layout around it — `sections/<documentId>/`, `claims/<documentId>/` — is
 * the same layout `makeDocumentPlan` builds, so for a run that never moved this returns exactly the
 * recorded path.
 */
export function sectionPaths(
  runDir: string,
  documentId: string,
  section: { readonly file: string; readonly claimsFile: string },
): { file: string; claimsFile: string } {
  return {
    file: join(runDir, "sections", documentId, recordedName(section.file, documentId, "section")),
    claimsFile: join(runDir, "claims", documentId, recordedName(section.claimsFile, documentId, "claims")),
  };
}

/** Fail closed on a recorded value that names no file: rebasing `..` onto the run directory would write outside it. */
function recordedName(recorded: string, documentId: string, kind: string): string {
  const name = basename(recorded);
  if (!name || name === "." || name === "..") {
    throw new Error(`Run manifest records no ${kind} file name for ${documentId} (recorded: ${JSON.stringify(recorded)})`);
  }
  return name;
}
