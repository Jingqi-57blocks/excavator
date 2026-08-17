import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, exists, readJson, sha256 } from "../base/util.ts";

/**
 * The two identity tiers of one file's bytes, and the persistent cache that makes computing them affordable.
 *
 * tier1 is a SHAPE: size, mtime and the signals read off the first 8 KiB — whether the bytes read as text, and
 * the longest line in the sample. The line length is the compression/minification signal: the 439,321-character
 * evidence excerpt that blew up an `evidence.json` came from a minified `tiny_mce.js`, and a sample with no
 * newline in 8 KiB is exactly what that looks like from the boundary.
 *
 * tier2 is the CONTENT: sha256 of the whole file. It is what the snapshot identity anchors on, because the old
 * (path, size, mtime) identity could not see a same-size rewrite — so a content-addressed cache downstream
 * served stale bytes with a self-consistent digest and nothing could detect it.
 *
 * `createSnapshot` runs on every search, freeze and audit, so tier2 over the whole counted set has to be
 * cheap on the second call. The cache is keyed by (path, size, mtimeMs, ctimeMs) and the cold/warm equivalence
 * is pinned by test, so the cache can never become a source of different bytes.
 *
 * `ctimeMs` IS LOAD-BEARING AND MUST NOT BE DROPPED. Keyed on (size, mtimeMs) alone, the cache reproduced the
 * exact P10 defect one layer down: a same-size rewrite that restores the mtime hit the cache, so the "content"
 * digest served the OLD bytes and the snapshot id came out byte-identical across the rewrite — measured, on the
 * same fixture that the uncached path saw the rewrite in. `ctimeMs` is the inode's own change time: `utimes`
 * cannot forge it, so a rewrite always misses. Every configuration the production path uses passes a
 * `cacheDir`, so a key that can be fooled here is a key that is fooled in production; the rewrite acceptance is
 * pinned in BOTH configurations for that reason. A false MISS only costs one recompute, which is why this key
 * errs toward missing.
 */

export type RowShape = "textual" | "binary" | "empty";

/** How many leading bytes the tier1 shape is read from. Fixed: it is part of what the shape MEANS. */
export const SAMPLE_BYTES = 8192;

// v2 adds `ctimeMs` to the key. A v1 file is dropped wholesale rather than read with the field absent: an
// entry with no `ctimeMs` would compare `undefined === number` and miss anyway, and keeping it would leave a
// half-keyed cache on disk that nothing distinguishes from a fully keyed one.
const CACHE_VERSION = "content-identity-v2";

export interface ContentIdentity {
  shape: RowShape;
  sampledBytes: number;
  maxLineLength: number;
  /** The tier2 digest, or null when only the shape was requested (an excluded row records no content). */
  digest: string | null;
}

/** The stat fields the cache key is made of. Passed as one value so no call site can supply two of three. */
export interface ContentStat {
  size: number;
  mtimeMs: number;
  /** The inode change time. See the module comment: without it the cache cannot see a same-size rewrite. */
  ctimeMs: number;
}

interface CacheEntry extends ContentIdentity, ContentStat {}

/**
 * Shape signals from a byte sample. NUL-byte detection is the primary test (the same one git uses) rather
 * than a printable-character ratio: UTF-8 continuation bytes are all >= 0x80, so a ratio test reads Chinese
 * source as binary. Control characters are counted separately and only in the ASCII range for that reason.
 */
export function classifySample(sample: Buffer, size: number): { shape: RowShape; maxLineLength: number } {
  if (size === 0) return { shape: "empty", maxLineLength: 0 };
  let control = 0;
  let nul = false;
  let longest = 0;
  let current = 0;
  for (const byte of sample) {
    if (byte === 0x00) nul = true;
    else if (byte < 0x09 || byte === 0x0b || byte === 0x0c || (byte >= 0x0e && byte < 0x20)) control += 1;
    if (byte === 0x0a) { longest = Math.max(longest, current); current = 0; }
    else current += 1;
  }
  longest = Math.max(longest, current);
  const binary = nul || (sample.length > 0 && control / sample.length > 0.02);
  return { shape: binary ? "binary" : "textual", maxLineLength: longest };
}

/** Read the leading sample of a file without reading the rest of it. */
async function readSample(absolutePath: string): Promise<Buffer> {
  const handle = await open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SAMPLE_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * The content cache. `open` never fails a scan: an unreadable or corrupt cache file is a cold start, because a
 * cache that can break a run is worse than no cache. `flush` writes back only what this scan observed, so the
 * file tracks the current candidate set instead of growing without bound.
 */
export class ContentIdentityCache {
  private readonly path: string | null;
  private readonly loaded = new Map<string, CacheEntry>();
  private readonly observed = new Map<string, CacheEntry>();
  private dirty = false;

  private constructor(path: string | null, loaded: Map<string, CacheEntry>) {
    this.path = path;
    this.loaded = loaded;
  }

  static async open(cacheDir?: string): Promise<ContentIdentityCache> {
    if (!cacheDir) return new ContentIdentityCache(null, new Map());
    const path = join(cacheDir, "ledger", `${CACHE_VERSION}.json`);
    if (!await exists(path)) return new ContentIdentityCache(path, new Map());
    try {
      const raw = await readJson<{ version: string; entries: Record<string, CacheEntry> }>(path);
      if (raw.version !== CACHE_VERSION) return new ContentIdentityCache(path, new Map());
      return new ContentIdentityCache(path, new Map(Object.entries(raw.entries)));
    } catch {
      return new ContentIdentityCache(path, new Map());
    }
  }

  /**
   * The identity of one file, from cache when the (size, mtime, ctime) key still matches. A cached shape-only
   * entry does not satisfy a request that needs the content digest.
   */
  async resolve(absolutePath: string, stat: ContentStat, wantDigest: boolean): Promise<ContentIdentity> {
    const cached = this.loaded.get(absolutePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs && (!wantDigest || cached.digest !== null)) {
      this.observed.set(absolutePath, cached);
      return { shape: cached.shape, sampledBytes: cached.sampledBytes, maxLineLength: cached.maxLineLength, digest: cached.digest };
    }
    const identity = await compute(absolutePath, stat.size, wantDigest);
    const entry: CacheEntry = { ...identity, ...stat };
    this.observed.set(absolutePath, entry);
    // Also visible to this run's later lookups, so asking twice about one file reads it once.
    this.loaded.set(absolutePath, entry);
    this.dirty = true;
    return identity;
  }

  async flush(): Promise<void> {
    if (!this.path || !this.dirty) return;
    const entries: Record<string, CacheEntry> = {};
    for (const key of [...this.observed.keys()].sort()) entries[key] = this.observed.get(key)!;
    // A failed cache write is not a failed scan.
    try { await atomicWrite(this.path, `${JSON.stringify({ version: CACHE_VERSION, entries })}\n`); } catch { /* the next scan recomputes */ }
  }
}

async function compute(absolutePath: string, size: number, wantDigest: boolean): Promise<ContentIdentity> {
  if (wantDigest) {
    // The digest needs every byte anyway, so the sample is taken from the same read.
    const bytes = await readFile(absolutePath);
    const { shape, maxLineLength } = classifySample(bytes.subarray(0, SAMPLE_BYTES), size);
    return { shape, sampledBytes: Math.min(bytes.length, SAMPLE_BYTES), maxLineLength, digest: sha256(bytes) };
  }
  const sample = await readSample(absolutePath);
  const { shape, maxLineLength } = classifySample(sample, size);
  return { shape, sampledBytes: sample.length, maxLineLength, digest: null };
}
