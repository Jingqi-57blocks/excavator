import type { Audience, BudgetConfig, DocumentKind, ReportRequest } from "../base/types.ts";
import { sha256, stableJson } from "../base/util.ts";
import { normalizeFeatureProfile, type FeatureProfile } from "../base/feature-profile.ts";

/**
 * The bound run contract: two of the three external inputs that exist BEFORE any layer runs.
 *
 * `run-intent.json` is what the operator asked for; `requirements.json` is what the report side needs
 * answered, translated into rows at the boundary. Both are read-only for the rest of the run, and neither is
 * derived from anything a producer computed — that is the property that lets layer 8 verify a run against
 * the contract it recorded instead of against whatever the current code happens to expect.
 *
 * The third input, `contract-manifest.json`, is derived from the base registry plus these two; see
 * `contract-manifest.ts`.
 *
 * Query aliases are SORTED and de-duplicated here. The same intent written in a different order used to be a
 * different byte sequence, so the contract digest — and anything keyed on it — drifted for no reason.
 */

export interface RunIntentFeature {
  /** The feature's cache key, minted by the caller; the contract records it, never re-derives it. */
  key: string;
  subject: string;
  /** Query aliases, sorted and de-duplicated. */
  aliases: string[];
  /**
   * Recorded hypotheses, normalised. Written ONLY when the request carried one, so a run without profiles
   * produces the same bytes it did before the field existed — the digest then differs only by the version string.
   */
  profile?: FeatureProfile;
}

/**
 * Exported so the pinned baselines can be checked against it without a corpus. The S3 bump from v1 to v2 had to
 * be re-pinned by hand, and nothing would have gone red if it had been forgotten — which is the same
 * remembered-flag failure the channel-set coupling already closes.
 */
export const RUN_INTENT_VERSION = "run-intent-v2" as const;

export interface RunIntent {
  version: typeof RUN_INTENT_VERSION;
  target: string;
  outputLanguage: string;
  features: RunIntentFeature[];
  /** Requested document ids, sorted. */
  documents: string[];
  budgets: BudgetConfig;
  digest: string;
}

export interface RequirementRow {
  /** `REQ-<nn>`, assigned by position in the deterministic row order. */
  id: string;
  scope: "run" | "feature";
  /** The feature key this requirement belongs to, or null for a run-level requirement. */
  featureKey: string | null;
  documentId: string | null;
  audience: Audience | null;
  /** Positional level-two template section, or null for a run-level requirement. */
  sectionIndex: number | null;
  /** Recorded so the requirement remains understandable without reopening the template. */
  sectionTitle: string | null;
  statement: string;
  /** Where the requirement came from: a report template, or the run itself. */
  source: string;
}

export interface Requirements {
  version: "requirements-v1";
  rows: RequirementRow[];
  digest: string;
}

export interface BoundRunContract {
  runIntent: RunIntent;
  requirements: Requirements;
}

/** One requested document, as the orchestrator plans it before any producer runs. */
export interface PlannedDocument {
  id: string;
  kind: DocumentKind;
  audience: Audience;
  featureKey: string | null;
  /** Deterministically extracted before any producer runs; one requirement is materialized per section. */
  sections: Array<{ index: number; title: string }>;
}

export interface BoundRunContractInput {
  request: ReportRequest;
  features: RunIntentFeature[];
  documents: PlannedDocument[];
}

/**
 * The run-level requirements every run carries, features or not.
 *
 * They exist because accounting used to be keyed by feature: an overview-only run asked for nothing, so it
 * could go silent about the whole target and no row anywhere said a question had gone unanswered.
 */
const RUN_LEVEL_REQUIREMENTS: Array<{ statement: string; source: string }> = [
  { statement: "The scanned source boundary is stated with its completeness: which candidates were counted, which were excluded and under which rule.", source: "run" },
  { statement: "Every recorded artifact this run produced carries a written result, including the ones that could not be produced.", source: "run" }
];

export function materializeBoundRunContract(input: BoundRunContractInput): BoundRunContract {
  const runIntent = materializeRunIntent(input);
  return { runIntent, requirements: materializeRequirements(input) };
}

function materializeRunIntent(input: BoundRunContractInput): RunIntent {
  const features = [...input.features]
    .map((feature) => {
      const raw = feature.profile;
      return {
        key: feature.key,
        subject: feature.subject,
        aliases: [...new Set(feature.aliases)].sort((a, b) => a.localeCompare(b)),
        // Spread conditionally: a feature with no profile must not gain a `profile: undefined` key, or every
        // run without hypotheses would move its own digest for a field it does not have.
        ...(raw === undefined ? {} : { profile: normalizeFeatureProfile(raw, feature.key) })
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  const unsigned = {
    version: RUN_INTENT_VERSION,
    target: input.request.target,
    outputLanguage: input.request.language,
    features,
    documents: input.documents.map((document) => document.id).sort((a, b) => a.localeCompare(b)),
    budgets: input.request.budgets
  };
  return { ...unsigned, digest: runIntentDigest(unsigned) };
}

/**
 * The two contract inputs' self-digests, from their own recorded fields.
 *
 * They are exported for the same reason `contractManifestDigest` is: layer 8 verifies the record it reads out
 * of an archived run against itself, and a digest nobody recomputes is decoration. Each formula lives here
 * only — the requirements digest deliberately covers the ROWS alone, which is only safe while one function
 * spells it out for both the producer and the verifier.
 */
export function runIntentDigest(runIntent: Omit<RunIntent, "digest">): string {
  const { digest: _recorded, ...unsigned } = runIntent as RunIntent;
  return sha256(stableJson(unsigned));
}

export function requirementsDigest(requirements: Pick<Requirements, "rows">): string {
  return sha256(stableJson(requirements.rows));
}

/**
 * The requirement row set: the run-level rows plus one row per level-two section of every requested document.
 *
 * A template is a PRODUCER of requirements, not the requirement itself, so the row names the audience and
 * kind it came from rather than a template path — a machine-specific absolute path would make the contract
 * digest differ between two machines running the same request.
 */
function materializeRequirements(input: BoundRunContractInput): Requirements {
  const rows: Array<Omit<RequirementRow, "id">> = RUN_LEVEL_REQUIREMENTS.map((requirement) => ({
    scope: "run" as const,
    featureKey: null,
    documentId: null,
    audience: null,
    sectionIndex: null,
    sectionTitle: null,
    statement: requirement.statement,
    source: requirement.source
  }));
  const subjects = new Map(input.features.map((feature) => [feature.key, feature.subject]));
  for (const document of [...input.documents].sort((a, b) => a.id.localeCompare(b.id))) {
    const subject = document.featureKey === null ? null : subjects.get(document.featureKey) ?? document.featureKey;
    for (const section of document.sections) {
      rows.push({
        scope: document.featureKey === null ? "run" : "feature",
        featureKey: document.featureKey,
        documentId: document.id,
        audience: document.audience,
        sectionIndex: section.index,
        sectionTitle: section.title,
        statement: subject === null
          ? `The ${document.audience} ${document.kind} section "${section.title}" is answerable from this run's recorded knowledge.`
          : `The ${document.audience} ${document.kind} section "${section.title}" on "${subject}" is answerable from this run's recorded knowledge.`,
        source: `template:${document.kind}/${document.audience}#section-${String(section.index).padStart(2, "0")}`
      });
    }
  }
  const numbered: RequirementRow[] = rows.map((row, index) => ({ id: `REQ-${String(index + 1).padStart(2, "0")}`, ...row }));
  return { version: "requirements-v1", rows: numbered, digest: requirementsDigest({ rows: numbered }) };
}
