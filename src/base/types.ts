import type { FactKindId, Membership } from "./fact-kind-registry.ts";
import type { FeatureProfile } from "./feature-profile.ts";
import type { RowSetIdentity } from "./row-set.ts";

export type Audience = "product" | "engineering" | "prd";
export type DocumentKind = "overview" | "feature";
export type RunState = "planned" | "preparing" | "prepared" | "authoring" | "assembled" | "audited" | "complete" | "failed" | "timed-out";
export type EvidenceMarker = "fact" | "verified" | "inferred" | "unavailable";
export type ChecklistVerdict = "pending" | "hit" | "searched-not-found" | "cannot-determine" | "not-applicable";
export type WorkItemStatus = "pending" | "in_progress" | "found" | "searched-not-found" | "cannot-determine" | "not-applicable";
export type TraceType = "callflow" | "dataflow" | "business-flow" | "state-transition" | "cross-repository" | "analysis-path";
export type TraceStatus = "candidate" | "verified" | "unavailable";
export type Confidence = "high" | "medium" | "low";
export type CodeGraphMode = "auto" | "off";
export type DetailLevel = "standard" | "detailed";

export interface FeatureRequest {
  subject: string;
  aliases: string[];
  audiences: Audience[];
  /**
   * Unverified hypotheses about where this capability enters the system; see `FeatureProfile`.
   *
   * Optional because the whole point is that a caller who has nothing to assert says nothing. Absent and present
   * are genuinely different intents, and the contract records which one it got — an empty profile is refused
   * rather than treated as absent.
   */
  profile?: FeatureProfile;
}

export interface ReportRequest {
  target: string;
  codegraph?: string;
  /** Resolved per-module database paths (multi-module targets). Persisted so the CodeGraph identity is
   * reproducible when `source`/`audit` re-derive it after preparation. */
  codegraphModules?: string[];
  codegraphMode?: CodeGraphMode;
  language: string;
  detailLevel?: DetailLevel;
  workdir: string;
  overviewAudiences: Audience[];
  features: FeatureRequest[];
  budgets: BudgetConfig;
  /**
   * Whether recorded source is scanned for secrets and their values blanked.
   *
   * ON by default — only an explicit `false` (or `--no-redact`) turns it off. The costs are not symmetric:
   * redaction loses evidence, which is measured and recoverable by re-running (a real run blanked ten branches
   * of a leave calculation because the domain names an hours field `*Token`), while not redacting can leak a
   * credential into artifacts that have already been handed on, which is neither.
   *
   * `undefined` therefore means ON: an omitted field is a caller who did not decide. `prepareRun` normalises it
   * to an explicit boolean, so the manifest never carries `undefined` and consumers can read `=== true`.
   */
  redactSecrets?: boolean;
}

export interface BudgetConfig {
  prepareMs: number;
  authorMs: number;
  maxGraphQueries: number;
  maxSourceWindows: number;
  maxSourceCharacters: number;
  maxFiles: number;
  maxFeatureNodes: number;
  maxExpansionDepth: number;
}

export interface SnapshotRoot {
  name: string;
  path: string;
  gitHead: string | null;
  gitBranch: string | null;
  dirty: boolean | null;
  fileCount: number;
}

export interface Snapshot {
  id: string;
  target: string;
  createdAt: string;
  roots: SnapshotRoot[];
  /** Which identity generation derived `id`. Two ids are comparable only when this field matches. */
  scannerVersion: string;
  ignoreRulesDigest: string;
  /** tier1: the (path, size, mtime) shape. Recorded, advisory on mismatch, and NOT part of `id` — it cannot
   *  see a same-size rewrite that preserves the mtime, which is how stale bytes were served with a valid digest. */
  sourceManifestDigest: string;
  /** tier2: the content digest of the whole counted set. This is what `id` anchors on; a mismatch is an error. */
  contentManifestDigest: string;
}

