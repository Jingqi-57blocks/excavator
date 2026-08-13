import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ChecklistItem,
  DocumentPlan,
  EvidenceItem,
  EvidenceMarker,
  FactPackCategory,
  InvestigationChecklist,
  InvestigationPlan,
  InvestigationWorkItem,
  ReportRequest,
  RunManifest,
  SectionClaim,
  SectionClaimsFile,
  TraceCatalog
} from "./types.ts";
import { validateComparisonSides } from "./claim-comparison.ts";
import { exists, nowIso, redactSecrets, REDACTION_VERSION, safeRelative, sha256, stableJson } from "./util.ts";

export interface AuditFinding {
  level: "error" | "warning";
  document: string;
  message: string;
}

/**
 * Version of the strict-assurance contract a run is audited against. It combines a strict-check
 * generation (`v4`) with the redaction marker, so it changes whenever redaction changes or a future
 * batch tightens the strict checks — bump the `v<n>` prefix when adding new strict checks. `v2` added
 * the substantive-section evidence-marker check (C3) on top of `v1`'s source re-derivation gate; `v3`
 * makes freeze a hard precondition of authoring (`begin` refuses an unfrozen run, and audit fails a run
 * that was authored without — or before — an `investigation.frozen` event); `v4` promotes each rescued
 * `logic` fact-pack function into a disposable work item (the plan, freeze expected-plan and audit
 * expected-plan/checklist all expand from that one derivation), so an undisposed material decision
 * function blocks freeze and audit.
 * A run stamps this at prepare (`manifest.assuranceVersion`); audit uses it to gate those strict
 * checks: only runs prepared under the current version are held to them, while older or field-less
 * runs are grandfathered so a later redaction/check bump never retroactively fails them.
 */
export const ASSURANCE_VERSION = `assurance-v4-${REDACTION_VERSION}`;

/** Strict re-derivation checks apply only to runs prepared under exactly the current version. */
export function runUsesCurrentAssurance(manifest: RunManifest): boolean {
  return manifest.assuranceVersion === ASSURANCE_VERSION;
}

/**
 * The assurance GENERATION a run was prepared under — the integer `n` in `assurance-v<n>-...`, decoupled
 * from the redaction suffix. A missing or malformed `assuranceVersion` is generation 0. This is the gate
 * for GENERATIVE expansion of the expected set (adding the run's own baked default items back): it must not
 * hinge on exact-version equality, or a later assurance OR redaction bump would stop re-deriving items that
 * are already baked into a run's `workitems.json`, false-failing every run prepared under this generation.
 * (The strict IDENTITY re-derivation checks keep using `runUsesCurrentAssurance` — those legitimately need
 * exact equality.)
 */
export function assuranceGeneration(manifest: RunManifest): number {
  const match = /^assurance-v(\d+)/.exec(manifest.assuranceVersion ?? "");
  return match ? Number(match[1]) : 0;
}

/** Whether a run was prepared under assurance generation `n` or later (redaction-suffix independent). */
export function assuranceGenerationAtLeast(manifest: RunManifest, n: number): boolean {
  return assuranceGeneration(manifest) >= n;
}

const PROJECT_HYPOTHESES: Array<[string, string]> = [
  ["literal-secrets", "Credentials, private keys, tokens or cryptographic secrets are written as source literals."],
  ["literal-identifiers", "Business behavior compares against literal record, tenant, customer, office, project or role identifiers."],
  ["guard-polarity", "Equivalent authorization checks use inconsistent negation or allow/deny polarity."],
  ["shared-storage", "Multiple independently operated parts write the same stored object or declare it with incompatible shapes."],
  ["duplicate-entrypoints", "The same externally visible entry point is declared by more than one part."],
  ["uncalled-entrypoints", "Registered entry points have no caller inside the analyzed workspace."],
  ["discarded-errors", "Errors from external calls, persistence or asynchronous work are neither returned, logged nor persisted."],
  ["deprecated-or-unfinished", "Current paths contain explicit deprecated, disabled, unfinished or temporary behavior."],
  ["feature-switches", "Configuration switches materially change which capabilities or background work are available."],
  ["documentation-drift", "Repository documentation contradicts current manifests, entry points or implementation."],
  ["external-call-in-transaction", "An external call occurs while a persistence transaction remains open."],
  ["open-investigation", "The observed facts suggest a material question not covered by the predefined hypotheses."]
];

const FEATURE_HYPOTHESES: Array<[string, string, number]> = [
  ["boundary", "The capability boundary, participating repositories, included files and deliberately excluded neighboring behavior are established.", 1],
  ["ui-entrypoints", "User-facing pages, actions and visible UI entry points are inventoried.", 2],
  ["api-entrypoints", "HTTP, command, callback and public entry points are inventoried with handler resolution.", 2],
  ["scheduled-entrypoints", "Scheduled, startup and automated entry points are inventoried.", 2],
  ["callers", "Workspace-visible callers and the boundary of possible external callers are investigated.", 2],
  ["normal-flow", "The normal end-to-end execution flow is established from entry to persistence and response.", 3],
  ["decision-flow", "Approval, rejection or other decision branches are established as ordered traces.", 3],
  ["reversal-flow", "Cancellation, withdrawal, rollback or reversal behavior is established as an ordered trace.", 3],
  ["type-variants", "All material business types, categories or variants and their distinct behavior are inventoried.", 4],
  ["states-and-lifecycle", "States, transitions, terminal states and reversal transitions are inventoried.", 4],
  ["calculations-and-thresholds", "Calculations, numeric/date thresholds, regional differences and boundary values are investigated.", 4],
  ["validation-and-duplicates", "Required values, uniqueness, duplicate submission and idempotency behavior are investigated.", 4],
  ["authorization", "Declared middleware and inline authorization checks are distinguished and investigated.", 5],
  ["data-scope", "Object-level and list-query data scope rules are investigated by role and action.", 5],
  ["entities-and-fields", "Core records, relationships and material fields are inventoried.", 6],
  ["data-and-shared-storage", "Readers, writers, transactions and cross-part shared storage are investigated.", 6],
  ["model-parity", "Different runtime parts declaring the same stored object are compared for visible shape differences.", 6],
  ["files-and-integrations", "Files, object storage and external integrations are inventoried with transferred data categories.", 7],
  ["notifications-and-exports", "Notifications, exports, messages and other observable side effects are inventoried.", 7],
  ["failure-modes", "Invalid input, missing records, external failure and error propagation paths are investigated.", 8],
  ["transactions-and-partial-success", "Transaction boundaries, asynchronous work, retries, concurrency and partial-success behavior are investigated.", 8],
  ["configuration", "Configuration keys, defaults, switches and environment-dependent behavior are investigated.", 9],
  ["background-work", "Background jobs, schedules, startup work and multi-instance coordination evidence are investigated.", 9],
  ["connected-change-scope", "Callers, callees, shared records, adjacent capabilities and cross-repository reachability are inventoried.", 10],
  ["tests", "Tests are mapped to material journeys, rules and failure branches; searched gaps retain receipts.", 11],
  ["documentation-drift", "Documentation and generated API descriptions are compared with current entry points and implementation.", 11],
  ["unfinished-and-current-problems", "Explicitly unfinished code, contradictions, duplicate implementations and locatable current problems are investigated.", 11],
  ["coverage-accounting", "Graph, source, evidence, file and unresolved-reference coverage is quantified with exclusions.", 12],
  ["open-investigation", "The feature facts suggest a material question not covered by the predefined hypotheses.", 12]
];

