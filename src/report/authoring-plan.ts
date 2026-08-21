/**
 * WHAT THIS FILE IS AFTER 57B-480: the template half — `referencePath` and `makeDocumentPlan`, which are the
 * bound contract's per-section REQUIREMENT producers (`bound-run-contract.ts` materializes one requirement row per
 * template section, and layer 6 declares each row as a `knowledge-requirement`). They are deliberately NOT retired.
 *
 * NOTHING ELSE IS LEFT HERE. The stranded `outputFrontMatter` this banner used to name went with `assembleRun`
 * in the same slice, so the two functions above are the whole file — and both of them are requirements
 * producers, not authoring machinery. Grep-verified when this was rewritten: `git grep -n "authoring-plan"
 * -- src tests` reaches only `run.ts`, which imports exactly `referencePath` and `makeDocumentPlan`.
 *
 * THE AUTHORING PROMPT IS GONE, AND ONE COVERAGE DENOMINATOR WENT WITH IT. `authorPrompt` carried the instruction
 * that a `detailed` feature document account for the consumable fact pack item by item. Stated precisely, because
 * the next reader has to be able to tell a decision from an oversight:
 *
 *   - The six STRUCTURAL fact-pack categories (entrypoints, entities, states, config-keys, jobs, external-calls)
 *     have NO coverage denominator on the unit path. They never became obligations: `logic-workitems.ts` promotes
 *     only the rescued `logic` items — the ones its own header says "the six structural fact-pack categories do
 *     not name" — and `read-obligations.ts` derives READ obligations from the pack, not report-coverage ones.
 *   - The frozen-evidence coverage account IS on the unit path, in the appendix packet, WITH counts:
 *     `evidenceReachOf` (`unit-packet.ts:180`) returns `frozenEvidenceIds` / `boundEvidenceIds` / `unbound`, the
 *     last as whole records and never capped. So the reduction is one specific denominator, not the account.
 *   - The enforcement half, `auditDetailedFeatureSection` (`section-audit.ts:258`), dies with 57B-481. Same
 *     reduction, other half.
 *
 * RESTORING IT NEEDS A DENOMINATOR FROM A LOWER LEDGER FIRST: "visible consumable fact-pack item" has to be
 * defined against a recorded fact ledger before anything can be held to covering them all. That is why this was
 * ruled an accepted, named reduction rather than a blocker — it is the same family as the incomplete fact-side
 * denominators tracked separately, and it moves no ledger byte and no digest.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Audience, DocumentPlan } from "../base/types.ts";
import type { PlannedDocument } from "../contract/bound-run-contract.ts";
import { sectionFileStem } from "./section-slug.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REFERENCES = join(PROJECT_ROOT, "skills", "excavator", "references");

export function referencePath(kind: "overview" | "feature", audience: Audience): string {
  return join(REFERENCES, `${audience}-${kind}.md`);
}

export function makeDocumentPlan(
  runDir: string,
  planned: PlannedDocument,
  templatePath: string,
  contextPath: string,
  subject: string | undefined,
): DocumentPlan {
  const { id, kind, audience } = planned;
  return {
    id,
    kind,
    audience,
    subject,
    templatePath,
    contextPath,
    sections: planned.sections.map(({ index, title }) => {
      // Section markdown and its claims sidecar share one `NN-<slug>` stem, so a section and its claims
      // carry the same human-readable name while the zero-padded prefix keeps them numerically ordered.
      const stem = sectionFileStem(index, title);
      return {
        index,
        title,
        file: join(runDir, "sections", id, `${stem}.md`),
        claimsFile: join(runDir, "claims", id, `${stem}.json`),
        complete: false,
      };
    }),
  };
}