export interface ProviderCapability {
  id: string;
  available: boolean;
  selected: boolean;
  version?: string;
  path?: string;
  selectionReason: string;
  capabilities: string[];
  metadata?: Record<string, unknown>;
}

export interface ProviderRegistry {
  version: 1;
  snapshotId: string;
  createdAt: string;
  providers: ProviderCapability[];
  digest: string;
}

export interface AnalysisScope {
  version: 1;
  runId: string;
  snapshotId: string;
  createdAt: string;
  target: string;
  repositories: Array<{ name: string; path: string; gitHead: string | null; dirty: boolean | null; fileCount: number }>;
  sourcePolicy: {
    gitAware: true;
    includeTracked: true;
    includeUntrackedNotIgnored: true;
    excludeIgnoredUntracked: true;
    scannerVersion: string;
    ignoreRulesDigest: string;
    sourceManifestDigest: string;
  };
  providerMode: CodeGraphMode;
  providerRegistryDigest: string;
  outputLanguage: string;
  requestedDocuments: string[];
  budgets: BudgetConfig;
  runtimeExecution: false;
  digest: string;
}

export interface EvidenceItem {
  id: string;
  snapshotId: string;
  kind: "graph" | "source" | "readme" | "manifest" | "git" | "coverage" | "derived" | "search" | "scope" | "provider" | "limitation" | "fact" | "ledger";
  title: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  content?: string;
  data?: unknown;
  reason: string;
  digest: string;
  /** Run-relative immutable bytes after this run's redaction mode and before any evidence bound. */
  contentRef?: string;
  contentDigest?: string;
  /** Byte lengths before and after deterministic clipping; present together with `contentRef`. */
  originalBytes?: number;
  retainedBytes?: number;
  truncatedReason?: string;
  boundPolicyVersion?: string;
  redactionVersion?: string;
  sensitive?: boolean;
  supersedes?: string;
}

export interface SourceWindow {
  cacheVersion: string;
  id: string;
  snapshotId: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  digest: string;
  reason: string;
}

/**
 * The persisted `data` payload of a `SEARCH-*` evidence item. A search returns at most `maxResults`
 * ranked matches; when the underlying match set was larger, `truncated` is true and `atLeast` records
 * a lower bound on the real match count. This keeps a `searched`/`searched-not-found` receipt from
 * silently implying an exhaustive scan. `atLeast` is present only when `truncated` is true.
 */
export interface SearchReceipt {
  searchVersion: string;
  terms: string[];
  pathPrefixes: string[];
  candidateFiles: number;
  maxResults: number;
  regex: boolean;
  caseSensitive: boolean;
  truncated: boolean;
  atLeast?: number;
  matches: Array<{ path: string; line: number; excerpt: string; matchedTerms: string[]; score: number }>;
}

export interface SectionClaim {
  id: string;
  marker: EvidenceMarker;
  statement: string;
  evidenceIds?: string[];
  traceIds?: string[];
  workItemIds?: string[];
  confidence?: Confidence;
  status?: "candidate" | "verified" | "unavailable";
  reason?: string;
  supersedes?: string;
  /** Optional per-side grouping of `evidenceIds` for a cross-source comparison claim: each group is a
   * non-empty, pairwise-disjoint subset naming one compared side. Additive — claims without it are
   * unaffected. Validated by `validateComparisonSides`. */
  sides?: string[][];
}

export interface SectionClaimsFile {
  version: 1 | 2;
  documentId: string;
  section: number;
  claims: SectionClaim[];
}

/**
 * The commit marker a parallel `draft` writes last, after a section and its claims are on disk, under
 * `drafts/<documentId>/<NN>.json`. It records what `collect` needs to append the section's timeline
 * event serially: whether the draft overwrote a prior checkpoint (`revision`), the true completion
 * moment (`draftedAt`), and the evidence/trace ids the event carries. A draft that dies mid-write leaves
 * no receipt, so `collect` never records a half-written section. Additive — no ledger reads it but `collect`.
 */