export function createInvestigationChecklist(runId: string, request: ReportRequest): InvestigationChecklist {
  const items: ChecklistItem[] = [];
  if (request.overviewAudiences.length) {
    for (const [name, hypothesis] of PROJECT_HYPOTHESES) items.push(pendingItem(`project:${name}`, "project", hypothesis, name === "open-investigation" ? "open" : "default"));
  }
  const seen = new Set<string>();
  for (const feature of request.features) {
    const key = featureScopeKey(feature.subject, feature.aliases);
    if (seen.has(key)) continue;
    seen.add(key);
    const scope = `feature:${key}`;
    const detailed = (request.detailLevel ?? "detailed") === "detailed";
    for (const [name, hypothesis] of FEATURE_HYPOTHESES) items.push(pendingItem(
      `${scope}:${name}`,
      scope,
      hypothesis,
      name === "open-investigation" ? "open" : "default",
      detailed && name !== "open-investigation"
    ));
  }
  return { version: 1, runId, items };
}

function pendingItem(id: string, scope: string, hypothesis: string, origin: ChecklistItem["origin"], material = false): ChecklistItem {
  return { id, scope, hypothesis, verdict: "pending", material, evidenceIds: [], origin };
}

export function mergeChecklist(existing: InvestigationChecklist, updates: Partial<ChecklistItem>[]): InvestigationChecklist {
  const byId = new Map(existing.items.map((item) => [item.id, { ...item }]));
  for (const update of updates) {
    if (!update.id) throw new Error("Checklist update is missing id");
    const current = byId.get(update.id);
    if (!current) {
      if (update.origin !== "open") throw new Error(`Unknown checklist item: ${update.id}`);
      if (!update.scope || !update.hypothesis) throw new Error(`Open checklist item ${update.id} requires scope and hypothesis`);
      byId.set(update.id, {
        id: update.id,
        scope: update.scope,
        hypothesis: update.hypothesis,
        verdict: update.verdict ?? "pending",
        material: update.material ?? false,
        evidenceIds: update.evidenceIds ?? [],
        searchScope: update.searchScope,
        reason: update.reason,
        settledBy: update.settledBy,
        origin: "open"
      });
      continue;
    }
    byId.set(update.id, {
      ...current,
      ...update,
      id: current.id,
      scope: current.scope,
      hypothesis: current.hypothesis,
      origin: current.origin,
      evidenceIds: update.evidenceIds ?? current.evidenceIds
    });
  }
  return { ...existing, items: [...byId.values()] };
}


export function createInvestigationPlan(runId: string, request: ReportRequest, documents: DocumentPlan[]): InvestigationPlan {
  const checklist = createInvestigationChecklist(runId, request);
  const items = checklist.items.map((item): InvestigationWorkItem => ({
    id: item.id,
    dimension: item.id.split(":").at(-1) ?? item.id,
    scope: item.scope,
    hypothesis: item.hypothesis,
    status: "pending",
    material: item.material,
    requiredFor: documents.filter((document) => requiredForScope(document, item.scope)).map((document) => document.id),
    evidenceIds: [],
    traceIds: [],
    reportSection: item.scope.startsWith("feature:") ? FEATURE_HYPOTHESES.find(([name]) => name === (item.id.split(":").at(-1) ?? ""))?.[2] : undefined,
    origin: item.origin
  }));
  return { version: 1, runId, createdAt: nowIso(), items };
}

export function mergeWorkItems(existing: InvestigationPlan, updates: Partial<InvestigationWorkItem>[]): InvestigationPlan {
  const byId = new Map(existing.items.map((item) => [item.id, { ...item }]));
  for (const update of updates) {
    if (!update.id) throw new Error("Work item update is missing id");
    const current = byId.get(update.id);
    if (!current) {
      if (update.origin !== "open" || !update.scope || !update.hypothesis) throw new Error(`Unknown work item: ${update.id}`);
      byId.set(update.id, {
        id: update.id,
        dimension: update.dimension ?? update.id.split(":").at(-1) ?? update.id,
        scope: update.scope,
        hypothesis: update.hypothesis,
        status: update.status ?? "pending",
        material: update.material ?? false,
        requiredFor: update.requiredFor ?? [],
        evidenceIds: update.evidenceIds ?? [],
        traceIds: update.traceIds ?? [],
        reportSection: update.reportSection,
        searchScope: update.searchScope,
        reason: update.reason,
        settledBy: update.settledBy,
        origin: "open",
        startedAt: update.startedAt,
        completedAt: update.completedAt,
        supersedes: update.supersedes
      });
      continue;
    }
    const status = update.status ?? current.status;
    byId.set(update.id, {
      ...current,
      ...update,
      id: current.id,
      dimension: current.dimension,
      scope: current.scope,
      hypothesis: current.hypothesis,
      origin: current.origin,
      requiredFor: current.requiredFor,
      status,
      evidenceIds: update.evidenceIds ?? current.evidenceIds,
      traceIds: update.traceIds ?? current.traceIds,
      startedAt: update.startedAt ?? current.startedAt ?? (status !== "pending" ? nowIso() : undefined),
      completedAt: update.completedAt ?? (isCompleteWorkItem(status) ? nowIso() : undefined)
    });
  }
  return { ...existing, items: [...byId.values()] };
}

export function checklistUpdatesToWorkItems(updates: Partial<ChecklistItem>[]): Partial<InvestigationWorkItem>[] {
  return updates.map((item) => ({
    id: item.id,
    status: item.verdict == null ? undefined : checklistVerdictToStatus(item.verdict),
    material: item.material,
    evidenceIds: item.evidenceIds,
    searchScope: item.searchScope,
    reason: item.reason,
    settledBy: item.settledBy,
    origin: item.origin
  }));
}

