import { join } from "node:path";
import { atomicWrite, exists, readJson } from "../../base/util.ts";
import { astSkeletonIdentity, type AstStructureNode } from "./ast-partition.ts";

/**
 * A content-addressed cache of parsed skeletons, and the reason it exists at all.
 *
 * MEASURED, not assumed. Wiring layer 3 into prepare took wcp from 5.3 s to 13.5 s, and the split is not subtle:
 * of the 6.9 s the builder spends on 1,704 files, reading them costs 159 ms, hashing 9 ms and building their line
 * indexes 28 ms — the other 6.85 s is ast-grep. So the parse is what is cached, and NOTHING ELSE is: every file is
 * still read and still hashed against layer 1's tier2 digest, so `content-drift` stays reachable and the line
 * index still comes from the bytes on disk. A cache that also skipped the read would have quietly retired a
 * degrade bucket, which is worse than being slow.
 *
 * THE KEY IS (extractor identity, content digest, grammar) AND CONTAINS NO mtime. That is the one hard rule here:
 * a `(size, mtime)`-shaped key reproduced P10 one layer down — a same-size rewrite that restores the mtime hit the
 * cache and the "content" digest served the old bytes, measured, on the fixture that the uncached path saw the
 * rewrite in. The digest is layer 1's tier2 hash, so a rewrite always misses. The extractor identity covers both
 * its version and its node-kind table (`astSkeletonIdentity`), because a table edit changes every skeleton it
 * would otherwise serve from before the edit. The grammar is in the key because the same bytes are a different
 * tree as `js` and as `ts`.
 *
 * `open` never fails a build: an unreadable or corrupt cache file is a cold start, because a cache that can break
 * a run is worse than no cache. `flush` writes back only what this run observed, so the file tracks the current
 * corpus instead of growing without bound — the same shape `ContentIdentityCache` uses one layer down.
 */

const CACHE_FILE_VERSION = "partition-skeleton-v1";

interface CacheEntry {
  /** The extractor identity this skeleton was produced by; re-checked per entry, not just per file. */
  readonly extractor: string;
  readonly topLevel: readonly AstStructureNode[];
  readonly byteLength: number;
}

export class PartitionSkeletonCache {
  private readonly path: string | null;
  private readonly loaded: Map<string, CacheEntry>;
  private readonly observed = new Map<string, CacheEntry>();
  private readonly extractor = astSkeletonIdentity();
  private hits = 0;
  private misses = 0;
  private dirty = false;

  private constructor(path: string | null, loaded: Map<string, CacheEntry>) {
    this.path = path;
    this.loaded = loaded;
  }

  /**
   * Open the cache under a directory, or a no-op cache when no directory is given.
   *
   * `cacheDir` is REQUIRED at the call sites that matter, and a `null` here means "deliberately without a cache".
   * The distinction is the slice-1 lesson: a test that forgot to pass a cache directory tested a code path
   * production never takes, and passed.
   */
  static async open(cacheDir: string | null): Promise<PartitionSkeletonCache> {
    if (!cacheDir) return new PartitionSkeletonCache(null, new Map());
    const path = join(cacheDir, "units", `${CACHE_FILE_VERSION}.json`);
    if (!await exists(path)) return new PartitionSkeletonCache(path, new Map());
    try {
      const raw = await readJson<{ version: string; entries: Record<string, CacheEntry> }>(path);
      if (raw.version !== CACHE_FILE_VERSION) return new PartitionSkeletonCache(path, new Map());
      return new PartitionSkeletonCache(path, new Map(Object.entries(raw.entries)));
    } catch {
      return new PartitionSkeletonCache(path, new Map());
    }
  }

  get stats(): { readonly hits: number; readonly misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  /**
   * The cached skeleton for these bytes under this grammar, or `null`.
   *
   * `byteLength` is compared as well as the digest. It is redundant — one content digest has one byte length — and
   * it stays because a mismatch means the entry was written by something that disagreed with this build about
   * what the file's length is, and the partition's completeness arithmetic closes against that number.
   */
  get(contentDigest: string, astLanguage: string, byteLength: number): readonly AstStructureNode[] | null {
    const key = this.key(contentDigest, astLanguage);
    const entry = this.loaded.get(key);
    if (!entry || entry.extractor !== this.extractor || entry.byteLength !== byteLength) {
      this.misses += 1;
      return null;
    }
    this.observed.set(key, entry);
    this.hits += 1;
    return entry.topLevel;
  }

  put(contentDigest: string, astLanguage: string, byteLength: number, topLevel: readonly AstStructureNode[]): void {
    const entry: CacheEntry = { extractor: this.extractor, topLevel, byteLength };
    this.observed.set(this.key(contentDigest, astLanguage), entry);
    this.loaded.set(this.key(contentDigest, astLanguage), entry);
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.path || !this.dirty) return;
    const entries: Record<string, CacheEntry> = {};
    for (const key of [...this.observed.keys()].sort()) entries[key] = this.observed.get(key)!;
    // A failed cache write is not a failed build; the next prepare recomputes.
    try { await atomicWrite(this.path, `${JSON.stringify({ version: CACHE_FILE_VERSION, entries })}\n`); } catch { /* recompute next time */ }
  }

  /** A pipe separates the two components: neither a hex digest nor a grammar name can contain one. */
  private key(contentDigest: string, astLanguage: string): string {
    return `${contentDigest}|${astLanguage}`;
  }
}
