import { appendFile, open, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EvidenceItem } from "../base/types.ts";
import {
  APPEND_STREAM_VERSION, appendJsonArrayValue, nextStreamDigest, readCheckpoint,
  withRunWriter, writeCheckpoint, type StreamCheckpoint
} from "../base/single-writer.ts";
import {
  atomicWrite, canonicalJson, ensureDir, exists, readJson, redactSecrets, REDACTION_VERSION, sha256, stableJson
} from "../base/util.ts";

/** Four independently named ceilings. A field cap cannot substitute for a record, shard or model-view cap. */
export const EVIDENCE_BOUND_POLICY_VERSION = "evidence-bounds-v1";
export const EVIDENCE_SCALAR_MAX_BYTES = 8 * 1024;
export const EVIDENCE_RECORD_MAX_BYTES = 96 * 1024;
export const EVIDENCE_SHARD_MAX_BYTES = 256 * 1024;
export const EVIDENCE_MODEL_VIEW_MAX_BYTES = 64 * 1024;

const EVIDENCE_STREAM = "evidence";
const CONTENT_ROOT = "content/sha256";
const ARRAY_PREFIX = '{"evidence":[';
const ARRAY_SUFFIX = "]}\n";
const RETAINED_RECORD_BUDGET = EVIDENCE_RECORD_MAX_BYTES - 2 * 1024;

export interface EvidenceBoundsMetadata {
  contentRef: string;
  contentDigest: string;
  originalBytes: number;
  retainedBytes: number;
  truncatedReason: string;
  boundPolicyVersion: typeof EVIDENCE_BOUND_POLICY_VERSION;
  redactionVersion: string;
}

export interface EvidenceCatalog {
  evidence: EvidenceItem[];
}

export interface AppendEvidenceResult {
  item: EvidenceItem;
  appended: boolean;
  checkpoint: StreamCheckpoint;
}

/**
 * Every evidence producer, including graph/fact/ledger producers created during prepare, enters through here.
 * The order is load-bearing: redact the whole record first, persist those exact pre-truncation bytes second,
 * then clip. An archived redacted run can therefore never recover a secret by following `contentRef`.
 */
export async function boundEvidenceItem(
  runDir: string,
  input: EvidenceItem,
  redact: boolean
): Promise<EvidenceItem> {
  const underMode = {
    ...withRetainedDigest(redactValue(input, redact) as EvidenceItem),
    boundPolicyVersion: EVIDENCE_BOUND_POLICY_VERSION,
    redactionVersion: `${REDACTION_VERSION}${redact ? "-redacted" : "-plain"}`
  };
  const original = Buffer.from(canonicalJson(underMode));
  let retained = boundScalars(underMode) as EvidenceItem;
  const reasons: string[] = stableJson(retained) === stableJson(underMode) ? [] : ["scalar-field-byte-limit"];

  if (Buffer.byteLength(canonicalJson(retained)) > EVIDENCE_RECORD_MAX_BYTES) {
    retained = fitRecord(retained);
    reasons.push("record-byte-limit");
  }
  if (!reasons.length) return retained;

  retained = withRetainedDigest(markStorageTruncation(retained, underMode, reasons));
  const retainedBytes = Buffer.byteLength(canonicalJson(retained));
  if (retainedBytes > EVIDENCE_RECORD_MAX_BYTES) {
    throw new Error(`Evidence ${input.id} could not be reduced below the ${EVIDENCE_RECORD_MAX_BYTES}-byte record bound`);
  }
  const contentDigest = sha256(original);
  const contentRef = await persistContent(runDir, contentDigest, original, redact);
  const bounded: EvidenceItem = {
    ...retained,
    contentRef,
    contentDigest,
    originalBytes: original.length,
    retainedBytes,
    truncatedReason: [...new Set(reasons)].join("+"),
    boundPolicyVersion: EVIDENCE_BOUND_POLICY_VERSION,
    redactionVersion: `${REDACTION_VERSION}${redact ? "-redacted" : "-plain"}`
  };
  if (Buffer.byteLength(canonicalJson(bounded)) > EVIDENCE_RECORD_MAX_BYTES) {
    throw new Error(`Evidence ${input.id} truncation metadata exceeded the record byte bound`);
  }
  return bounded;
}