export function workItemsToChecklist(plan: InvestigationPlan): InvestigationChecklist {
  return {
    version: 1,
    runId: plan.runId,
    items: plan.items.map((item) => ({
      id: item.id,
      scope: item.scope,
      hypothesis: item.hypothesis,
      verdict: workItemStatusToVerdict(item.status),
      material: item.material,
      evidenceIds: item.evidenceIds,
      searchScope: item.searchScope,
      reason: item.reason,
      settledBy: item.settledBy,
      origin: item.origin
    }))
  };
}

export async function auditEvidenceCatalog(manifest: RunManifest, evidence: EvidenceItem[]): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    if (seen.has(item.id)) findings.push(error("evidence", `duplicate evidence id: ${item.id}`));
    seen.add(item.id);
    if (!manifest.snapshot) {
      findings.push(error("evidence", `run has no snapshot for evidence ${item.id}`));
      continue;
    }
    if (item.snapshotId !== manifest.snapshot.id) findings.push(error("evidence", `${item.id} belongs to snapshot ${item.snapshotId || "<missing>"}, expected ${manifest.snapshot.id}`));
    if (item.content != null) {
      findings.push(...await auditSourceEvidence(manifest, item));
      continue;
    }
    if (item.data === undefined) {
      findings.push(error("evidence", `${item.id} has neither source content nor structured data`));
      continue;
    }
    const actual = sha256(stableJson(item.data));
    if (actual !== item.digest) findings.push(error("evidence", `${item.id} structured-data digest does not match its stored data`));
  }
  return findings;
}

async function auditSourceEvidence(manifest: RunManifest, item: EvidenceItem): Promise<AuditFinding[]> {
  // Legacy runs predate the current redaction/strict-check version. Re-deriving the redacted window
  // with today's logic would spuriously fail them, so grandfather the re-derivation checks and
  // instead verify the archived excerpt against its own stored digest: catalog tampering is still
  // caught, without reading a source file that may have drifted since the run was created.
  if (!runUsesCurrentAssurance(manifest)) {
    if (item.content != null && sha256(item.content) !== item.digest) {
      return [error("evidence", `${item.id} stored excerpt does not match its own recorded digest`)];
    }
    return [];
  }
  const findings: AuditFinding[] = [];
  if (!item.path || item.startLine == null || item.endLine == null) return [error("evidence", `${item.id} source evidence is missing path or line range`)];
  const absolute = resolve(manifest.request.target, item.path);
  try { safeRelative(manifest.request.target, absolute); } catch { return [error("evidence", `${item.id} source path escapes the target: ${item.path}`)]; }
  if (!await exists(absolute)) return [error("evidence", `${item.id} source file no longer exists: ${item.path}`)];
  let raw: string;
  try { raw = await readFile(absolute, "utf8"); } catch { return [error("evidence", `${item.id} source file is not readable text: ${item.path}`)]; }
  const lines = raw.split(/\r?\n/);
  if (item.startLine < 1 || item.endLine < item.startLine || item.endLine > lines.length) {
    return [error("evidence", `${item.id} has invalid source range ${item.startLine}-${item.endLine}; file has ${lines.length} lines`)];
  }
  const selected = redactSecrets(lines.slice(item.startLine - 1, item.endLine).join("\n"));
  const digest = sha256(selected);
  if (digest !== item.digest) findings.push(error("evidence", `${item.id} source digest is stale for ${item.path}:${item.startLine}-${item.endLine}`));
  if (selected !== item.content) findings.push(error("evidence", `${item.id} stored excerpt does not match the current redacted source window`));
  return findings;
}

export function auditSectionClaims(options: {
  documentId: string;
  sectionIndex: number;
  sectionText: string;
  claimsFile: SectionClaimsFile | null;
  evidenceIds: Set<string>;
  traceIds?: Set<string>;
}): AuditFinding[] {
  const { documentId, sectionIndex, sectionText, claimsFile, evidenceIds, traceIds = new Set<string>() } = options;
  const findings: AuditFinding[] = [];
  const visible = visibleText(sectionText);
  const segments = substantiveSegments(sectionText);
  const markers = markersIn(visible);
  const cited = evidenceIdsInSection(sectionText, evidenceIds);
  if (!claimsFile) {
    if (!segments.length && !markers.size && !cited.size) return findings;
    return [error(documentId, `section ${sectionIndex} has substantive statements but no claims file`)];
  }
  if (!claimsFile.claims.length && segments.length) findings.push(error(documentId, `section ${sectionIndex} has substantive statements but an empty claims file`));
  if (claimsFile.documentId !== documentId || claimsFile.section !== sectionIndex) findings.push(error(documentId, `section ${sectionIndex} claims metadata points to ${claimsFile.documentId} section ${claimsFile.section}`));
  const claimIds = new Set<string>();
  const declaredEvidence = new Set<string>();
  const claimMarkers = new Set<EvidenceMarker>();
  for (const claim of claimsFile.claims) {
    findings.push(...auditClaim(documentId, sectionIndex, visible, claim, evidenceIds, traceIds));
    if (claimIds.has(claim.id)) findings.push(error(documentId, `section ${sectionIndex} has duplicate claim id ${claim.id}`));
    claimIds.add(claim.id);
    claimMarkers.add(claim.marker);
    for (const id of claim.evidenceIds ?? []) declaredEvidence.add(id);
  }
  const normalizedClaims = claimsFile.claims.map((claim) => normalizeText(claim.statement)).filter(Boolean);
  for (const segment of segments) {
    const covered = normalizedClaims.some((statement) => statement.includes(segment) || segment.includes(statement));
    if (!covered) findings.push(error(documentId, `section ${sectionIndex} has an unclaimed substantive statement: ${segment.slice(0, 120)}`));
  }
  for (const marker of markers) if (!claimMarkers.has(marker)) findings.push(error(documentId, `section ${sectionIndex} contains ${marker} wording but declares no ${marker} claim`));
  for (const id of cited) if (!declaredEvidence.has(id)) findings.push(error(documentId, `section ${sectionIndex} cites ${id} but no section claim declares it`));
  for (const id of declaredEvidence) if (!cited.has(id)) findings.push(error(documentId, `section ${sectionIndex} claim declares ${id}, but the section evidence block does not cite it`));
  return findings;
}

