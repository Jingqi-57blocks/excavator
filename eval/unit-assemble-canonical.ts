// Canonical projection of a run's UNIT-PATH assemble artifacts (57B-434 R7b), for a checked-in golden that
// survives being run twice and dies on a content change.
//
// IT REUSES THE SECTION PATH'S PROJECTION RATHER THAN RESTATING IT. `canonicalAssembleProjection` already reads
// everything under `reports/`, substitutes the six volatile identifiers and reports which rules fired; a second
// copy of those six rules for the unit path would be a second definition of "volatile", and the two would drift.
// Reading the WHOLE `reports/` directory is also the stronger choice here, not a convenience: the unit path and the
// section path share that directory, so a run that assembled units and nothing else must produce exactly the unit
// path's four files — and if a section assemble ever ran in the same run, the extra files would show up in the
// projection as a diff instead of hiding in a subdirectory nobody projected.
//
// IT ADDS EXACTLY TWO RULES, because the unit path's front matter pins two digests the section path never printed:
//
//   7. plan catalog digest — `sha256(canonicalJson(plan/catalog.json))`. The catalog embeds the run id, so this
//                            digest moves every run even when the plan is structurally identical.
//   8. knowledge digest    — the epoch digest the catalog records, which moves with the run's own evidence ids.
//
// Both are read off the RUN'S OWN artifacts and replaced as exact strings, never as a hex-shaped pattern: a digest
// that is not one of these two is left alone, so a hand-pinned constant in a companion would still show as a diff.
// Two equal values would make one placeholder ambiguous, so that is a named failure rather than a silent collapse.
//
// Nothing else is touched. Front matter, the contents table, navigation anchors, unit prose, claim statements,
// companion counts and every coverage sentence reach the golden verbatim.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../src/base/util.ts";
import type { PlanCatalogArtifact } from "../src/report/plan-artifacts.ts";
import { canonicalAssembleProjection, type AppliedRule, type VolatileIdentity } from "./report-canonical.ts";

/** The two digests the unit path prints that the shared identity does not carry. */
export interface UnitAssemblyDigests {
  readonly planCatalogDigest: string;
  readonly knowledgeDigest: string;
}

export interface UnitAssemblyProjection {
  readonly text: string;
  readonly identity: VolatileIdentity;
  readonly digests: UnitAssemblyDigests;
  /** Report-relative paths, sorted; a changed file set changes the projection. */
  readonly files: readonly string[];
  readonly applied: readonly AppliedRule[];
}

function fail(message: string): never {
  throw new Error(`unit assemble canonical: ${message}`);
}

/** The two run-specific digests, read off `plan/catalog.json` and re-derived the way Core derives them. */
export function unitAssemblyDigests(runDir: string): UnitAssemblyDigests {
  const path = join(runDir, "plan", "catalog.json");
  if (!existsSync(path)) fail(`${runDir} has no plan/catalog.json; this run has no recorded plan to assemble from`);
  const catalog = JSON.parse(readFileSync(path, "utf8")) as PlanCatalogArtifact;
  if (typeof catalog.knowledgeDigest !== "string" || catalog.knowledgeDigest === "") fail("plan/catalog.json records no knowledge digest");
  return { planCatalogDigest: sha256(canonicalJson(catalog)), knowledgeDigest: catalog.knowledgeDigest };
}

/** The projection: the six shared rules, then the two digest rules. */
export function canonicalUnitAssembleProjection(runDir: string): UnitAssemblyProjection {
  const shared = canonicalAssembleProjection(runDir);
  const digests = unitAssemblyDigests(runDir);
  if (digests.planCatalogDigest === digests.knowledgeDigest) {
    fail(`the plan catalog digest and the knowledge digest are both ${digests.planCatalogDigest}, so one placeholder could not tell them apart`);
  }
  let text = shared.text;
  const applied: AppliedRule[] = [...shared.applied];
  for (const [name, literal, placeholder] of [
    ["plan-catalog-digest", digests.planCatalogDigest, "<PLAN-CATALOG-DIGEST>"],
    ["knowledge-digest", digests.knowledgeDigest, "<KNOWLEDGE-DIGEST>"]
  ] as const) {
    const parts = text.split(literal);
    text = parts.join(placeholder);
    applied.push({ name, placeholder, replacements: parts.length - 1 });
  }
  return { text, identity: shared.identity, digests, files: shared.files, applied };
}
