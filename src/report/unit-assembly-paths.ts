/**
 * WHERE THE UNIT PATH'S ASSEMBLED BYTES LAND — and the one refusal that keeps the two report worlds apart.
 *
 * THE SECTION WORLD AND THE UNIT WORLD SHARE `reports/`, AND THAT IS DELIBERATE. `reports/` is the directory an
 * operator ships; hiding the unit path's deliverable in a subdirectory would make the two worlds LOOK separate
 * while the real question — can one silently overwrite the other — went unasked. So they share the directory and
 * the overlap is stated as a check: `assertNoSectionPathConflict` refuses a unit target that equals a path the
 * section path names. It is reachable rather than decorative. `plannedDocumentId` mints `overview-<audience>`, so
 * the unit target for a product overview is `reports/overview-product.md`; `reportFileName` names a FEATURE
 * document `reports/<slug(subject)>-<audience>.md`, so a run that also asks for a feature whose subject slugs to
 * `overview` produces exactly that name from the other side. No hand-edited file is needed to reach the refusal.
 *
 * BOTH SIDES ARE PARAMETERS, so the negative fixture hands it an overlapping pair and watches the refusal fire —
 * the same reason `assertDistinctUnitPathKeys` takes its key function rather than reaching for the real encoder.
 *
 * A DOCUMENT ID BECOMES A FILE NAME HERE, so it is checked as a path segment. The rules are `assertUsableUnitId`'s
 * and are not restated: "may this string be one path segment inside the run" is one question, and a second list of
 * separator/traversal/device-name/folding rules here would be a second answer that drifts from the first. Only the
 * CONTEXT is added, because "which document was about to be written where" is what makes the refusal actionable.
 * The check is needed rather than ceremonial: `plan/requests.json` is a file on disk and `request-append` takes a
 * document id from the command line, so the id reaching this function is not always one Core minted.
 */

import { join, resolve } from "node:path";
import { safeRelative } from "../base/util.ts";
import { assertUsableUnitId } from "./unit-paths.ts";

/** The run-relative directory both report worlds write into. */
export const REPORTS_DIRNAME = "reports";

/** The run-relative directory both worlds' companions sit in. */
export const COMPANIONS_DIRNAME = "companions";

/**
 * The run-relative coverage companion of the unit path.
 *
 * Run-scoped and not per document: `loadCoverageStateFacts` answers for the whole run — four ledgers, one plan —
 * and writing one copy per document would be one fact with N owners. Every assembled document links to this path.
 */
export const UNIT_COVERAGE_COMPANION_PATH = `${REPORTS_DIRNAME}/${COMPANIONS_DIRNAME}/unit-coverage.md`;

/** One document's companions, run-relative. `unit-` prefixed: the section path owns the unprefixed names. */
export interface UnitDocumentCompanionPaths {
  readonly claims: string;
  readonly traces: string;
  readonly coverage: string;
}

/** One target this assembly would write, run-relative, and the document that owns it. */
export interface UnitAssemblyTarget {
  readonly documentId: string;
  readonly path: string;
}

/** One path the section world names, run-relative, and the document that owns it. */
export interface SectionReportTarget {
  readonly documentId: string;
  readonly path: string;
}

/**
 * Refuse a document id that may not become a report file name, naming the document and the rule it broke.
 *
 * Delegation, not a second rule set — see the file header.
 */
export function assertUsableUnitDocumentId(documentId: string): void {
  try {
    assertUsableUnitId(documentId);
  } catch (error) {
    throw new Error(`Document ${JSON.stringify(documentId)} cannot name a unit-path report file; it has to be usable as one path segment inside the run, by the same rules a unit id is: ${(error as Error).message}`);
  }
}

/** The run-relative markdown target of one assembled document. */
export function unitDocumentReportPath(documentId: string): string {
  assertUsableUnitDocumentId(documentId);
  return `${REPORTS_DIRNAME}/${documentId}.md`;
}

/** The three companions one assembled document links to, run-relative. */
export function unitDocumentCompanionPaths(documentId: string): UnitDocumentCompanionPaths {
  assertUsableUnitDocumentId(documentId);
  const base = `${REPORTS_DIRNAME}/${COMPANIONS_DIRNAME}/${documentId}`;
  return { claims: `${base}.unit-claims.json`, traces: `${base}.unit-traces.json`, coverage: UNIT_COVERAGE_COMPANION_PATH };
}

/** Every run-relative path assembling one document writes: the markdown plus its two own companions. */
export function unitDocumentTargets(documentId: string): readonly string[] {
  const companions = unitDocumentCompanionPaths(documentId);
  return [unitDocumentReportPath(documentId), companions.claims, companions.traces];
}

/**
 * An absolute path from a run-relative one. Every write goes through here, so nothing rebuilds `reports/` by hand.
 *
 * The containment assertion is a CONSTRUCTION tripwire, the same one `unitPaths` carries: every input reaching it
 * today is built by the functions above from an id they already refused traversal in, so it cannot fire — and it is
 * here because the day one of those changes, this is the difference between a named refusal and a write outside the
 * run. `safeRelative` is the base's own containment primitive; a second spelling of the rule would be a second
 * place to fix.
 */
export function runRelativePath(runDir: string, relative: string): string {
  const root = resolve(runDir);
  const path = join(root, ...relative.split("/"));
  try {
    safeRelative(root, path);
  } catch {
    throw new Error(`Unit-path artifact ${JSON.stringify(relative)} resolves to ${JSON.stringify(path)}, which is outside the run directory ${JSON.stringify(root)}`);
  }
  return path;
}

/**
 * Refuse a unit-path target that is also a section-path target, naming both documents and the path.
 *
 * Two documents writing one file is the identity collapse this repository has measured twice — one directory for
 * two units, one claim key for two sections — in the shape where nothing that counts rows would notice: both
 * worlds would report a successful write and one of the two files would simply not be there.
 */
export function assertNoSectionPathConflict(
  unitTargets: readonly UnitAssemblyTarget[],
  sectionTargets: readonly SectionReportTarget[]
): void {
  const occupied = new Map<string, string>();
  for (const target of sectionTargets) {
    // First writer wins the message: which section document to name is not the point, the collision is.
    if (!occupied.has(target.path)) occupied.set(target.path, target.documentId);
  }
  for (const target of [...unitTargets].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const owner = occupied.get(target.path);
    if (owner !== undefined) {
      throw new Error(`Unit-path document ${JSON.stringify(target.documentId)} would assemble into ${JSON.stringify(target.path)}, which the section path already names for document ${JSON.stringify(owner)}; the two report paths may not write one file`);
    }
  }
}
