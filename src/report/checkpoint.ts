import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { atomicWrite, exists, nowIso, sha256 } from "../base/util.ts";

/**
 * The checkpoint machine: normalise one authored section, and archive the revision it replaces.
 *
 * Both halves were in `run.ts`, which is orchestration — so the report-side parallel-authoring path had to
 * import the orchestrator to save a section, an upward edge and a cycle (`run.ts` imports parallel-authoring
 * for its draft collection). They belong to the report side: their subject is authored section text and the
 * claims file beside it, and neither touches any run state — `normalizeSection` is pure, `archiveCheckpoint`
 * takes every path it needs.
 */

export function normalizeSection(content: string, expectedTitle: string): string {
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Section content is empty");
  if (/^##\s+/m.test(trimmed)) return `${trimmed}\n`;
  return `## ${expectedTitle}\n\n${trimmed}\n`;
}

export async function archiveCheckpoint(runDir: string, documentId: string, sectionFile: string, claimsFile: string): Promise<boolean> {
  let archived = false;
  const stamp = nowIso().replace(/[:.]/g, "-");
  // Name each archive after the file it captures, so history mirrors the `NN-<slug>` section stem (and,
  // for grandfathered `NN.md` runs, still the bare `NN`) with a per-revision stamp and content digest.
  if (await exists(sectionFile)) {
    const content = await readFile(sectionFile, "utf8");
    await atomicWrite(join(runDir, "history", documentId, `${basename(sectionFile, ".md")}-${stamp}-${sha256(content).slice(0, 8)}.md`), content);
    archived = true;
  }
  if (await exists(claimsFile)) {
    const content = await readFile(claimsFile, "utf8");
    await atomicWrite(join(runDir, "history", documentId, `${basename(claimsFile, ".json")}-${stamp}-${sha256(content).slice(0, 8)}.claims.json`), content);
    archived = true;
  }
  return archived;
}