/** Initialize the logical catalog, its bounded shards, id index and constant-sized tail checkpoint. */
export async function writeEvidenceCatalog(
  runDir: string,
  items: readonly EvidenceItem[],
  redact: boolean
): Promise<{ evidence: EvidenceItem[]; checkpoint: StreamCheckpoint }> {
  const bounded: EvidenceItem[] = [];
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`Duplicate evidence id during catalog initialization: ${item.id}`);
    ids.add(item.id);
    bounded.push(await boundEvidenceItem(runDir, item, redact));
  }
  return withRunWriter(runDir, async () => {
    const path = join(runDir, "evidence.json");
    const body = bounded.map((item) => JSON.stringify(item)).join(",");
    await atomicWrite(path, `${ARRAY_PREFIX}${body}${ARRAY_SUFFIX}`);
    let tailDigest = "";
    for (let index = 0; index < bounded.length; index += 1) {
      tailDigest = nextStreamDigest(tailDigest, index + 1, bounded[index]);
    }
    const shard = await writeInitialShards(runDir, bounded);
    const checkpoint: StreamCheckpoint = {
      version: APPEND_STREAM_VERSION,
      stream: EVIDENCE_STREAM,
      sequence: bounded.length,
      tailDigest,
      byteOffset: Buffer.byteLength(ARRAY_PREFIX) + Buffer.byteLength(body),
      ...shard
    };
    await writeCheckpoint(runDir, checkpoint);
    for (const item of bounded) await writeEvidenceIdMarker(runDir, item);
    return { evidence: bounded, checkpoint };
  });
}

/** Append one bounded record in O(record bytes); no historical catalog or shard bytes are read. */
export async function appendEvidence(
  runDir: string,
  input: EvidenceItem,
  redact: boolean
): Promise<AppendEvidenceResult> {
  const item = await boundEvidenceItem(runDir, input, redact);
  return withRunWriter(runDir, async () => {
    const marker = evidenceIdMarker(runDir, item.id);
    const checkpoint = await requireEvidenceCheckpoint(runDir);
    if (await exists(marker)) {
      const expected = `${item.id}\t${sha256(canonicalJson(item))}`;
      const recorded = (await readFile(marker, "utf8")).trim();
      if (recorded !== expected) throw new Error(`Evidence id ${item.id} was already committed with different content`);
      return { item, appended: false, checkpoint };
    }
    const catalogCheckpoint = await appendJsonArrayValue(join(runDir, "evidence.json"), checkpoint, item);
    const next = await appendShard(runDir, catalogCheckpoint, item);
    await writeCheckpoint(runDir, next);
    await writeEvidenceIdMarker(runDir, item);
    return { item, appended: true, checkpoint: next };
  });
}

export async function readEvidenceCatalog(runDir: string): Promise<EvidenceCatalog> {
  return readJson<EvidenceCatalog>(join(runDir, "evidence.json"));
}

/** The canonical seal is order-independent and paid once by freeze/audit, never on append. */
export function canonicalEvidenceDigest(evidence: readonly EvidenceItem[]): string {
  return sha256(canonicalJson([...evidence].sort((a, b) => a.id.localeCompare(b.id))));
}

/** Recompute the append chain during a seal/audit. This is the intended one-time O(N) read. */
export function evidenceStreamDigest(evidence: readonly EvidenceItem[]): string {
  let tail = "";
  for (let index = 0; index < evidence.length; index += 1) {
    tail = nextStreamDigest(tail, index + 1, evidence[index]);
  }
  return tail;
}

/**
 * Verify the logical catalog, physical shards, checkpoint and immutable content objects agree. This catches a
 * direct writer that bypassed the commit door; append itself never performs this historical scan.
 */
