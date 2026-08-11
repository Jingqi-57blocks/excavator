import type { CrossFeatureRelationships } from "./cross-feature.ts";

export type Audience = "product" | "engineering";
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
}

export interface ReportRequest {
  target: string;
  codegraph?: string;
  /** Resolved per-module database paths (multi-module targets). Persisted so the snapshot identity — its
   * `codegraphDigest` — is reproducible when `source`/`audit` rebuild the snapshot after preparation. */
  codegraphModules?: string[];
  codegraphMode?: CodeGraphMode;
  language: string;
  detailLevel?: DetailLevel;
  workdir: string;
  overviewAudiences: Audience[];
  features: FeatureRequest[];
  budgets: BudgetConfig;
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
  scannerVersion: string;
  ignoreRulesDigest: string;
  sourceManifestDigest: string;
  codegraphDigest: string | null;
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
  kind: "graph" | "source" | "readme" | "manifest" | "git" | "coverage" | "derived" | "search" | "scope" | "provider" | "limitation";
  title: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  content?: string;
  data?: unknown;
  reason: string;
  digest: string;
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

/** Deterministic freeze-gate report: the machine-readable output of the investigation-side checks. */
export interface KnowledgeCompleteness {
  requiredItems: number;
  disposed: number;
  byStatus: Record<string, number>;
  materialFlowsWithTraces: number;
  warnings: string[];
}

/**
 * `knowledge.json` (knowledge-v1): the frozen fingerprint of a run's investigation plus a completeness
 * report and an append-only supplements ledger. It copies no evidence content and builds no ontology —
 * authoring keeps reading `evidence.json`, `workitems.json`, `traces.json` and `context/*`, which are
 * complete and frozen by this point. Every field except `supplements` is part of the frozen core the
 * `knowledgeDigest` covers; supplements are the one field the escape hatch may append to.
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
  completeness: KnowledgeCompleteness;
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
  /** ISO timestamp stamped by `excavator freeze` when the investigation knowledge is frozen; absent on unfrozen or legacy runs. */
  frozenAt?: string;
  /** Digest of the frozen knowledge core (knowledge.json minus its append-only supplements ledger); set together with `frozenAt`. */
  knowledgeDigest?: string;
  metrics: RunMetrics;
  error?: { stage: string; message: string; stack?: string };
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
  codegraphCoverage?: { indexed: number; eligible: number; ratio: number };
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

export type FactPackCategory = "entrypoints" | "entities" | "states" | "config-keys" | "jobs" | "external-calls";
export type FactPackMethod = "graph" | "scan" | "graph+scan" | "none";

export interface FactPackItem {
  category: FactPackCategory;
  name: string;
  filePath: string;
  line: number;
  endLine?: number;
  detail?: string;
  source: "graph" | "scan";
}

export interface FactPackCoverage {
  category: FactPackCategory;
  method: FactPackMethod;
  itemCount: number;
  truncated: boolean;
  note?: string;
}

export interface FeatureFactPack {
  version: "factpack-v1";
  snapshotId: string;
  featureKey: string;
  items: FactPackItem[];
  coverage: FactPackCoverage[];
  warnings: string[];
}

export interface PreparedContext {
  snapshot: Snapshot;
  evidence: EvidenceItem[];
  sharedMarkdown: string;
  documentContexts: Map<string, string>;
  featureMarkdowns: Map<string, string>;
  featureFactPacks: Map<string, FeatureFactPack>;
  featureScopes: Map<string, { nodes: GraphNode[]; files: string[]; evidenceIds: string[] }>;
  crossFeature: CrossFeatureRelationships;
}