function evidenceIdsInSection(sectionText: string, knownEvidenceIds: Set<string>): Set<string> {
  const cited = new Set<string>();
  for (const id of knownEvidenceIds) if (sectionText.includes(id)) cited.add(id);
  // The id body must end on a letter or digit: a trailing separator is never part of an id,
  // and letting one in turns `<!--E:S-d59eb3a823-->` into the pseudo id `S-d59eb3a823--`.
  const pattern = /(?<![\p{L}\p{N}_])((?:S|CG|FG|GIT|SEARCH|SCOPE|PROVIDER|FACT)-[\p{L}\p{N}](?:[\p{L}\p{N}._:-]*[\p{L}\p{N}])?)(?![\p{L}\p{N}_.:-])/gu;
  for (const match of sectionText.matchAll(pattern)) cited.add(match[1]);
  return cited;
}

function auditClaim(documentId: string, sectionIndex: number, visible: string, claim: SectionClaim, evidenceIds: Set<string>, traceIds: Set<string>): AuditFinding[] {
  const findings: AuditFinding[] = [];
  if (!claim.id.trim()) findings.push(error(documentId, `section ${sectionIndex} has a claim with no id`));
  const statement = normalizeText(claim.statement);
  if (statement.length < 6) findings.push(error(documentId, `claim ${claim.id || "<missing>"} statement is too short to bind to report prose`));
  else if (!normalizeText(visible).includes(statement)) findings.push(error(documentId, `claim ${claim.id} statement is not present in section ${sectionIndex}`));
  if (claim.marker === "unavailable") {
    if (claim.evidenceIds?.length) findings.push(error(documentId, `unavailable claim ${claim.id} must not cite evidence ids`));
    if (!claim.reason?.trim()) findings.push(error(documentId, `unavailable claim ${claim.id} requires a reason`));
  } else {
    if (!claim.evidenceIds?.length) findings.push(error(documentId, `${claim.marker} claim ${claim.id} requires evidence ids`));
    for (const id of claim.evidenceIds ?? []) if (!evidenceIds.has(id)) findings.push(error(documentId, `claim ${claim.id} references missing evidence id ${id}`));
  }
  for (const id of claim.traceIds ?? []) if (!traceIds.has(id)) findings.push(error(documentId, `claim ${claim.id} references missing trace id ${id}`));
  if (claim.status === "verified" && claim.confidence === "low") findings.push(error(documentId, `verified claim ${claim.id} cannot have low confidence`));
  return findings;
}

export function auditChecklist(checklist: InvestigationChecklist, expected: InvestigationChecklist, evidenceById: Map<string, EvidenceItem>): AuditFinding[] {
  const evidenceIds = new Set(evidenceById.keys());
  const findings: AuditFinding[] = [];
  const expectedIds = new Set(expected.items.map((item) => item.id));
  const seen = new Set<string>();
  for (const item of checklist.items) {
    if (seen.has(item.id)) findings.push(error("checklist", `duplicate checklist item: ${item.id}`));
    seen.add(item.id);
    if (!expectedIds.has(item.id) && item.origin !== "open") findings.push(error("checklist", `unexpected non-open checklist item: ${item.id}`));
    if (item.verdict === "pending") findings.push(error("checklist", `checklist item was not dispositioned: ${item.id}`));
    if (item.verdict === "hit") {
      if (!item.evidenceIds.length) findings.push(error("checklist", `hit checklist item has no evidence: ${item.id}`));
    } else if (item.verdict === "searched-not-found") {
      if (!item.searchScope?.trim()) findings.push(error("checklist", `searched-not-found item has no search scope: ${item.id}`));
      if (!item.evidenceIds.length) findings.push(error("checklist", `searched-not-found item has no search receipt evidence: ${item.id}`));
      const receipts = item.evidenceIds.map((id) => evidenceById.get(id)).filter((evidence): evidence is EvidenceItem => evidence?.kind === "search");
      if (!receipts.length) findings.push(error("checklist", `searched-not-found item cites no SEARCH receipt: ${item.id}`));
      for (const receipt of receipts) {
        const data = receipt.data as Record<string, unknown> | undefined;
        const matches = Array.isArray(data?.matches) ? data.matches : null;
        if (!data || Number(data.candidateFiles ?? 0) <= 0) findings.push(error("checklist", `search receipt ${receipt.id} covered no candidate files for ${item.id}`));
        if (data?.truncated === true) findings.push(error("checklist", `search receipt ${receipt.id} was truncated and cannot support searched-not-found for ${item.id}`));
        if (!matches) findings.push(error("checklist", `search receipt ${receipt.id} has no matches array for ${item.id}`));
        else if (matches.length) findings.push(error("checklist", `search receipt ${receipt.id} contains matches and cannot support searched-not-found for ${item.id}`));
      }
    } else if (item.verdict === "cannot-determine") {
      if (!item.reason?.trim() || !item.settledBy?.trim()) findings.push(error("checklist", `cannot-determine item requires reason and settledBy: ${item.id}`));
      if (!item.evidenceIds.length) findings.push(error("checklist", `cannot-determine item has no evidence for the analysis limitation: ${item.id}`));
      const limitationKinds = new Set(["search", "coverage", "graph", "manifest", "git"]);
      if (item.evidenceIds.length && !item.evidenceIds.some((id) => limitationKinds.has(evidenceById.get(id)?.kind ?? ""))) {
        findings.push(error("checklist", `cannot-determine item cites no coverage, graph, manifest, git or search evidence: ${item.id}`));
      }
    } else if (item.verdict === "not-applicable") {
      // A not-applicable item is a valid disposition backed only by a reason, mirroring the work-item
      // contract (auditWorkItems); it is not the strict analysis-limitation shape of cannot-determine.
      if (!item.reason?.trim()) findings.push(error("checklist", `not-applicable item requires a reason: ${item.id}`));
    }
    for (const id of item.evidenceIds) if (!evidenceIds.has(id)) findings.push(error("checklist", `checklist item ${item.id} references missing evidence id ${id}`));
  }
  for (const id of expectedIds) if (!seen.has(id)) findings.push(error("checklist", `required checklist item is missing: ${id}`));
  return findings;
}



const ANALYSIS_METHOD_TERMS: Array<RegExp> = [
  /\bCodeGraph\b/i,
  /\bExcavator\b/i,
  /unresolved[ -]?(?:reference|edge|relation)s?/i,
  /未解析(?:引用|关系|边)/,
  /源码回退|source fallback/i,
  /source window|源码窗口/i,
  /provider (?:coverage|selection|mode)|provider 覆盖|提供方覆盖/i,
  /candidate (?:node|file)s?|候选(?:节点|文件)/i,
  /graph coverage|图覆盖/i,
  /analysis (?:budget|performance|limitation)|分析(?:预算|性能|限制|不足)/i,
  /static[- ]review limitation|静态(?:审阅|分析)(?:限制|不足)/i,
  /handler[- ]resolution|处理角色解析|路由解析能力/i
];