export async function auditEvidenceStorage(runDir: string, evidence: readonly EvidenceItem[], redact?: boolean): Promise<string[]> {
  const errors: string[] = [];
  const checkpoint = await readCheckpoint(runDir, EVIDENCE_STREAM);
  if (!checkpoint) return ["evidence catalog has no append checkpoint"];
  if (checkpoint.sequence !== evidence.length) errors.push(`evidence checkpoint sequence ${checkpoint.sequence} does not match ${evidence.length} record(s)`);
  if (checkpoint.tailDigest !== evidenceStreamDigest(evidence)) errors.push("evidence checkpoint has an invalid tail digest");
  const bytes = await stat(join(runDir, "evidence.json")).then((value) => value.size).catch(() => 0);
  if (checkpoint.byteOffset + Buffer.byteLength(ARRAY_SUFFIX) !== bytes) errors.push("evidence checkpoint has an invalid byte offset");

  const sharded = await readShardRecords(runDir, errors);
  if (stableJson(sharded) !== stableJson(evidence)) errors.push("evidence shards do not reproduce the logical catalog");
  for (const item of evidence) {
    const bounded = item as EvidenceItem & Partial<EvidenceBoundsMetadata>;
    const expectedRedaction = `${REDACTION_VERSION}${redact === undefined
      ? bounded.redactionVersion?.endsWith("-plain") ? "-plain" : "-redacted"
      : redact ? "-redacted" : "-plain"}`;
    if (bounded.boundPolicyVersion !== EVIDENCE_BOUND_POLICY_VERSION) errors.push(`evidence ${item.id} has no current byte-bound policy identity`);
    if (bounded.redactionVersion !== expectedRedaction) errors.push(`evidence ${item.id} has no current redaction identity`);
    if (!bounded.contentRef) continue;
    if (!bounded.contentDigest || bounded.originalBytes === undefined || bounded.retainedBytes === undefined || !bounded.truncatedReason
      || bounded.boundPolicyVersion !== EVIDENCE_BOUND_POLICY_VERSION || typeof bounded.redactionVersion !== "string") {
      errors.push(`evidence ${item.id} has an incomplete truncation record`);
      continue;
    }
    const mode = `${EVIDENCE_BOUND_POLICY_VERSION}-${REDACTION_VERSION}-${expectedRedaction.endsWith("-redacted") ? "redacted" : "plain"}`;
    if (!bounded.contentRef.startsWith(`${CONTENT_ROOT}/${mode}/`)) errors.push(`evidence ${item.id} contentRef has the wrong policy or redaction identity`);
    try {
      const content = await readContentRef(runDir, bounded.contentRef);
      if (content.length !== bounded.originalBytes) errors.push(`evidence ${item.id} contentRef has the wrong byte length`);
      if (sha256(content) !== bounded.contentDigest) errors.push(`evidence ${item.id} contentRef has the wrong digest`);
    } catch {
      errors.push(`evidence ${item.id} contentRef cannot be resolved inside the run`);
    }
  }
  return errors;
}

/** Bound a deterministic model view by bytes, with an explicit omission marker. */
export function boundEvidenceModelView(markdown: string): string {
  if (Buffer.byteLength(markdown) <= EVIDENCE_MODEL_VIEW_MAX_BYTES) return markdown;
  const suffix = `\n\n… evidence model-view byte bound reached (${EVIDENCE_MODEL_VIEW_MAX_BYTES}); omitted rows remain in the frozen catalog.\n`;
  return `${utf8Prefix(markdown, EVIDENCE_MODEL_VIEW_MAX_BYTES - Buffer.byteLength(suffix))}${suffix}`;
}

export async function readContentRef(runDir: string, ref: string): Promise<Buffer> {
  if (!ref.startsWith(`${CONTENT_ROOT}/`) || ref.includes("..")) throw new Error(`Invalid contentRef: ${ref}`);
  return readFile(join(runDir, ref));
}

