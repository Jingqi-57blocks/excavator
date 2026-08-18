import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, ensureDir, exists, sha256, canonicalJson } from "./util.ts";

/**
 * The one commit door for every append-until-freeze stream in a run.
 *
 * `mkdir` is atomic across processes. The lock therefore covers CLI processes as well as promises inside one
 * process; sequence numbers are allocated only after it is held, never reserved by a producer. A checkpoint is
 * deliberately constant-sized: appending the Nth record must not read or rewrite the first N-1 records.
 */

export const APPEND_STREAM_VERSION = "append-stream-v1";

export interface StreamCheckpoint {
  version: typeof APPEND_STREAM_VERSION;
  stream: string;
  sequence: number;
  tailDigest: string;
  byteOffset: number;
  shard?: number;
  shardBytes?: number;
  shardRecords?: number;
}
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 10_000;

export async function withRunWriter<T>(runDir: string, commit: () => Promise<T>): Promise<T> {
  const writerDir = join(runDir, ".writer");
  const lockDir = join(writerDir, "lock");
  await ensureDir(writerDir);
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() - started >= LOCK_TIMEOUT_MS) {
        throw new Error(`Run append writer remained busy for ${LOCK_TIMEOUT_MS}ms: ${runDir}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  try {
    return await commit();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

export function checkpointPath(runDir: string, stream: string): string {
  return join(runDir, ".writer", `${stream}.checkpoint.json`);
}

export async function readCheckpoint(runDir: string, stream: string): Promise<StreamCheckpoint | null> {
  const path = checkpointPath(runDir, stream);
  if (!await exists(path)) return null;
  const checkpoint = JSON.parse(await readFile(path, "utf8")) as StreamCheckpoint;
  if (checkpoint.version !== APPEND_STREAM_VERSION || checkpoint.stream !== stream
    || !Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 0
    || !Number.isSafeInteger(checkpoint.byteOffset) || checkpoint.byteOffset < 0
    || typeof checkpoint.tailDigest !== "string") {
    throw new Error(`Invalid ${stream} append checkpoint`);
  }
  return checkpoint;
}

export async function writeCheckpoint(runDir: string, checkpoint: StreamCheckpoint): Promise<void> {
  await atomicWrite(checkpointPath(runDir, checkpoint.stream), `${canonicalJson(checkpoint)}\n`);
}

/** Digest one logical record into a stream chain. The wall-clock, when a record has one, is inside `value`. */
export function nextStreamDigest(previousDigest: string, sequence: number, value: unknown): string {
  return sha256(canonicalJson({ previousDigest, sequence, value }));
}

/**
 * Append one value to an on-disk JSON array without rereading or rewriting its prefix. The checkpoint's
 * `byteOffset` points immediately before the closing `]}` bytes; the file remains valid JSON after every commit.
 */
export async function appendJsonArrayValue(
  path: string,
  checkpoint: StreamCheckpoint,
  value: unknown
): Promise<StreamCheckpoint> {
  const encoded = JSON.stringify(value);
  const insertion = `${checkpoint.sequence > 0 ? "," : ""}${encoded}`;
  const suffix = "]}\n";
  const handle = await open(path, "r+");
  try {
    const bytes = Buffer.from(`${insertion}${suffix}`);
    await handle.write(bytes, 0, bytes.length, checkpoint.byteOffset);
    const byteOffset = checkpoint.byteOffset + Buffer.byteLength(insertion);
    await handle.truncate(byteOffset + Buffer.byteLength(suffix));
    const sequence = checkpoint.sequence + 1;
    return {
      ...checkpoint,
      sequence,
      byteOffset,
      tailDigest: nextStreamDigest(checkpoint.tailDigest, sequence, value)
    };
  } finally {
    await handle.close();
  }
}
