import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Audience, DocumentPlan, RunManifest } from "../base/types.ts";
import type { PlannedDocument } from "../contract/bound-run-contract.ts";
import { slugify } from "../base/util.ts";
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

export function outputFrontMatter(document: DocumentPlan, manifest: RunManifest, body: string): string {
  const localizedTitle = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const fallbackTitle = document.kind === "overview"
    ? `${basename(manifest.request.target)} — ${document.audience} overview`
    : `${document.subject ?? "Feature"} — ${document.audience} report`;
  const title = localizedTitle || fallbackTitle;
  const navTitle = localizedTitle || (document.kind === "overview" ? `${document.audience} overview` : document.subject ?? "Feature");
  const order = manifest.documents.findIndex((item) => item.id === document.id) + 1;
  // `sourceText` travels with the report because the report is the artifact that LEAVES the machine. With
  // redaction defaulting off, a quoted evidence excerpt may be verbatim source, and a reader who received
  // the HTML export has no other way to know which of the two things they are holding.
  const sourceText = manifest.request.redactSecrets === true ? "redacted" : "verbatim";
  return `---\ntitle: ${yamlScalar(title)}\nnavTitle: ${yamlScalar(navTitle)}\nkind: ${document.kind}\naudience: ${document.audience}\nlanguage: ${manifest.request.language}\norder: ${order}\nrun: ${manifest.id}\nsnapshot: ${manifest.snapshot?.id ?? "unknown"}\nsourceText: ${sourceText}\n---`;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

export function reportFileName(document: DocumentPlan): string {
  if (document.kind === "overview") return `${document.audience}-overview.md`;
  return `${slugify(document.subject ?? "feature")}-${document.audience}.md`;
}

export function authorPrompt(runDir: string, document: DocumentPlan, language: string, detailLevel: "standard" | "detailed"): string {
  const templatePath = relative(runDir, document.templatePath).replaceAll("\\", "/");
  const contextPath = relative(runDir, document.contextPath).replaceAll("\\", "/");
  return `# Excavator authoring task

Write **${document.id}** in **${language}** at **${detailLevel}** detail level. All instructions and report contracts are English; translate the visible report naturally into the requested output language.

Read these inputs before writing:

- Report contract: \`${templatePath}\`
- Document instructions: \`${contextPath}\`
- Shared project context: \`context/shared.md\`
- Bounded layer-5 census and ReadSpec view: \`context/workset.md\`
- Frozen investigation view: \`context/authoring/${document.id}.md\`

The frozen investigation view is written by freeze and is the only model-facing evidence/work-item view. Read it before writing: it lists, per section, the work items, deterministic facts and frozen evidence that section must cover — cover each listed item or state explicitly why it does not apply. Do not load \`evidence.json\`, its shards/content store, \`workitems.json\`, \`traces.json\`, \`checklist.json\` or \`knowledge.json\` into the model context; those are authoritative machine/audit storage.

For a feature document, the document instructions identify the reusable feature-scope file under \`context/features/\`.

Use the report contract's chapter order exactly. In section 1, begin with one localized level-one report title that identifies the audience, then write the localized level-two chapter heading. Write one section at a time and checkpoint it immediately. Every checkpoint must include a claims JSON file: every substantive sentence or table row is bound to an exact statement in the section; supported claims cite evidence IDs that also appear in that section's collapsed evidence block. Claims also list the work-item IDs they satisfy. Every material work item required for this document must be represented by at least one claim in its assigned section and must reuse that work item's evidence or trace.

When the requested detail level above is \`detailed\`, do not compress distinct rules, states, types, thresholds, entry points, records, jobs or side effects into a few summary sentences. Build the section inventory first, then enumerate every material distinct item supported by the prepared evidence. Use the contract-required tables and Mermaid diagrams. The feature context is a candidate corpus, not a finished summary.
${factPackInstructions(document, detailLevel)}
The investigation is frozen before authoring: the bounded authoring view and prepared context are the model input, while the machine artifacts remain the audit authority. Consume the view as written; do not re-investigate to fill a gap. When a claim seems to lack evidence, first decide whether it is an expression problem — the evidence you need is almost always already present under a different framing. Only when the frozen knowledge is genuinely incomplete, open a supplement: re-run the relevant Excavator command with \`--supplement-reason "<why the frozen knowledge is insufficient>" --supplement-workitem <work item id>\`, which performs the operation and records the exception in the coverage ledger. Ensure each material item appears in the report.

Describe current state and current problems only. Do not provide recommendations, remediation, future architecture, migration steps, or action items. A target problem must be attributable to the target snapshot. Never place CodeGraph/Excavator limitations, unresolved graph references, source fallback, provider coverage, analysis budgets or static-review limitations in a target risk/current-problem section; put them only in the coverage chapter or an Excavator validation report.
`;
}

/**
 * Detailed feature chapters must account for the prepared consumable fact-pack view item by item.
 * The machine pack remains the audit denominator; co-located rows are not authoring claims.
 */
function factPackInstructions(document: DocumentPlan, detailLevel: "standard" | "detailed"): string {
  if (document.kind !== "feature" || detailLevel !== "detailed") return "";
  return `
The feature scope file carries the bounded \`## Fact pack\` model view and its source digest. The corresponding machine pack remains audit storage and must not be read directly by the author. Authoring consumes only rows marked \`seeded\` or \`retained\`; \`co-located\` and \`not-applicable\` rows are audit context, not facts to repeat. The categories are \`entrypoints\`, \`entities\`, \`states\`, \`config-keys\`, \`jobs\`, \`external-calls\` and \`logic\` (the business and decision functions inside the boundary that the structural categories do not already name). The enumerating chapters — entry points, rules and states, data, configuration and integrations — must cover every visible consumable fact-pack item of the matching category: each item either appears in that chapter, or is folded into an explicitly counted group such as "N further items of kind X". Cite the category's \`FACT-*\` evidence id in the chapter that covers it. The consumable \`logic\` items belong to the flow, decision and authorization chapters; a consumable logic item carrying a \`signal\` (rescued into the boundary by structural analysis) must be dispositioned individually — named and placed where its behavior belongs — never folded into an aggregate count. Each such rescued \`logic\` function is also a \`logic-disposition\` work item in \`workitems.json\` (id \`feature:<key>:logic:<name>@<path>:<line>\`, no pinned section): dispose it before freeze, then satisfy it with at least one visible claim that DESCRIBES THE BUSINESS BEHAVIOR and cites the deciding source window, listing the work-item id in the claim's \`workItemIds\`. The prose need not repeat the symbol name — identifiers stay in the collapsed evidence block or coverage chapter, and covering the behavior counts because the ledger binds through the cited evidence, not the name. A genuinely boundary-noise item is disposed \`not-applicable\` with a reason; one claim may batch-dispose several such n/a items by listing them all in \`workItemIds\`. When source reading contradicts a consumable fact-pack item, say so explicitly and state which reading the source supports; a fact-pack category marked truncated or view-bounded must be reported as incomplete rather than presented as a full inventory. Silently omitting a visible consumable item is a defect.
`;
}