export interface DraftReceipt {
  version: 1;
  runId: string;
  /** Epoch whose authoring packet this draft consumed; absent on pre-epoch archived receipts. */
  knowledgeEpoch?: number;
  documentId: string;
  section: number;
  draftedAt: string;
  revision: boolean;
  evidenceIds: string[];
  traceIds: string[];
  hasClaims: boolean;
}

export interface TraceStep {
  index: number;
  action: string;
  evidenceIds: string[];
  claimIds?: string[];
  location?: string;
}

export interface TraceRecord {
  id: string;
  title: string;
  type: TraceType;
  status: TraceStatus;
  confidence: Confidence;
  documentIds: string[];
  steps: TraceStep[];
  reason?: string;
  supersedes?: string;
  createdAt: string;
}

export interface TraceCatalog {
  version: 1;
  runId: string;
  traces: TraceRecord[];
}

export interface ChecklistItem {
  id: string;
  scope: string;
  hypothesis: string;
  verdict: ChecklistVerdict;
  material: boolean;
  evidenceIds: string[];
  searchScope?: string;
  reason?: string;
  settledBy?: string;
  origin: "default" | "open";
}

export interface InvestigationChecklist {
  version: 1;
  runId: string;
  items: ChecklistItem[];
}

export interface InvestigationWorkItem {
  id: string;
  dimension: string;
  scope: string;
  hypothesis: string;
  status: WorkItemStatus;
  material: boolean;
  requiredFor: string[];
  evidenceIds: string[];
  traceIds: string[];
  reportSection?: number;
  searchScope?: string;
  reason?: string;
  settledBy?: string;
  origin: "default" | "open";
  startedAt?: string;
  completedAt?: string;
  supersedes?: string;
}

export interface InvestigationPlan {
  version: 1;
  runId: string;
  createdAt: string;
  items: InvestigationWorkItem[];
}

/** One recorded post-freeze exception: a mutation the author made after the knowledge was frozen. */
export interface KnowledgeSupplement {
  at: string;
  /** The mutating command: `search`, `source`, `workitem`, `checklist` or `trace`. */
  command: string;
  /** The evidence / work-item / trace ids the command touched, so audit can reconcile the diff. */
  ids: string[];
  reason: string;
  /** The existing work item this supplement is charged to (resolved against `workitems.json`). */
  workItemId: string;
}

export interface CompletenessSource {
  id: string;
  coverageDomain: "file" | "module" | "module-pair" | "corpus";
  unitKind: "file" | "module" | "module-pair" | "corpus" | "node" | "partition-cell";
  identity: { artifact: string; contentDigest: string; producerVersion: string };
  /** Rows in this source's own denominator. Never added to a source with another domain or unit kind. */
  denominatorRows: number;
  /** Source-specific conserved counters. Kept separate because coverage and selection are different laws. */
  accounting: Record<string, number>;
  status: "complete" | "limited";
  limitations: string[];
}

export interface DomainCompleteness {
  coverageDomain: CompletenessSource["coverageDomain"];
  unitKind: CompletenessSource["unitKind"];
  /** Conjunction over this domain/kind only: one limited source makes this domain limited. */
  status: "complete" | "limited";
  sources: CompletenessSource[];
}

export interface FreezeAuditCheck {
  family: string;
  version: string;
  status: "passed" | "failed" | "skipped";
  findingCount: number;
  reason?: string;
}