export function auditTargetProblemAttribution(options: {
  document: DocumentPlan;
  sectionIndex: number;
  sectionText: string;
}): AuditFinding[] {
  const { document, sectionIndex, sectionText } = options;
  // Feature reports now carry a standalone "Current problems found" chapter at §11 for both audiences
  // (product problems split out of the old §10 connected-scope chapter; engineering was already §11).
  // Overviews keep their problem chapter in place: product §9, engineering §11.
  const problemSection = document.kind === "overview"
    ? (document.audience === "product" ? 9 : 11)
    : 11;
  if (sectionIndex !== problemSection) return [];
  const visible = visibleText(sectionText);
  const findings: AuditFinding[] = [];
  for (const pattern of ANALYSIS_METHOD_TERMS) {
    pattern.lastIndex = 0;
    if (pattern.test(visible)) findings.push(error(document.id, `section ${sectionIndex} contains analysis-method information in a target problem section: ${pattern}`));
  }
  return findings;
}

/**
 * Advisory readability nudge (warning-only; NOT version-gated; does NOT touch the hard path).
 *
 * The engineering-FEATURE detailed path already HARD-requires inventory/comparison tables via
 * `auditDetailedFeatureSection`. The other three document contracts — product feature, product
 * overview, engineering overview — carried no table requirement at all, which is why their reports
 * came out as walls of prose. For a designated inventory/comparison section that has substantive
 * prose but no Markdown table in its reading flow, this emits a single `warning`. It never emits an
 * `error`, never gates on `ASSURANCE_VERSION`, and never runs for engineering-feature documents.
 *
 * The per-(kind, audience) section-index sets below (1-based, indices as they appear in the four
 * reference templates) list only the clearly-tabular inventory/comparison chapters. Deliberately
 * omitted: narrative openings (purpose/boundary), ordered journeys/flows and runtime topology
 * (Mermaid's job), pure-risk problem prose with no inventory, and the coverage/analysis-boundary
 * meta-chapters. A tests-and-problems chapter is included only where it carries a tests/documentation
 * inventory (the engineering templates), not a product report's pure-risk chapter.
 */
const READABILITY_TABLE_SECTIONS: Record<string, Set<number>> = {
  // product-overview.md §2 system parts, §3 capability map, §4 roles/permission boundary,
  // §5 business objects+states, §7 external dependencies, §8 back-office capabilities.
  // Omitted: §1 purpose, §6 data movement (a flow narrative), §9 pure risks, §10 coverage.
  "overview:product": new Set([2, 3, 4, 5, 7, 8]),
  // engineering-overview.md §2 repositories/units, §3 stack, §5 interfaces/entry points,
  // §7 data models/storage, §8 identity/auth, §9 external integrations, §10 config/jobs,
  // §11 tests+problems (tests inventory), §13 database design (per-table column tables).
  // Omitted: §1 purpose/snapshot, §4 topology (Mermaid), §6 call structure (graph), §12 coverage.
  "overview:engineering": new Set([2, 3, 5, 7, 8, 9, 10, 11, 13]),
  // product-feature.md §3 rules, §5 role-by-action, §6 data/fields, §7 side effects,
  // §8 failure modes, §9 config/switches, §13 glossary (glossary moved from §11 after the problem
  // chapter split). Omitted: §1 boundary, §2 journey (flow), §4 states (Mermaid state diagram is
  // mandated there), §10 connected scope, §11 current problems (table-or-list, like product-overview
  // §9), §12 coverage.
  "feature:product": new Set([3, 5, 6, 7, 8, 9, 13])
  // "feature:engineering" is intentionally absent: it stays on the hard `auditDetailedFeatureSection` path.
};

export function auditReadabilityTables(options: {
  document: DocumentPlan;
  sectionIndex: number;
  sectionText: string;
}): AuditFinding[] {
  const { document, sectionIndex, sectionText } = options;
  const sections = READABILITY_TABLE_SECTIONS[`${document.kind}:${document.audience}`];
  if (!sections || !sections.has(sectionIndex)) return [];
  // Only nudge a chapter that actually carries inventory-style prose; a heading-only or empty section
  // has nothing to tabulate. Reuse the same substantive-segment primitive the claim audit relies on.
  if (!substantiveSegments(sectionText).length) return [];
  // Reuse the exact table regex and visible-text scope the engineering-feature hard path uses, so a
  // table living only inside a collapsed evidence block does not count as a tabular reading flow.
  if (/^\s*\|.+\|\s*$/m.test(visibleText(sectionText))) return [];
  return [warning(document.id, `section ${sectionIndex} is an inventory/comparison chapter with no Markdown table; consider presenting the items as a table (advisory)`)];
}

const EVIDENCE_LEVEL_LEAD_IN = /^\**\s*(?:Evidence level|证据级别)\s*\**\s*[:：]/i;
const EVIDENCE_MARKER_WORD = /`?(?:事实|验证|推断|不可得)`?|`?\b(?:fact|verified|inferred|unavailable)\b`?/gi;

/**
 * Advisory marker-placement nudge (warning-only; NOT version-gated; NOT on the hard path). It does NOT
 * touch the `markersIn`/`visibleText` evidence-level accounting — it only reads the visible reading
 * flow to catch a marker that has drifted off the statement it should qualify.
 *
 * The writing rules require a marker to ride at the end of the statement it qualifies, or to sit in the
 * qualified table cell / a dedicated level column — never as its own line and never behind an
 * "Evidence level:" lead-in. A marker stranded on its own line reads as a floating label. When a
 * visible line's only semantic content is a marker (or such a lead-in), this emits one `warning` for
 * the section. It never emits an `error` and never gates on ASSURANCE_VERSION, so it can never fail a
 * run or retroactively fail an older one.
 */
export function auditEvidenceMarkerPlacement(options: {
  document: DocumentPlan;
  sectionIndex: number;
  sectionText: string;
}): AuditFinding[] {
  const { document, sectionIndex, sectionText } = options;
  for (const line of visibleText(sectionText).split(/\r?\n/)) {
    if (isStandaloneMarkerLine(line)) {
      return [warning(document.id, `section ${sectionIndex} places an evidence marker on its own line or behind an "Evidence level:" lead-in; attach the marker at the end of the statement it qualifies or in the qualified table cell (advisory)`)];
    }
  }
  return [];
}