function withRetainedDigest(item: EvidenceItem): EvidenceItem {
  if (item.content !== undefined) return { ...item, digest: sha256(item.content) };
  if (item.data !== undefined) return { ...item, digest: sha256(stableJson(item.data)) };
  return item;
}

function fitRecord(item: EvidenceItem): EvidenceItem {
  let candidate = item;
  for (const cap of [128, 64, 32, 16, 8, 4, 2, 1, 0]) {
    candidate = pruneArrays(item, cap) as EvidenceItem;
    if (Buffer.byteLength(canonicalJson(candidate)) <= RETAINED_RECORD_BUDGET) return candidate;
  }
  const payload = item.data !== undefined ? canonicalJson(item.data) : item.content ?? "";
  const preview = utf8Prefix(payload, Math.floor(RETAINED_RECORD_BUDGET / 4));
  const fallback: EvidenceItem = item.data !== undefined
    ? { ...item, data: { boundedPreview: preview } }
    : { ...item, content: preview };
  return fallback;
}

function boundScalars(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (["id", "snapshotId", "kind", "digest", "contentRef", "contentDigest"].includes(key)) return value;
    return Buffer.byteLength(value) > EVIDENCE_SCALAR_MAX_BYTES ? utf8Prefix(value, EVIDENCE_SCALAR_MAX_BYTES) : value;
  }
  if (Array.isArray(value)) return value.map((entry) => boundScalars(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, boundScalars(child, childKey)]));
  }
  return value;
}

function pruneArrays(value: unknown, cap: number): unknown {
  if (Array.isArray(value)) return value.slice(0, cap).map((entry) => pruneArrays(entry, cap));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, pruneArrays(child, cap)]));
  }
  return value;
}

function redactValue(value: unknown, redact: boolean, key = ""): unknown {
  if (typeof value === "string") {
    if (!redact) return value;
    const direct = redactSecrets(value);
    if (!key || direct !== value) return direct;
    const keyed = redactSecrets(`${key}=${value}`);
    return keyed === `${key}=${value}` ? value : keyed.slice(keyed.indexOf("=") + 1);
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, redact, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redactValue(child, redact, childKey)]));
  }
  return value;
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

async function persistContent(runDir: string, digest: string, bytes: Buffer, redact: boolean): Promise<string> {
  const mode = `${EVIDENCE_BOUND_POLICY_VERSION}-${REDACTION_VERSION}-${redact ? "redacted" : "plain"}`;
  const relative = `${CONTENT_ROOT}/${mode}/${digest.slice(0, 2)}/${digest}`;
  const path = join(runDir, relative);
  await ensureDir(dirname(path));
  try {
    const handle = await open(path, "wx");
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(path);
    if (sha256(existing) !== digest) throw new Error(`Immutable content object ${digest} does not match its address`);
  }
  return relative;
}

function markStorageTruncation(retained: EvidenceItem, original: EvidenceItem, reasons: readonly string[]): EvidenceItem {
  if (retained.data === undefined || !retained.data || typeof retained.data !== "object" || Array.isArray(retained.data)) return retained;
  const data = retained.data as Record<string, unknown>;
  const originalData = original.data && typeof original.data === "object" && !Array.isArray(original.data)
    ? original.data as Record<string, unknown>
    : {};
  const storageCompleteness = {
    truncated: true,
    reason: [...new Set(reasons)].join("+"),
    originalBytes: Buffer.byteLength(canonicalJson(original))
  };
  if (retained.kind === "search") {
    const originalMatches = Array.isArray(originalData.matches) ? originalData.matches.length : 0;
    return {
      ...retained,
      data: {
        ...data,
        truncated: true,
        atLeast: Math.max(Number(data.atLeast ?? 0), originalMatches),
        storageCompleteness
      }
    };
  }
  return { ...retained, data: { ...data, storageCompleteness } };
}