/** Deterministic freeze-gate report, with no cross-domain or positive/negative aggregate ratio. */
export interface KnowledgeCompleteness {
  /**
   * v3 adds `closure.sourceReadsWithoutObligation`. v4 adds `closure.authorizedReads`,
   * `closure.readsDisplacedByBudget` and `closure.decisions.displaced`. The label moves with the shape because
   * "the mode is part of the identity" is a ruling this repository has already paid for: a v2 tag over two
   * different shapes lets a future consumer gate on a version that does not say what it holds. Cheap now
   * (three test fixtures, no production reader); the cost of deferring is the `assurance-v9` generation-gate
   * machinery, which exists precisely because a field once meant two things under one label.
   *
   * ABSENCE of a field in an archived epoch means NOT MEASURED — never 0. No reader may treat a missing value
   * as "no unclaimed reads" or "nothing was displaced".
   */
  version: "knowledge-completeness-v4";
  domains: DomainCompleteness[];
  closure: {
    workItems: { positive: number; negative: number; pending: number; byStatus: Record<string, number> };
    /**
     * The four disposal buckets of the decision-reading declarations, which together account for all of them.
     * `displaced` is here so the sum stays closed: a read a recorded budget ceiling displaced is neither
     * positive, nor negative, nor pending, and folding it into any of the three would either claim knowledge
     * that was never read or claim an obligation nobody disposed.
     */
    decisions: { positive: number; negative: number; pending: number; displaced: number };
    probeResiduals: number;
    materialFlowsWithTraces: number;
    /**
     * How many ReadSpecs this run executed, and how many of those a recorded budget ceiling displaced.
     *
     * `authorizedReads` is the denominator, and it is recorded because without it a sealed epoch cannot tell
     * "this run authorized no reading" from "every authorized read completed": both leave the closure's other
     * figures at zero. Present exactly when layer-7 results were available to the check — absent means the
     * check could not see them, which the same family reports as an error, not a clean pass.
     */
    authorizedReads?: number;
    readsDisplacedByBudget?: number;
    /**
     * Recorded source windows that no read execution accounts for.
     *
     * The closure check only ever asked the forward question — did every AUTHORIZED read complete — so a run
     * that read without authorization closed clean. Measured on a real wcp overview: `read-specs.json` was
     * `built` with `specs: 0`, 42 source windows were in the catalog, and freeze sealed
     * `investigation-closure: passed, 0 findings`. `ReadSpec` carries a required `featureKey`, so a run with no
     * feature authorizes nothing BY CONSTRUCTION and every one of its reads lands here.
     *
     * It is a number, not a finding. Making it an error would fail every overview run today, and the gap is a
     * property of the current L5/L7 split rather than of any one run — so freeze states the size of the gap in
     * the sealed record instead of asserting a closure it cannot justify. Whoever tightens the split later has
     * the figure already sealed for every epoch behind them.
     */
    sourceReadsWithoutObligation: number;
  };
  checks: FreezeAuditCheck[];
  warnings: string[];
}

/**
 * A `knowledge-v1` epoch: the frozen fingerprint of a run's investigation plus a completeness report.
 * Epoch 0 remains at `knowledge.json`; later epochs append under `knowledge/epochs/`. It copies no evidence
 * content and builds no ontology —
 * the deterministic packet builder reads `evidence.json`, `workitems.json`, `traces.json` and `context/*`;
 * the author reads only its bounded packet. New epochs are entirely immutable. `supplements` remains only so
 * archived pre-epoch records whose ledger lived inside `knowledge.json` retain their readable shape.
 */