/** A visible line whose only semantic content is an evidence marker or an "Evidence level:" lead-in. */
function isStandaloneMarkerLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const withoutLeadIn = trimmed.replace(EVIDENCE_LEVEL_LEAD_IN, " ");
  const hadLeadIn = withoutLeadIn !== trimmed;
  const withoutMarkers = withoutLeadIn.replace(EVIDENCE_MARKER_WORD, " ");
  const hadMarker = withoutMarkers !== withoutLeadIn;
  if (!hadLeadIn && !hadMarker) return false;
  const semantic = (normalizeText(withoutMarkers).match(/[\p{Letter}\p{Number}]/gu) ?? []).length;
  return semantic === 0;
}

export function auditDetailedFeatureSection(options: {
  document: DocumentPlan;
  detailLevel: "standard" | "detailed" | undefined;
  sectionIndex: number;
  sectionText: string;
  claimsFile: SectionClaimsFile | null;
  factEvidence?: EvidenceItem[];
}): AuditFinding[] {
  const { document, detailLevel, sectionIndex, sectionText, claimsFile, factEvidence } = options;
  if ((detailLevel ?? "detailed") !== "detailed" || document.kind !== "feature" || document.audience !== "engineering") return [];
  const minimumClaims = [0, 6, 8, 6, 16, 8, 8, 7, 7, 6, 7, 7, 6];
  const findings: AuditFinding[] = [];
  const count = claimsFile?.claims.length ?? 0;
  if (count < minimumClaims[sectionIndex]) findings.push(error(document.id, `detailed section ${sectionIndex} has ${count} claims; minimum is ${minimumClaims[sectionIndex]}`));
  const tableSections = new Set([1, 2, 4, 5, 6, 7, 8, 9, 11, 12]);
  const diagramSections = new Set([3, 10]);
  if (tableSections.has(sectionIndex) && !/^\s*\|.+\|\s*$/m.test(visibleText(sectionText))) findings.push(error(document.id, `detailed section ${sectionIndex} requires an inventory or comparison table`));
  if (diagramSections.has(sectionIndex) && !/```mermaid[\s\S]*?```/i.test(sectionText)) findings.push(error(document.id, `detailed section ${sectionIndex} requires a Mermaid flow or dependency diagram`));
  findings.push(...reconcileFactPack(document, sectionIndex, sectionText, factEvidence ?? []));
  return findings;
}

/** The enumerating chapter that must cover each fact pack category; other sections reconcile nothing. */
const FACT_PACK_SECTIONS: Record<number, FactPackCategory[]> = {
  2: ["entrypoints"],
  4: ["states"],
  6: ["entities"],
  7: ["external-calls"],
  9: ["config-keys", "jobs"]
};

/**
 * Advisory enumeration reconciliation: the enumerating chapter must represent every fact pack item of
 * the categories it owns. Under-coverage is a warning, never an error, and only non-truncated
 * categories are enforced — a truncated category (e.g. a 405-item entrypoint boundary) is already
 * declared incomplete, so holding the prose to it would flood the report. An absent fact pack (older
 * run, no `FACT-*` evidence passed) reconciles nothing.
 */
function reconcileFactPack(document: DocumentPlan, sectionIndex: number, sectionText: string, factEvidence: EvidenceItem[]): AuditFinding[] {
  const categories = FACT_PACK_SECTIONS[sectionIndex];
  if (!categories || !factEvidence.length) return [];
  const findings: AuditFinding[] = [];
  for (const category of categories) {
    const data = factEvidence.find((item) => (item.data as { category?: string } | undefined)?.category === category)?.data as
      | { items?: Array<{ name?: string; filePath?: string; line?: number }>; coverage?: { truncated?: boolean } }
      | undefined;
    if (!data || data.coverage?.truncated) continue;
    const uncovered = (data.items ?? []).filter((item) => !factItemCovered(sectionText, item));
    if (!uncovered.length) continue;
    const sample = uncovered.slice(0, 5).map((item) => item.name || `${item.filePath ?? "?"}:${item.line ?? "?"}`).join(", ");
    findings.push(warning(document.id, `detailed section ${sectionIndex} enumeration under-covers fact pack category ${category}: ${uncovered.length} item(s) not represented (e.g. ${sample})`));
  }
  return findings;
}

/** Lenient by design: any mention of the item name or its `path:line` location counts as coverage. */
function factItemCovered(sectionText: string, item: { name?: string; filePath?: string; line?: number }): boolean {
  const name = (item.name ?? "").trim();
  const path = (item.filePath ?? "").trim();
  if (name.length >= 3 && sectionText.includes(name)) return true;
  if (path && item.line != null && sectionText.includes(`${path}:${item.line}`)) return true;
  return false;
}

/**
 * Document-level advisory (warning-only): every rescued-signal `logic` fact — a business/decision function
 * the boundary fix pulled in that carries a `signal` — should be represented somewhere in the assembled
 * report. Unlike the per-section fact-pack reconciliation, this is document-scoped: logic items may
 * legitimately land in §3/§4/§5, so a per-section check would false-warn across sections. It reuses the
 * loose `factItemCovered` matching (name or path:line mention) and is self-gated: a run with no logic
 * evidence, no rescued items, or no report reconciles nothing. Consistent with the "enumeration
 * reconciliation is advisory, never a hard gate" ruling.
 */
export function auditRescuedLogicCoverage(documentId: string, reportText: string, factEvidence: EvidenceItem[]): AuditFinding[] {
  const logic = factEvidence.find((item) => (item.data as { category?: string } | undefined)?.category === "logic")?.data as
    | { items?: Array<{ name?: string; filePath?: string; line?: number; signal?: string }> }
    | undefined;
  if (!logic) return [];
  const rescued = (logic.items ?? []).filter((item) => typeof item.signal === "string" && item.signal.length);
  const uncovered = rescued.filter((item) => !factItemCovered(reportText, item));
  if (!uncovered.length) return [];
  const sample = uncovered.slice(0, 5).map((item) => item.name || `${item.filePath ?? "?"}:${item.line ?? "?"}`).join(", ");
  return [warning(documentId, `report does not represent ${uncovered.length} rescued logic fact(s) that need individual disposition (e.g. ${sample})`)];
}

/**
 * Coverage findings split into two kinds. Claim-attribution defects (a claim pointing at an
 * unknown work item, a document it is not required for, or the wrong section) are always errors:
 * they are detectable from the single document under audit, so they run for every document passed,
 * complete or not. Completeness findings (a material work item that no claim represents) assert
 * something about the WHOLE requested document set: a caller auditing a partial or single-document
 * scope passes `coverageLevel: "warning"` to keep them advisory, and passes `completeDocumentIds`
 * so completeness is certified only for documents whose sections are all checkpointed — an
 * incomplete document is still attribution-checked but never reported as falsely under-covered.
 */