function evidenceIdMarker(runDir: string, id: string): string {
  return join(runDir, ".writer", "evidence-ids", sha256(id));
}

async function writeEvidenceIdMarker(runDir: string, item: EvidenceItem): Promise<void> {
  await atomicWrite(evidenceIdMarker(runDir, item.id), `${item.id}\t${sha256(canonicalJson(item))}\n`);
}

async function requireEvidenceCheckpoint(runDir: string): Promise<StreamCheckpoint> {
  const checkpoint = await readCheckpoint(runDir, EVIDENCE_STREAM);
  if (!checkpoint) throw new Error("Evidence catalog has no append checkpoint; prepare a new run under the current schema");
  return checkpoint;
}

async function writeInitialShards(runDir: string, items: readonly EvidenceItem[]): Promise<Pick<StreamCheckpoint, "shard" | "shardBytes" | "shardRecords">> {
  let shard = 1;
  let bytes = 0;
  let records = 0;
  let lines: string[] = [];
  const flush = async (): Promise<void> => {
    if (!lines.length) return;
    await atomicWrite(shardPath(runDir, shard), `${lines.join("\n")}\n`);
  };
  for (const item of items) {
    const line = JSON.stringify(item);
    const lineBytes = Buffer.byteLength(line) + 1;
    if (lineBytes > EVIDENCE_SHARD_MAX_BYTES) throw new Error(`Evidence ${item.id} exceeds the shard byte bound`);
    if (records > 0 && bytes + lineBytes > EVIDENCE_SHARD_MAX_BYTES) {
      await flush();
      shard += 1;
      bytes = 0;
      records = 0;
      lines = [];
    }
    lines.push(line);
    bytes += lineBytes;
    records += 1;
  }
  await flush();
  if (!items.length) shard = 0;
  return { shard, shardBytes: bytes, shardRecords: records };
}

async function appendShard(runDir: string, checkpoint: StreamCheckpoint, item: EvidenceItem): Promise<StreamCheckpoint> {
  const line = `${JSON.stringify(item)}\n`;
  const lineBytes = Buffer.byteLength(line);
  if (lineBytes > EVIDENCE_SHARD_MAX_BYTES) throw new Error(`Evidence ${item.id} exceeds the shard byte bound`);
  let shard = checkpoint.shard ?? 0;
  let shardBytes = checkpoint.shardBytes ?? 0;
  let shardRecords = checkpoint.shardRecords ?? 0;
  if (shard === 0 || (shardRecords > 0 && shardBytes + lineBytes > EVIDENCE_SHARD_MAX_BYTES)) {
    shard += 1;
    shardBytes = 0;
    shardRecords = 0;
  }
  await ensureDir(dirname(shardPath(runDir, shard)));
  await appendFile(shardPath(runDir, shard), line, "utf8");
  return { ...checkpoint, shard, shardBytes: shardBytes + lineBytes, shardRecords: shardRecords + 1 };
}

function shardPath(runDir: string, shard: number): string {
  return join(runDir, "evidence", "shards", `${String(shard).padStart(6, "0")}.jsonl`);
}

async function readShardRecords(runDir: string, errors: string[]): Promise<EvidenceItem[]> {
  const dir = join(runDir, "evidence", "shards");
  const names = await readdir(dir).catch(() => [] as string[]);
  const records: EvidenceItem[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".jsonl")).sort()) {
    const path = join(dir, name);
    const size = await stat(path).then((value) => value.size).catch(() => 0);
    if (size > EVIDENCE_SHARD_MAX_BYTES) errors.push(`evidence shard ${name} exceeds ${EVIDENCE_SHARD_MAX_BYTES} bytes`);
    const text = await readFile(path, "utf8").catch(() => "");
    for (const [index, line] of text.split(/\r?\n/).filter(Boolean).entries()) {
      try { records.push(JSON.parse(line) as EvidenceItem); }
      catch { errors.push(`evidence shard ${name} has invalid JSON at line ${index + 1}`); }
    }
  }
  return records;
}