export interface KnowledgeArtifact {
  version: "knowledge-v1";
  runId: string;
  snapshotId: string;
  assuranceVersion?: string;
  frozenAt: string;
  evidenceIds: string[];
  evidenceDigest: string;
  workitems: Array<{ id: string; status: WorkItemStatus }>;
  workitemsDigest: string;
  traceIds: string[];
  tracesDigest: string;
  factPackDigests: Record<string, string>;
  crossFeatureDigest?: string;
  /** Digest of the frozen read-obligation denominator (assurance generation 5+; absent on older runs). */
  readObligationsDigest?: string;
  /** Digest of `context/boundary-functions.json` — the read-obligation second source (57B-396). */
  boundaryFunctionsDigest?: string;
  /** Digest of `context/crossrepo-links.json` — the resolved cross-repo HTTP links (57B-398). */
  crossRepoLinksDigest?: string;
  /** Digest of `ledger/mechanisms.json` — which mechanisms could look at which of this run's rows (57B-420). */
  mechanismsLedgerDigest?: string;
  /** Digest of L7 ReadSpec executions, decision dispositions and retained probe residuals (57B-433). */
  investigationResultsDigest?: string;
  /** Canonical digest of work-item and L7 judgements, including reasons and grounding, not just statuses. */
  judgementDigest?: string;
  /** The exact byte-bound and redaction policy under which contentRef objects in this epoch were minted. */
  truncationPolicy?: { evidenceBounds: string; redactionVersion: string };
  completeness: KnowledgeCompleteness;
  /**
   * Which sealing epoch this immutable record is. Absent on runs frozen before epoch machinery existed.
   */
  epoch?: number;
  /** Digest of epoch N-1. Present exactly when epoch > 0, making the epoch series a closed hash chain. */
  previousEpochDigest?: string;
  /**
   * Where each append-until-freeze stream stood when this record was sealed: the stream, the last sequence or
   * item count it covers, and the digest of its tail. Without it, "appended after freeze" could only be judged
   * against the manifest's single evidence digest, and the timeline had no cutoff recorded at all.
   */
  appendStreams?: Array<{ id: string; frozenThroughSequence: number; tailDigest: string }>;
  /** Empty on immutable epochs; populated only by legacy inline-supplement knowledge records. */
  supplements: KnowledgeSupplement[];
}

export interface TimelineEventInput {
  stage: string;
  action: string;
  subject?: string;
  documentId?: string;
  section?: number;
  evidenceIds?: string[];
  workItemIds?: string[];
  traceIds?: string[];
  data?: Record<string, unknown>;
}

export interface TimelineEvent extends TimelineEventInput {
  version: 1;
  runId: string;
  sequence: number;
  at: string;
  previousDigest: string | null;
  digest: string;
}

export interface DocumentPlan {
  id: string;
  kind: DocumentKind;
  audience: Audience;
  subject?: string;
  templatePath: string;
  contextPath: string;
  sections: Array<{ index: number; title: string; file: string; claimsFile: string; complete: boolean }>;
  startedAt?: string;
  completedAt?: string;
  elapsedMs?: number;
}

export interface RunManifest {
  version: 2 | 3;
  id: string;
  state: RunState;
  createdAt: string;
  updatedAt: string;
  request: ReportRequest;
  snapshot: Snapshot | null;
  documents: DocumentPlan[];
  evidenceDigest: string;
  providerRegistryDigest?: string;
  analysisScopeDigest?: string;
  /** Strict-assurance/redaction version this run was prepared under; audit gates re-derivation on it. Absent on runs prepared before the field existed. */
  assuranceVersion?: string;
  /**
   * The identity of the CodeGraph databases this run navigated with, or null when it had none.
   *
   * It sits on the MANIFEST, not on the snapshot: an optional navigation index is not part of the source
   * boundary's identity, and having it there meant building `.codegraph` moved the snapshot id of a target
   * whose source had not changed. Its eventual home is the layer-3 CodeGraph producer envelope; the manifest
   * holds it until that envelope exists. Absent on runs prepared before the field existed — those carry it
   * under `snapshot.codegraphDigest`, and the drift check reads either, so no archived run needs migrating.
   */
  codegraphDigest?: string | null;
  /** ISO timestamp stamped by `excavator freeze` when the investigation knowledge is frozen; absent on unfrozen or legacy runs. */
  frozenAt?: string;
  /** Latest sealed epoch number. Absent on runs frozen before epoch machinery existed. */
  knowledgeEpoch?: number;
  /** Digest of the latest immutable knowledge epoch; set together with `frozenAt`. */
  knowledgeDigest?: string;
  metrics: RunMetrics;
  error?: { stage: string; message: string; stack?: string };
}

