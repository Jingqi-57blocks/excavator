import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TimelineEvent, TimelineEventInput } from "../base/types.ts";
import { ensureDir, exists, nowIso, sha256, stableJson } from "../base/util.ts";

export async function readTimeline(runDir: string): Promise<TimelineEvent[]> {
  const path = join(runDir, "timeline.jsonl");
  if (!await exists(path)) return [];
  const text = await readFile(path, "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as TimelineEvent; }
    catch { throw new Error(`Invalid timeline JSON at line ${index + 1}`); }
  });
}

export async function appendTimeline(runDir: string, runId: string, input: TimelineEventInput): Promise<TimelineEvent> {
  await ensureDir(runDir);
  const events = await readTimeline(runDir);
  const previous = events.at(-1) ?? null;
  const unsigned = {
    version: 1 as const,
    runId,
    sequence: events.length + 1,
    at: nowIso(),
    previousDigest: previous?.digest ?? null,
    ...input,
    evidenceIds: input.evidenceIds ?? [],
    workItemIds: input.workItemIds ?? [],
    traceIds: input.traceIds ?? []
  };
  const event: TimelineEvent = { ...unsigned, digest: sha256(stableJson(unsigned)) };
  await appendFile(join(runDir, "timeline.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export async function auditTimeline(runDir: string, runId: string): Promise<string[]> {
  const events = await readTimeline(runDir);
  const errors: string[] = [];
  let previousDigest: string | null = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.runId !== runId) errors.push(`timeline event ${index + 1} belongs to ${event.runId}, expected ${runId}`);
    if (event.sequence !== index + 1) errors.push(`timeline event ${index + 1} has sequence ${event.sequence}`);
    if (event.previousDigest !== previousDigest) errors.push(`timeline event ${index + 1} has an invalid previous digest`);
    const { digest, ...unsigned } = event;
    if (sha256(stableJson(unsigned)) !== digest) errors.push(`timeline event ${index + 1} digest is invalid`);
    previousDigest = digest;
  }
  if (!events.length) errors.push("timeline is empty");
  if (events.length && events[0].action !== "run.prepared") errors.push("timeline does not start with run.prepared");
  return errors;
}