export function auditWorkItemClaimCoverage(plan: InvestigationPlan, documents: DocumentPlan[], claimsByDocument: Map<string, Array<{ section: number; claim: SectionClaim }>>, options: { coverageLevel?: "error" | "warning"; completeDocumentIds?: Set<string> } = {}): AuditFinding[] {
  const coverageLevel = options.coverageLevel ?? "error";
  const coverage = (document: string, message: string): AuditFinding => ({ level: coverageLevel, document, message });
  const findings: AuditFinding[] = [];
  const items = new Map(plan.items.map((item) => [item.id, item]));
  for (const document of documents) {
    const claims = claimsByDocument.get(document.id) ?? [];
    for (const { section, claim } of claims) {
      for (const id of claim.workItemIds ?? []) {
        const item = items.get(id);
        if (!item) { findings.push(error(document.id, `claim ${claim.id} references unknown work item ${id}`)); continue; }
        if (!item.requiredFor.includes(document.id)) findings.push(error(document.id, `claim ${claim.id} references work item ${id} that is not required for this document`));
        if (item.reportSection && item.reportSection !== section) findings.push(error(document.id, `claim ${claim.id} links work item ${id} to section ${section}, expected section ${item.reportSection}`));
      }
    }
    // Completeness certifies the full requested set; skip it for a document the caller marks incomplete.
    if (options.completeDocumentIds && !options.completeDocumentIds.has(document.id)) continue;
    for (const item of plan.items.filter((candidate) => candidate.material && candidate.requiredFor.includes(document.id) && candidate.origin !== "open")) {
      const linked = claims.filter(({ claim }) => (claim.workItemIds ?? []).includes(item.id));
      if (!linked.length) { findings.push(coverage(document.id, `material work item ${item.id} is not represented by any report claim`)); continue; }
      if (item.status === "found") {
        const grounded = linked.some(({ claim }) => (claim.evidenceIds ?? []).some((id) => item.evidenceIds.includes(id)) || (claim.traceIds ?? []).some((id) => item.traceIds.includes(id)));
        if (!grounded) findings.push(coverage(document.id, `claims for material work item ${item.id} do not reuse its evidence or trace`));
      }
      if (item.status === "searched-not-found" && !linked.some(({ claim }) => claim.marker === "verified" && (claim.evidenceIds ?? []).some((id) => item.evidenceIds.includes(id)))) {
        findings.push(coverage(document.id, `searched-not-found work item ${item.id} requires a linked verified claim using its search receipt`));
      }
      if (["cannot-determine", "not-applicable"].includes(item.status) && !linked.some(({ claim }) => claim.marker === "unavailable" || claim.marker === "verified")) {
        findings.push(coverage(document.id, `unresolved work item ${item.id} requires a linked unavailable or verified claim`));
      }
    }
  }
  return findings;
}

export function validateClaimsInput(documentId: string, section: number, claims: SectionClaim[]): SectionClaimsFile {
  if (!Array.isArray(claims)) throw new Error("Claims must be an array");
  for (const claim of claims) {
    if (!claim || typeof claim !== "object") throw new Error("Each claim must be an object");
    if (!claim.id || !claim.statement || !["fact", "verified", "inferred", "unavailable"].includes(claim.marker)) throw new Error(`Invalid claim in ${documentId} section ${section}`);
    const sideViolations = validateComparisonSides(claim);
    if (sideViolations.length) throw new Error(`Invalid comparison sides in ${documentId} section ${section}: ${sideViolations.join("; ")}`);
  }
  return { version: 2, documentId, section, claims };
}



export function auditWorkItems(plan: InvestigationPlan, expected: InvestigationPlan, evidenceById: Map<string, EvidenceItem>, traceIds: Set<string>): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const expectedIds = new Set(expected.items.map((item) => item.id));
  const evidenceIds = new Set(evidenceById.keys());
  const seen = new Set<string>();
  for (const item of plan.items) {
    if (seen.has(item.id)) findings.push(error("workitems", `duplicate work item: ${item.id}`));
    seen.add(item.id);
    if (!expectedIds.has(item.id) && item.origin !== "open") findings.push(error("workitems", `unexpected non-open work item: ${item.id}`));
    if (!item.requiredFor.length && item.origin !== "open") findings.push(error("workitems", `work item has no required documents: ${item.id}`));
    if (item.status === "pending" || item.status === "in_progress") findings.push(error("workitems", `work item was not completed: ${item.id}`));
    if (item.status === "found" && !item.evidenceIds.length) findings.push(error("workitems", `found work item has no evidence: ${item.id}`));
    if (item.status === "not-applicable" && !item.reason?.trim()) findings.push(error("workitems", `not-applicable work item requires a reason: ${item.id}`));
    if (item.status === "cannot-determine" && (!item.reason?.trim() || !item.settledBy?.trim() || !item.evidenceIds.length)) {
      findings.push(error("workitems", `cannot-determine work item requires reason, settledBy and limitation evidence: ${item.id}`));
    }
    if (item.status === "searched-not-found") {
      if (!item.searchScope?.trim()) findings.push(error("workitems", `searched-not-found work item has no search scope: ${item.id}`));
      const receipts = item.evidenceIds.map((id) => evidenceById.get(id)).filter((evidence): evidence is EvidenceItem => evidence?.kind === "search");
      if (!receipts.length) findings.push(error("workitems", `searched-not-found work item cites no SEARCH receipt: ${item.id}`));
      for (const receipt of receipts) {
        const data = receipt.data as Record<string, unknown> | undefined;
        const matches = Array.isArray(data?.matches) ? data.matches : null;
        if (!data || Number(data.candidateFiles ?? 0) <= 0 || data.truncated === true || !matches || matches.length) {
          findings.push(error("workitems", `search receipt ${receipt.id} cannot prove searched-not-found for ${item.id}`));
        }
      }
    }
    if (item.material && item.status === "found" && ["normal-flow", "decision-flow", "reversal-flow", "states-and-lifecycle", "notifications-and-exports"].includes(item.dimension) && !item.traceIds.length) {
      findings.push(error("workitems", `material flow work item has no trace: ${item.id}`));
    }
    for (const id of item.evidenceIds) if (!evidenceIds.has(id)) findings.push(error("workitems", `work item ${item.id} references missing evidence id ${id}`));
    for (const id of item.traceIds) if (!traceIds.has(id)) findings.push(error("workitems", `work item ${item.id} references missing trace id ${id}`));
  }
  for (const id of expectedIds) if (!seen.has(id)) findings.push(error("workitems", `required work item is missing: ${id}`));
  return findings;
}