/**
 * CodeGraph's reach over the run's own corpus, per language.
 *
 * `counted` is the layer-1 ledger's counted row count. That is the denominator law in one field: a published
 * ratio's denominator comes from a ledger recording its own completeness, never from a local predicate. It used
 * to be `files.filter(isLikelySource)` — a hardcoded nine-extension denylist — which made the denominator a
 * THIRD taxonomy beside layer 1's `excluded{unsupported-extension}` and layer 2's per-mechanism extension sets,
 * with nothing reconciling them. On wcp that published "1,639/1,719 = 95.3%" as a fact, and 1,719 appears in no
 * ledger: it is 1,999 counted minus 280 files the denylist happened to name.
 *
 * `byLanguage` is why the aggregate ratio is not the interesting number. The gap it measures is two unrelated
 * things added together: files no code index covers, and files it should have reached and did not. On wcp the
 * 331 unindexed rows are 251 stylesheets/markup/data plus 69 `.js` files — and the index holds 415 OTHER `.js`
 * files, so those 69 are a real gap that no single ratio can show. Split by language it is one row: JavaScript
 * 415/484 next to SCSS 0/109, and the reader draws the conclusion instead of the engine asserting it.
 *
 * The split deliberately carries no "should have been indexed" judgement. Every candidate for one failed on a
 * second target: `partition-ast`'s declared support covers 1,704 of wcp's files but only 192 of provital's
 * 3,005, where the index itself holds 346 — a denominator smaller than its own numerator. Language is a
 * property of the corpus that both targets have; indexability is a property of a tool that varies per run.
 *
 * The grouping uses `corpusResolver().languageOf` with the same `unregistered:<ext>` fallback as
 * `workset/census.ts`, so these rows and the layer-2 `byLanguage` census agree by construction, not by luck.
 */
export interface CodeGraphCoverage {
  indexed: number;
  counted: number;
  /**
   * Index file rows that match no counted ledger row.
   *
   * The numerator's own residual bucket. `indexed` is an intersection, and an intersection hides whatever sits
   * on the index's side of it: a stale index, a wrong root, a path-normalisation mismatch. Zero on all three
   * real targets today — which is exactly why a regression here would go unseen without a field to see it in.
   */
  unmatchedIndexRows: number;
  ratio: number;
  /** Which ledger this denominator is accountable to, embedded rather than re-derived (分母法则). */
  ledgerIdentity: RowSetIdentity;
  /**
   * The counted set partitioned by language. It IS a partition and the partition law applies: the rows' counted
   * values sum to `counted` and their indexed values to `indexed`, enforced by `tests/context.test.ts`. There
   * are no excluded/unexplained buckets here only because the input is already the counted set — not because
   * the rows are exempt from adding up.
   */
  byLanguage: Array<{ language: string; counted: number; indexed: number }>;
}

export interface RunMetrics {
  startedAt: string;
  finishedAt?: string;
  timing: Record<string, number>;
  graphQueries: number;
  graphQueryCacheHits: number;
  sourceWindows: number;
  sourceWindowCacheHits: number;
  sourceCharacters: number;
  sourceSearches: number;
  sourceSearchCacheHits: number;
  sourceFilesSearched: number;
  filesConsidered: number;
  timelineEvents?: number;
  claims?: number;
  traces?: number;
  workItems?: { total: number; complete: number };
  /** Count of post-freeze supplement mutations recorded through the escape hatch. Present only on frozen runs. */
  supplements?: number;
  /**
   * What this run's authorized reads needed from the source-window ceiling, summed from layer 5's own
   * per-spec authorizations at prepare (see `investigation/read-budget.ts`).
   *
   * ABSENCE means NOT MEASURED — never "nothing was needed". A run prepared before this figure existed has
   * no demand to report, and reading its absence as 0 would render "892 windows were required and 60 were
   * available" as "no reading was authorized", which is the opposite fact.
   */
  sourceWindowDemand?: { requiredWindows: number; availableWindows: number; requiredRunWindowBudget: number };
  codegraphCoverage?: CodeGraphCoverage;
  cache: Record<string, "hit" | "miss" | "unused">;
  warnings: string[];
}

