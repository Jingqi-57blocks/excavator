import { execFile } from "node:child_process";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { sha256, stableJson } from "../../src/base/util.ts";
import { buildCodeGraph } from "../../src/codegraph/codegraph-command.ts";

const run = promisify(execFile);

/**
 * One repository root of a frozen corpus.
 *
 * `sha` is a commit, not a branch: the point of this file is that the bytes under test do not move. Every real
 * target here is a working tree someone edits — all five wcp roots were dirty when this baseline was measured —
 * so "run against the target" means "run against whatever that person had open", and a baseline built on it
 * measures the day, not the engine.
 */
export interface CorpusRoot {
  readonly relPath: string;
  readonly sha: string;
}

/**
 * How a corpus is frozen.
 *
 * `git` is the strong form: commits name the bytes, so an operator's uncommitted edits cannot leak in. But not
 * every real target is version-controlled — provital, the second target this baseline is required to cover, has
 * no `.git` anywhere — and refusing to pin such a target would mean dropping the only arm that exercises
 * `channel-unavailable`. `copy` freezes what is there today and leans entirely on the digest seal, which is what
 * actually catches drift in BOTH forms: the git checkout proves what was written, the seal proves what layer 1
 * counted, and only the second one is what the assertions rest on.
 */
export type CorpusKind = "git" | "copy";

export interface CorpusPin {
  readonly kind: CorpusKind;
  /** Env var naming a local clone or working copy to materialize from. */
  readonly sourceEnv: string;
  /** Required for `git`, ignored for `copy` (there are no commits to name). */
  readonly roots: readonly CorpusRoot[];
  /** Layer 1's tier2 digest over the materialized corpus. Verified after the run, never trusted before it. */
  readonly filesContentManifestDigest: string;
  /** `copy` only: directory names to omit, so a stale index or scratch output cannot enter the frozen bytes. */
  readonly excludeDirs?: readonly string[];
}

/**
 * Materialize the pinned bytes into `destDir`, one detached checkout per root.
 *
 * Deliberately NOT a copy of the source working tree: uncommitted edits are what makes a live target
 * unreproducible, so they are excluded by construction rather than by asking the operator to stash.
 *
 * Every failure is fatal and names what it could not satisfy. A corpus harness that degrades — skips a root,
 * falls back to the working tree, carries on with four of five — produces a green run over the wrong bytes,
 * which is worse than no baseline at all: it reports a passing comparison against a corpus nobody chose.
 */
export async function materializeCorpus(pin: CorpusPin, destDir: string, buildIndex: boolean): Promise<string> {
  const source = process.env[pin.sourceEnv];
  if (!source) throw new Error(`${pin.sourceEnv} is not set; it must name a local clone holding the pinned commits`);

  // Reuse an already-materialized corpus for the same pin. Not an optimisation for its own sake: the navigation
  // index is built below and costs minutes, so without reuse the baseline would be too slow to run and would
  // stop being run. Keyed by the pin's own content, so a re-pin cannot silently reuse the old bytes.
  const marker = join(destDir, ".corpus-pin");
  const expectedKey = sha256(stableJson(pin));
  if (await readMarker(marker) === expectedKey) return destDir;

  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });

  if (pin.kind === "copy") {
    await cp(source, destDir, {
      recursive: true,
      filter: (entry) => !(pin.excludeDirs ?? []).some((name) => entry.split("/").includes(name))
    });
  } else for (const root of pin.roots) {
    const from = join(source, root.relPath);
    const to = join(destDir, root.relPath);
    try {
      await run("git", ["clone", "--quiet", "--no-checkout", "--local", from, to]);
    } catch (error) {
      throw new Error(`could not clone root ${root.relPath} from ${from}: ${(error as Error).message}`);
    }
    try {
      await run("git", ["-C", to, "checkout", "--quiet", "--detach", root.sha]);
    } catch {
      // Named precisely because the usual cause is recoverable by the reader: the commit was garbage-collected,
      // or the local clone predates it. Re-pinning is a deliberate fixture edit, never an automatic fallback.
      throw new Error(`root ${root.relPath} has no commit ${root.sha} in ${from}; re-pin the fixture deliberately rather than letting the baseline drift to whatever HEAD happens to be`);
    }
  }

  // The index is DERIVED from the pinned bytes, so it belongs to the frozen corpus rather than to the machine.
  // Cloning committed bytes never brings one along (`.codegraph/` is git-ignored), and a corpus without it runs
  // `channel-unavailable{no-graph}`: zero seats, zero anchors, and a baseline that pins nothing at all.
  // Through the repository's own builder, not the raw binary: `buildCodeGraph` is what `excavator codegraph
  // build` runs, and it already knows that a multi-module target needs one isolated graph per module (indexing
  // from an ancestor rebuilds a merged graph with fabricated cross-module edges). Shelling out here would be a
  // second, worse copy of that knowledge.
  //
  // Skipped for the no-graph arm, where the ABSENCE of an index is the thing under test — building one there
  // would quietly convert the only unavailability fixture into another available one.
  if (buildIndex) try {
    await buildCodeGraph({ target: destDir, quiet: true });
  } catch (error) {
    throw new Error(`could not build the navigation index for the frozen corpus: ${(error as Error).message}. The baseline needs one — without it every arm degrades to channel-unavailable and every assertion below it becomes vacuous.`);
  }

  await writeMarker(marker, expectedKey);
  return destDir;
}

async function readMarker(path: string): Promise<string | null> {
  try {
    await stat(path);
    return (await import("node:fs/promises")).readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function writeMarker(path: string, key: string): Promise<void> {
  await (await import("node:fs/promises")).writeFile(path, key);
}

/**
 * Seal the corpus against what the run actually read.
 *
 * The checkout above proves what was written to disk; this proves what layer 1 counted. They differ whenever an
 * ignore rule, a scanner version or a stray untracked file changes, and that difference is exactly the silent
 * drift a pinned baseline exists to catch.
 */
export function assertCorpusSealed(pin: CorpusPin, observedDigest: string): void {
  if (observedDigest !== pin.filesContentManifestDigest) {
    throw new Error(`corpus-mismatch: the run counted ${observedDigest} but the fixture pins ${pin.filesContentManifestDigest}; the materialized bytes are not the bytes this baseline was measured on`);
  }
}