export function auditTraces(catalog: TraceCatalog, documentIds: Set<string>, evidenceIds: Set<string>, claimIds: Set<string>): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const ids = new Set<string>();
  for (const trace of catalog.traces) {
    if (!trace.id.trim()) findings.push(error("traces", "trace has no id"));
    if (ids.has(trace.id)) findings.push(error("traces", `duplicate trace id: ${trace.id}`));
    ids.add(trace.id);
    if (!trace.documentIds.length) findings.push(error("traces", `trace ${trace.id} is not linked to a document`));
    for (const id of trace.documentIds) if (!documentIds.has(id)) findings.push(error("traces", `trace ${trace.id} references unknown document ${id}`));
    if (trace.status === "unavailable") {
      if (!trace.reason?.trim()) findings.push(error("traces", `unavailable trace ${trace.id} requires a reason`));
      continue;
    }
    if (!trace.steps.length) findings.push(error("traces", `trace ${trace.id} has no steps`));
    const stepNumbers = trace.steps.map((step) => step.index);
    if (stepNumbers.some((value, index) => value !== index + 1)) findings.push(error("traces", `trace ${trace.id} steps are not sequential`));
    for (const step of trace.steps) {
      if (!step.action.trim()) findings.push(error("traces", `trace ${trace.id} step ${step.index} has no action`));
      if (trace.status === "verified" && !step.evidenceIds.length) findings.push(error("traces", `verified trace ${trace.id} step ${step.index} has no evidence`));
      for (const id of step.evidenceIds) if (!evidenceIds.has(id)) findings.push(error("traces", `trace ${trace.id} references missing evidence id ${id}`));
      for (const id of step.claimIds ?? []) if (!claimIds.has(id)) findings.push(error("traces", `trace ${trace.id} references missing claim id ${id}`));
    }
    if (trace.status === "verified" && trace.confidence === "low") findings.push(error("traces", `verified trace ${trace.id} cannot have low confidence`));
  }
  for (const trace of catalog.traces) if (trace.supersedes && !ids.has(trace.supersedes)) findings.push(error("traces", `trace ${trace.id} supersedes missing trace ${trace.supersedes}`));
  return findings;
}

function requiredForScope(document: DocumentPlan, scope: string): boolean {
  if (scope === "project") return document.kind === "overview";
  if (!scope.startsWith("feature:") || document.kind !== "feature") return false;
  return document.id.includes(scope.slice("feature:".length));
}
function checklistVerdictToStatus(verdict: ChecklistItem["verdict"]): InvestigationWorkItem["status"] {
  return verdict === "hit" ? "found" : verdict;
}
function workItemStatusToVerdict(status: InvestigationWorkItem["status"]): ChecklistItem["verdict"] {
  if (status === "found") return "hit";
  if (status === "in_progress") return "pending";
  // searched-not-found, cannot-determine and not-applicable share their name across both vocabularies.
  return status;
}
function isCompleteWorkItem(status: InvestigationWorkItem["status"]): boolean {
  return !["pending", "in_progress"].includes(status);
}

export function substantiveSegments(section: string): string[] {
  const lines = visibleText(section).split(/\r?\n/);
  const segments: string[] = [];
  for (let line of lines) {
    line = line.trim();
    if (!line || /^#{1,6}\s+/.test(line) || /^[-| :]+$/.test(line)) continue;
    if (/^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line)) continue;
    line = line
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`(?:事实|验证|推断|不可得|fact|verified|inferred|unavailable)`/gi, "")
      .trim();
    if (line.startsWith("|") && line.endsWith("|")) {
      line = line.slice(1, -1).split("|").map((cell) => cell.trim()).filter(Boolean).join("；");
    }
    for (const part of line.split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+(?=[A-Z0-9])/u)) {
      const normalized = normalizeText(part).trim();
      const semanticLength = (normalized.match(/[\p{Letter}\p{Number}]/gu) ?? []).length;
      if (semanticLength >= 8) segments.push(normalized);
    }
  }
  return [...new Set(segments)];
}

function visibleText(section: string): string {
  return section
    .replace(/<details[\s\S]*?<\/details>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ");
}

export function markersIn(text: string): Set<EvidenceMarker> {
  const markers = new Set<EvidenceMarker>();
  if (/(?:`事实`|\bfact\b)/i.test(text)) markers.add("fact");
  if (/(?:`验证`|\bverified\b)/i.test(text)) markers.add("verified");
  if (/(?:`推断`|\binferred\b)/i.test(text)) markers.add("inferred");
  if (/(?:`不可得`|\bunavailable\b)/i.test(text)) markers.add("unavailable");
  return markers;
}

/**
 * The one rule for "does this prose carry an evidence-level marker". Document- and section-level
 * checks both route through `markersIn` over `visibleText`, so they cannot drift onto different rules:
 * a bare backtick-free word like an incidental "事实" in prose is not a marker, only a real
 * `事实`/`验证`/`推断`/`不可得` (or the English marker words the paragraph audit already accepts) is.
 */
export function hasEvidenceMarkers(text: string): boolean {
  return markersIn(visibleText(text)).size > 0;
}

/**
 * The report's "evidence levels are annotated" conclusion is only trustworthy if every substantive
 * section actually carries an evidence-level marker in its visible prose. This reuses the same
 * `markersIn` primitive the paragraph-level claim audit uses, via `hasEvidenceMarkers`, so it cannot
 * diverge from the document-level check. It is gated by assurance version: a run prepared under the
 * current version is held to it as a hard error, while an older or field-less run is grandfathered
 * (the weaker document-level warning still applies) so this tightening never retroactively fails it.
 */
export function auditSectionEvidenceMarkers(options: {
  documentId: string;
  sectionIndex: number;
  sectionText: string;
  strict: boolean;
}): AuditFinding[] {
  const { documentId, sectionIndex, sectionText, strict } = options;
  if (!strict || !substantiveSegments(sectionText).length || hasEvidenceMarkers(sectionText)) return [];
  return [error(documentId, `section ${sectionIndex} has substantive statements but no evidence-level marker`)];
}

function normalizeText(value: string): string { return value.replace(/[`*_>#-]/g, " ").replace(/\s+/g, " ").trim(); }
function featureScopeKey(subject: string, aliases: string[]): string { return sha256(stableJson({ subject: subject.trim().toLowerCase(), aliases: [...aliases].sort() })).slice(0, 10); }
function error(document: string, message: string): AuditFinding { return { level: "error", document, message }; }
function warning(document: string, message: string): AuditFinding { return { level: "warning", document, message }; }
