import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { exists, sha256 } from "../core/util.ts";

/**
 * The identity of the CodeGraph databases a run navigated with.
 *
 * This formula used to live inside `createSnapshot` and its result inside the SOURCE snapshot's identity. That
 * put an OPTIONAL navigation index into the identity of the source boundary: building `.codegraph`, or merely
 * rebuilding it, moved the snapshot id and invalidated every context cache, search receipt and source window
 * for a target whose source had not changed by one byte. Worse, layer 1 is defined by taking no input from any
 * index — so the index cannot be a component of its output identity.
 *
 * The formula itself is carried over UNCHANGED, both branches, so an archived run's recorded digest still
 * re-derives and no migration is needed: `manifest.codegraphDigest ?? manifest.snapshot.codegraphDigest`
 * compares against exactly the same bytes it did before.
 *
 * It is a (path, size, mtime) shape rather than a content hash. That is deliberate for now: this is a
 * multi-gigabyte derived index, its own build is content-addressed, and a drift check against it is advisory
 * about a navigation aid. The SOURCE identity is the one that had to become content-anchored.
 */
export async function codegraphIdentity(codegraphPath?: string | string[]): Promise<string | null> {
  const codegraphPaths = codegraphPath == null ? [] : Array.isArray(codegraphPath) ? codegraphPath : [codegraphPath];
  if (codegraphPaths.length === 1) {
    // A single database keeps its original identity formula so single-module snapshots are unchanged.
    const [path] = codegraphPaths;
    if (await exists(path)) {
      const info = await stat(path);
      return sha256(`${resolve(path)}:${info.size}:${Math.trunc(info.mtimeMs)}`);
    }
    return null;
  }
  if (codegraphPaths.length > 1) {
    const parts: string[] = [];
    for (const path of [...codegraphPaths].sort()) {
      if (!await exists(path)) continue;
      const info = await stat(path);
      parts.push(`${resolve(path)}:${info.size}:${Math.trunc(info.mtimeMs)}`);
    }
    if (parts.length) return sha256(parts.join("\n"));
  }
  return null;
}
