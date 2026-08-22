/**
 * Normalise one authored section: give it its `## ` heading if the author did not write one.
 *
 * It was in `run.ts`, which is orchestration — so the report-side parallel-authoring path had to import the
 * orchestrator to save a section, an upward edge and a cycle (`run.ts` imported parallel-authoring for its draft
 * collection). It belongs to the report side: its subject is authored section text, and it touches no run state.
 *
 * IT ARRIVED WITH A SECOND HALF THAT IS GONE. `archiveCheckpoint` — which copied the previous revision of a
 * section file into `history/` before overwriting it — moved here in the same slice and was deleted with the
 * section checkpoint path (57B-481), because that path was its only caller. The unit path keeps its own history
 * through the unit ledger rather than through a per-file archive, so nothing here replaces it.
 */

export function normalizeSection(content: string, expectedTitle: string): string {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Section content is empty");
  if (/^##\s+/m.test(trimmed)) return `${trimmed}\n`;
  return `## ${expectedTitle}\n\n${trimmed}\n`;
}