export interface GraphFile {
  path: string;
  language: string;
  size: number;
  nodeCount: number;
  errors: string[];
}

/**
 * One audit finding. It lives with the shared types rather than inside any auditor: every side that can audit
 * produces them — the knowledge-side work-item audits, the layer-8 contract audit, the report-side section
 * audits — and a finding type owned by one of them would make the others import across the dependency order
 * just to say what they found.
 */
export interface AuditFinding {
  level: "error" | "warning";
  document: string;
  message: string;
}

export interface GraphNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  docstring: string | null;
  signature: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
  line: number | null;
  metadata: Record<string, unknown>;
}

export type FactPackCategory = "entrypoints" | "entities" | "states" | "config-keys" | "jobs" | "external-calls" | "logic";
export type FactPackMethod = "graph" | "scan" | "graph+scan" | "none";

export interface FactPackItemCore {
  category: FactPackCategory;
  name: string;
  filePath: string;
  line: number;
  endLine?: number;
  detail?: string;
  source: "graph" | "scan";
  /** Deterministic within-category attention order (logic items only): lower = read sooner. */
  rank?: number;
  /** Why this item earned individual attention (logic items only): the structural rescue reason. */
  signal?: string;
}

/** The precision at which the collector actually observed an item; relation membership is recorded separately. */
export type FactPackGranularity = "graph-node" | "source-line";

/**
 * The only association hint the collector may hand to layer 5. A graph item carries the id layer 3 would mint;
 * a scan has no layer-3 fact to join. The hint deliberately carries no path/span fallback.
 */
export type FactPackJoinHint =
  | { kind: "fact"; producer: string; factId: string }
  | { kind: "unjoined"; reason: "kind-not-inventoried" | "no-matching-fact" | "scan-only" };

/** Internal, cached collection result. It is never a run artifact; layer 5 must annotate it before writing. */
export interface CollectedFactPackItem extends FactPackItemCore {
  granularity: FactPackGranularity;
  join: FactPackJoinHint;
}

export type FactPackUnjoinedReason = "kind-not-inventoried" | "no-matching-fact" | "envelope-unavailable" | "scan-only";

/** The layer-3 membership copied verbatim, or a written reason why no such membership can be read. */
export type FactPackMembership =
  | { joined: { factId: string; kind: FactKindId; membership: Membership }; unjoined?: never }
  | { joined?: never; unjoined: { reason: FactPackUnjoinedReason } };

export type FactPackRelation =
  | { kind: "seeded"; basis: "explicit-seed" }
  | { kind: "retained"; basis: "membership-seated" }
  | { kind: "co-located"; basis: FactPackUnjoinedReason | "membership-not-seated" }
  | { kind: "not-applicable"; basis: "registry-not-applicable" };

/** Persisted factpack-v2 row. Every row has one membership outcome and one relation outcome. */
export interface FactPackItem extends FactPackItemCore {
  granularity: FactPackGranularity;
  membership: FactPackMembership;
  relation: FactPackRelation;
}

export interface FactPackCoverage {
  category: FactPackCategory;
  method: FactPackMethod;
  itemCount: number;
  truncated: boolean;
  note?: string;
}

/** The collector's feature-wide enumeration, before layer-4 seats are applied. */
export interface CollectedFeatureFactPack {
  version: "factpack-collected-v1";
  snapshotId: string;
  featureKey: string;
  items: CollectedFactPackItem[];
  coverage: FactPackCoverage[];
  warnings: string[];
}

export interface FeatureFactPack {
  version: "factpack-v2";
  snapshotId: string;
  featureKey: string;
  items: FactPackItem[];
  coverage: FactPackCoverage[];
  warnings: string[];
  relations: {
    total: number;
    seeded: number;
    retained: number;
    coLocated: number;
    notApplicable: number;
    byBasis: Record<string, number>;
  };
}
