import { appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TimelineEvent, TimelineEventInput } from "../base/types.ts";
import { ensureDir, exists, nowIso, sha256, stableJson } from "../base/util.ts";
import {
  APPEND_STREAM_VERSION, readCheckpoint, withRunWriter, writeCheckpoint,
  type StreamCheckpoint
} from "./single-writer.ts";

const TIMELINE_STREAM = "timeline";

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
  return withRunWriter(runDir, async () => {
    const checkpoint = await timelineCheckpoint(runDir);
    const unsigned = {
      version: 1 as const,
      runId,
      sequence: checkpoint.sequence + 1,
      at: nowIso(),
      previousDigest: checkpoint.sequence > 0 ? checkpoint.tailDigest : null,
      ...input,
      evidenceIds: input.evidenceIds ?? [],
      workItemIds: input.workItemIds ?? [],
      traceIds: input.traceIds ?? []
    };
    const event: TimelineEvent = { ...unsigned, digest: sha256(stableJson(unsigned)) };
    const line = `${JSON.stringify(event)}\n`;
    await appendFile(join(runDir, "timeline.jsonl"), line, "utf8");
    await writeCheckpoint(runDir, {
      ...checkpoint,
      sequence: event.sequence,
      tailDigest: event.digest,
      byteOffset: checkpoint.byteOffset + Buffer.byteLength(line)
    });
    return event;
  });
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
  const checkpoint = await readCheckpoint(runDir, TIMELINE_STREAM);
  if (!checkpoint) errors.push("timeline has no append checkpoint");
  else {
    const bytes = await stat(join(runDir, "timeline.jsonl")).then((value) => value.size).catch(() => 0);
    if (checkpoint.sequence !== events.length) errors.push(`timeline checkpoint sequence ${checkpoint.sequence} does not match ${events.length} event(s)`);
    if (checkpoint.tailDigest !== (events.at(-1)?.digest ?? "")) errors.push("timeline checkpoint has an invalid tail digest");
    if (checkpoint.byteOffset !== bytes) errors.push("timeline checkpoint has an invalid byte offset");
  }
  return errors;
}

/** Cold recovery is O(N), but only for a pre-checkpoint or interrupted run. The normal append path is O(1). */
async function timelineCheckpoint(runDir: string): Promise<StreamCheckpoint> {
  const checkpoint = await readCheckpoint(runDir, TIMELINE_STREAM);
  if (checkpoint) return checkpoint;
  const events = await readTimeline(runDir);
  const bytes = await stat(join(runDir, "timeline.jsonl")).then((value) => value.size).catch(() => 0);
  const recovered: StreamCheckpoint = {
    version: APPEND_STREAM_VERSION,
    stream: TIMELINE_STREAM,
    sequence: events.length,
    tailDigest: events.at(-1)?.digest ?? "",
    byteOffset: bytes
  };
  await writeCheckpoint(runDir, recovered);
  return recovered;
}
