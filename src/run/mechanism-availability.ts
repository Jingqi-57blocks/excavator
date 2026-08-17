import { loadAstGrep, perlStructuralReady, warmExtractors } from "../facts/probe/condition-extract.ts";
import { findUniversalCtags } from "../nativegraph/ctags.ts";
import type { MechanismAvailability, MechanismAvailabilityMap } from "../base/mechanism-registry.ts";

/**
 * Observe, once per run, whether each mechanism's runtime dependency is actually present.
 *
 * This lives in the orchestration layer on purpose. Layer 2 must not reach up into the mechanisms to ask them
 * how they are doing — its input is `files.json`, the two registries, and this map. Putting the collector next
 * to the ledger would have given a brand-new layer-2 directory an upward import on its first day, and every
 * later mechanism would have followed the same path.
 *
 * Each probe is the SAME call the mechanism itself makes, which is the only way the ledger's claim can be
 * checked against reality. Two of them are easy to get wrong:
 *
 *  - ctags is probed with `findUniversalCtags`, not with a PATH lookup for `ctags`. macOS ships a BSD `ctags`
 *    at /usr/bin/ctags that has no JSON output and is rejected by the census, so "an executable named ctags
 *    exists" would report `available` on machines where the census can never run. Verified on this machine:
 *    /usr/bin/ctags exists and is not Universal Ctags.
 *  - `native-graph` is probed with the Perl parser because `nativegraph/build.ts` imports `./perl.ts`, which
 *    binds tree-sitter at module load: without that binding the whole builder fails to import, template
 *    scanning included. Its availability is therefore not finer than the parser's.
 *
 * The Perl probe is `warmExtractors()` followed by `perlStructuralReady()` — the extractor's OWN readiness
 * accessor — and not `loadPerlParser()`. Calling the loader here warmed the cache inside
 * `condition-extract-perl.ts`, which is a different slot from the `perlParser` variable
 * `extractComparisons` actually branches on; the two predicates could disagree, and the disagreement was
 * invisible: the ledger recorded `condition-ast-perl` as available while every window in the same run fell
 * through to the numeric regex. There is now one predicate, and it is the branch's own.
 *
 * Readiness is per PROCESS, so both `prepare` and `freeze` warm it themselves — they are two processes, and an
 * unwarmed one honestly reports not-ready, which is exactly what its extraction would have done.
 *
 * The map is total by TYPE, not by convention: adding a mechanism id makes this function fail to compile until
 * it says how that mechanism is probed. A mechanism with no runtime dependency states so explicitly rather
 * than being absent from the map.
 */
export async function collectMechanismAvailability(): Promise<MechanismAvailabilityMap> {
  const [, ctagsBinary] = await Promise.all([warmExtractors(), findUniversalCtags()]);
  const astGrep: MechanismAvailability = loadAstGrep()
    ? { status: "available" }
    : { status: "unavailable", cause: "the @ast-grep/napi native binding could not be loaded" };
  const treeSitterPerl: MechanismAvailability = perlStructuralReady()
    ? { status: "available" }
    : { status: "unavailable", cause: "the tree-sitter-perl native binding could not be loaded" };
  const ctags: MechanismAvailability = ctagsBinary
    ? { status: "available" }
    : { status: "unavailable", cause: "no Universal Ctags binary was found" };
  const sqlite = await sqliteAvailability();
  // Pure Node: filesystem reads plus regular expressions, nothing to be missing.
  const builtIn: MechanismAvailability = { status: "available" };
  return {
    "search": builtIn,
    "decision-probe": astGrep,
    "condition-ast": astGrep,
    "condition-ast-perl": treeSitterPerl,
    "condition-regex-numeric": builtIn,
    "native-graph": treeSitterPerl,
    // The designated partition builder shares ast-grep with the two probes, so it shares their probe: if the
    // binding is missing, the builder is missing, and layer 3 must say `Unavailable` instead of publishing a
    // partition it could not build.
    "partition-ast": astGrep,
    "framework": builtIn,
    "db-schema": builtIn,
    "crossrepo": astGrep,
    "ctags-census": ctags,
    "codegraph": sqlite
  };
}

/**
 * Whether index queries can run at all. NOT whether this run has an index: which files a particular database
 * happens to contain is the index reporting its own coverage, and layer 2 is forbidden that input. Whether a
 * run resolved a database is recorded in the layer-3 producer envelope.
 */
async function sqliteAvailability(): Promise<MechanismAvailability> {
  try {
    await import("node:sqlite");
    return { status: "available" };
  } catch (error) {
    return { status: "unavailable", cause: `node:sqlite is unavailable: ${(error as Error).message}` };
  }
}
