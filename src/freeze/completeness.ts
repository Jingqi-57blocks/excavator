import { join } from "node:path";
import { assertNever, type ArtifactResult, type NotApplicable } from "../base/artifact-result.ts";
import {
  coverageBasisDigest, fileCompletenessValue, FILE_COMPLETENESS_BASIS, FILE_ROOTS_BASIS, fileRootCensusValue,
  mechanismCoverageBasisName, mechanismCoverageValue, type CoverageBasisValue
} from "../base/coverage-basis.ts";
import type {
  AuditFinding, CompletenessSource, DomainCompleteness, EvidenceItem, FreezeAuditCheck, InvestigationPlan,
  KnowledgeCompleteness, RunManifest, RunMetrics
} from "../base/types.ts";
import type { ContractManifest } from "../contract/contract-manifest.ts";
import { attributionContentDigest, type AttributionArtifact } from "../attribution/attribution-artifact.ts";
import { displacedReadsAdvisory } from "../investigation/read-budget.ts";
import type { InvestigationResults } from "../investigation/read-execution.ts";
import type { MechanismLedger } from "../mechanism/mechanism-ledger.ts";
import { ledgerContentIdentity, type FileLedger } from "../snapshot/file-ledger.ts";
import { unitsContentDigest, type UnitsArtifact } from "../facts/units/units-artifact.ts";
import type { OverviewCensusV2, ScopeCensusRow, ScopeCensusV2 } from "../workset/census.ts";
import { canonicalJson, exists, readJson, sha256, stableJson } from "../base/util.ts";
import { DOMAIN_COMPLETENESS_ASSURANCE_GENERATION, assuranceGenerationAtLeast } from "../base/assurance-version.ts";

const MATERIAL_FLOW_DIMENSIONS = new Set(["normal-flow", "decision-flow", "reversal-flow", "states-and-lifecycle", "notifications-and-exports"]);

export interface FreezeCompletenessInput {
  readonly runDir: string;
  readonly manifest: RunManifest;
  readonly contract: ContractManifest;
  readonly plan: InvestigationPlan;
  readonly investigationResults: InvestigationResults | null;
  /** Result of the already-executed contract-instance check; reused, never silently rerun or skipped. */
  readonly contractFindings: readonly AuditFinding[];
  /** The frozen catalog. Required: the closure figure below is the only place a recorded read is compared
   *  against the authorizations, and an optional catalog would make that comparison silently skippable. */
  readonly evidence: readonly EvidenceItem[];
}

export interface FreezeCompletenessResult {
  readonly completeness: KnowledgeCompleteness;
  readonly findings: readonly AuditFinding[];
}

interface CheckOutcome {
  readonly findings: AuditFinding[];
  readonly domains?: DomainCompleteness[];
}

/** Run exactly the check families the bound contract names. An unknown family is a visible skipped check. */
export async function buildFreezeCompleteness(input: FreezeCompletenessInput): Promise<FreezeCompletenessResult> {
  const findings: AuditFinding[] = [];
  const checks: FreezeAuditCheck[] = [];
  let domains: DomainCompleteness[] = [];
  const seen = new Set<string>();
  for (const declared of [...input.contract.checks].sort((a, b) => a.family.localeCompare(b.family))) {
    if (seen.has(declared.family)) {
      const finding = error("freeze-checklist", `check family ${declared.family} is declared more than once`);
      findings.push(finding);
      checks.push({ ...declared, status: "failed", findingCount: 1, reason: finding.message });
      continue;
    }
    seen.add(declared.family);
    const outcome = await executeCheck(declared.family, declared.version, input);
    if (outcome === null) {
      const reason = `check family ${declared.family}@${declared.version} has no layer-8 executor and was skipped`;
      findings.push(error("freeze-checklist", reason));
      checks.push({ ...declared, status: "skipped", findingCount: 1, reason });
      continue;
    }
    findings.push(...outcome.findings);
    if (outcome.domains) domains = outcome.domains;
    const errors = outcome.findings.filter((finding) => finding.level === "error");
    // `reason` carries the first finding whatever its level. It used to be populated only for errors, so an
    // advisory sealed as `passed, findingCount: 1` with nothing saying what the one finding was — a number an
    // auditor cannot act on, which is the same defect the advisory itself exists to fix one level up.
    const firstFinding = errors[0] ?? outcome.findings[0];
    checks.push({ ...declared, status: errors.length ? "failed" : "passed", findingCount: outcome.findings.length, ...(firstFinding ? { reason: firstFinding.message } : {}) });
  }
  const requiredFamilies = ["contract-instances", "coverage-conservation", "boundary-identity",
    ...(assuranceGenerationAtLeast(input.manifest, DOMAIN_COMPLETENESS_ASSURANCE_GENERATION) ? ["not-applicable-premises", "investigation-closure"] : [])];
  for (const required of requiredFamilies) {
    if (seen.has(required)) continue;
    const reason = `required check family ${required} is absent from the bound contract and was skipped`;
    findings.push(error("freeze-checklist", reason));
    checks.push({ family: required, version: "missing", status: "skipped", findingCount: 1, reason });
  }
  checks.sort((a, b) => a.family.localeCompare(b.family));
  return {
    completeness: {
      version: "knowledge-completeness-v4",
      domains,
      closure: buildClosure(input.plan, input.investigationResults, input.evidence),
      checks,
      warnings: domains.flatMap((domain) => domain.sources.flatMap((source) => source.limitations.map((limit) => `${source.id}: ${limit}`)))
    },
    findings
  };
}

async function executeCheck(family: string, version: string, input: FreezeCompletenessInput): Promise<CheckOutcome | null> {
  if (version !== "v1") return null;
  const v15 = assuranceGenerationAtLeast(input.manifest, DOMAIN_COMPLETENESS_ASSURANCE_GENERATION);
  switch (family) {
    case "contract-instances": return { findings: [...input.contractFindings] };
    case "coverage-conservation": return inspectDomainCompleteness(input.runDir, input.contract);
    case "boundary-identity": return { findings: await auditBoundaryIdentity(input.runDir, input.manifest) };
    case "not-applicable-premises": return { findings: v15 ? await auditNotApplicablePremises(input.runDir, input.contract) : [] };
    case "investigation-closure": return { findings: v15 ? auditInvestigationClosure(input.investigationResults, input.evidence, input.manifest.metrics.sourceWindowDemand) : [] };
    default: return null;
  }
}

async function inspectDomainCompleteness(runDir: string, contract: ContractManifest): Promise<CheckOutcome> {
  const findings: AuditFinding[] = [];
  const sources: CompletenessSource[] = [];
  const files = await readResult<FileLedger>(runDir, "ledger/files.json", findings);
  const mechanisms = await readResult<MechanismLedger>(runDir, "ledger/mechanisms.json", findings);
  const units = await readResult<UnitsArtifact>(runDir, "facts/units.json", findings);
  const attribution = await readResult<AttributionArtifact>(runDir, "attribution/attribution.json", findings);

  if (files) inspectFiles(files, sources, findings);
  if (mechanisms) inspectMechanisms(mechanisms, sources, findings);
  if (units) inspectUnits(units, files, sources, findings);
  if (attribution) inspectAttribution(attribution, units, sources, findings);

  const overviewPath = contract.expected.find((row) => row.slotId === "workset.overview-census")?.path;
  if (overviewPath) {
    const overview = await readResult<OverviewCensusV2>(runDir, overviewPath, findings);
    if (overview) inspectOverview(overviewPath, overview, files, sources, findings);
  }
  for (const instance of contract.expected.filter((row) => row.slotId === "workset.scope-census").sort((a, b) => a.instanceKey.localeCompare(b.instanceKey))) {
    const census = await readResult<ScopeCensusV2>(runDir, instance.path, findings);
    if (census) inspectScope(instance.path, census, files, units, attribution, sources, findings);
  }
  return { findings, domains: groupDomains(sources) };
}

function inspectFiles(ledger: FileLedger, sources: CompletenessSource[], findings: AuditFinding[]): void {
  const { total, counted, excluded, unexplained } = ledger.summary;
  if (total !== counted + excluded + unexplained) findings.push(error("completeness", `ledger/files.json file/file conservation is unbalanced`));
  if (unexplained > 0) findings.push(error("completeness", `ledger/files.json leaves ${unexplained} file candidate(s) unexplained`));
  const unread = ledger.counted.filter((row) => row.content.status === "absent").length;
  const limitations = [
    ...(ledger.completeness.capReached ? [`scan capped: skipped ${ledger.completeness.skippedByCap}, dropped roots ${ledger.completeness.droppedRoots.length}`] : []),
    ...(unread ? [`${unread} counted file(s) have no content identity`] : [])
  ];
  sources.push(source("files", "file", "file", "ledger/files.json", ledger.contentManifestDigest, ledger.scannerVersion, total,
    { total, counted, excluded, unexplained }, limitations));
}

function inspectMechanisms(ledger: MechanismLedger, sources: CompletenessSource[], findings: AuditFinding[]): void {
  const digest = sha256(stableJson(ledger));
  const matrixById = new Map(ledger.fileMatrix.map((row) => [row.mechanismId, row]));
  for (const mechanism of [...ledger.mechanisms].sort((a, b) => a.id.localeCompare(b.id))) {
    const matrix = matrixById.get(mechanism.id);
    const limitations: string[] = [];
    let denominatorRows = 0;
    let accounting: Record<string, number> = {};
    if (mechanism.takesMatrixRows) {
      if (!matrix) {
        findings.push(error("completeness", `ledger/mechanisms.json omits the file-domain row for ${mechanism.id}`));
      } else {
        const { covered, noMechanism, mechanismUnavailable } = matrix.totals;
        denominatorRows = ledger.counted;
        accounting = { counted: ledger.counted, covered, noMechanism, mechanismUnavailable };
        if (covered + noMechanism + mechanismUnavailable !== ledger.counted) findings.push(error("completeness", `mechanism ${mechanism.id} does not conserve its file denominator`));
        if (noMechanism) limitations.push(`${noMechanism} file row(s) outside declared mechanism coverage`);
        if (mechanismUnavailable) limitations.push(`${mechanismUnavailable} declared row(s) unavailable at runtime`);
      }
    } else {
      limitations.push("declared domain has no row-set denominator in mechanisms-v2");
    }
    if (mechanism.availability.status === "unavailable") limitations.push(`runtime unavailable: ${mechanism.availability.cause}`);
    sources.push(source(`mechanism:${mechanism.id}`, mechanism.coverageDomain, mechanism.unitKind, "ledger/mechanisms.json", digest,
      mechanism.version, denominatorRows, accounting, limitations));
  }
}

function inspectUnits(artifact: UnitsArtifact, ledger: FileLedger | null, sources: CompletenessSource[], findings: AuditFinding[]): void {
  const { total, counted, excluded, unexplained } = artifact.completeness;
  if (total !== counted + excluded + unexplained) findings.push(error("completeness", "facts/units.json file-building conservation is unbalanced"));
  if (unexplained > 0) findings.push(error("completeness", `facts/units.json leaves ${unexplained} file(s) unexplained`));
  if (ledger) {
    if (artifact.identity.filesContentManifestDigest !== ledger.contentManifestDigest || artifact.identity.scannerVersion !== ledger.scannerVersion) {
      findings.push(error("completeness", "facts/units.json names a different file-ledger identity"));
    }
    if (total !== ledger.counted.length) findings.push(error("completeness", `facts/units.json counts ${total} files but its file-ledger denominator has ${ledger.counted.length}`));
    if (artifact.inheritedCompleteness.capReached !== ledger.completeness.capReached
      || artifact.inheritedCompleteness.skippedByCap !== ledger.completeness.skippedByCap
      || stableJson(artifact.inheritedCompleteness.droppedRoots) !== stableJson([...ledger.completeness.droppedRoots].sort((a, b) => a.localeCompare(b)))) {
      findings.push(error("completeness", "facts/units.json does not inherit the file ledger's scan qualifications"));
    }
  }
  const limitations = [
    ...(artifact.inheritedCompleteness.capReached ? ["partition inherits a capped file scan"] : []),
    ...(excluded ? [`${excluded} file(s) could not be partitioned`] : []),
    ...(artifact.observations.lineIndexReadFailures ? [`${artifact.observations.lineIndexReadFailures} observation line-index read(s) failed`] : [])
  ];
  sources.push(source("partition", "file", "partition-cell", "facts/units.json", unitsContentDigest(artifact),
    artifact.identity.partitionDesignation.version, artifact.partition.length,
    { sourceFilesTotal: total, sourceFilesPartitioned: counted, sourceFilesExcluded: excluded, sourceFilesUnexplained: unexplained }, limitations));
}

function inspectAttribution(artifact: AttributionArtifact, units: UnitsArtifact | null, sources: CompletenessSource[], findings: AuditFinding[]): void {
  if (units) {
    const unitsDigest = unitsContentDigest(units);
    if (artifact.denominator.contentDigest !== unitsDigest || artifact.identity.unitsContentDigest !== unitsDigest) {
      findings.push(error("completeness", "attribution/attribution.json names a different partition denominator"));
    }
    if (artifact.denominator.cells !== units.partition.length) {
      findings.push(error("completeness", `attribution/attribution.json names ${artifact.denominator.cells} cells but the partition has ${units.partition.length}`));
    }
  }
  const digest = attributionContentDigest(artifact);
  if (artifact.featureCount !== artifact.selections.length) findings.push(error("completeness", "attribution featureCount does not match its selection rows"));
  if (new Set(artifact.selections.map((row) => row.featureKey)).size !== artifact.selections.length) findings.push(error("completeness", "attribution contains duplicate feature selections"));
  if (!artifact.selections.length) {
    sources.push(source("attribution:no-feature", "file", "partition-cell", "attribution/attribution.json", digest,
      artifact.version, artifact.denominator.cells, { requestedFeatures: 0 }, []));
    return;
  }
  for (const selection of artifact.selections) {
    const moduleRows = Array.isArray(selection.modules) ? selection.modules : [];
    if (!Array.isArray(selection.modules)) {
      findings.push(error("completeness", `attribution ${selection.featureKey} has no module census`));
    }
    if (new Set(moduleRows.map((row) => row.moduleId)).size !== moduleRows.length) {
      findings.push(error("completeness", `attribution ${selection.featureKey} contains duplicate module rows`));
    }
    const moduleInventory = moduleRows.map((row) => ({ id: row.moduleId, dir: row.dir }))
      .sort((a, b) => a.id.localeCompare(b.id) || a.dir.localeCompare(b.dir));
    if (sha256(canonicalJson(moduleInventory)) !== artifact.identity.channelInputs.moduleInventoryDigest) {
      findings.push(error("completeness", `attribution ${selection.featureKey} module rows do not match the declared module inventory`));
    }
    for (const module of moduleRows) {
      const values = [module.denominatorCells, module.poolNodes, module.retainedNodes, module.displacedNodes,
        module.seatedCells, module.displacedCells, module.soleSourceSeats];
      if (values.some((value) => !Number.isInteger(value) || value < 0)) {
        findings.push(error("completeness", `attribution ${selection.featureKey}/${module.moduleId} has an invalid module count`));
      }
      if (module.poolNodes !== module.retainedNodes + module.displacedNodes) {
        findings.push(error("completeness", `attribution ${selection.featureKey}/${module.moduleId} does not conserve allocator candidates`));
      }
      const expectedStatus = module.seatedCells > 0 ? "seated"
        : module.poolNodes > 0 ? "candidates-no-seat"
        : module.denominatorCells > 0 ? "zero-signal"
        : "outside-denominator";
      if (module.status !== expectedStatus) {
        findings.push(error("completeness", `attribution ${selection.featureKey}/${module.moduleId} status ${module.status} contradicts its counts`));
      }
      if (module.soleSourceSeats > module.seatedCells) {
        findings.push(error("completeness", `attribution ${selection.featureKey}/${module.moduleId} has more sole-source seats than seated cells`));
      }
    }
    if (moduleRows.length && selection.channels.status === "ran") {
      const poolNodes = moduleRows.reduce((sum, row) => sum + row.poolNodes, 0);
      const retainedNodes = moduleRows.reduce((sum, row) => sum + row.retainedNodes, 0);
      if (poolNodes !== selection.channels.poolNodes || retainedNodes !== selection.channels.retainedNodes) {
        findings.push(error("completeness", `attribution ${selection.featureKey} module rows do not conserve the allocator trace`));
      }
    }
    if (selection.conservation.length !== 1 || selection.conservation[0]?.unitKind !== artifact.denominator.unitKind) {
      findings.push(error("completeness", `attribution ${selection.featureKey} does not publish exactly one conservation row for ${artifact.denominator.unitKind}`));
    }
    for (const row of selection.conservation) {
      const { counted, seated, zeroScore, displaced } = row.totals;
      if (counted !== seated + zeroScore + displaced) findings.push(error("completeness", `attribution ${selection.featureKey} does not conserve ${row.unitKind}`));
      if (counted !== artifact.denominator.cells) findings.push(error("completeness", `attribution ${selection.featureKey} counts ${counted} cells but its denominator has ${artifact.denominator.cells}`));
      const limitations = [
        ...(selection.channels.status === "channel-unavailable" ? [`selection channel unavailable: ${selection.channels.cause}`] : []),
        ...moduleRows.filter((module) => module.status === "zero-signal").map((module) => `zero-signal module: ${module.moduleId}`)
      ];
      sources.push(source(`attribution:${selection.featureKey}`, "file", row.unitKind, "attribution/attribution.json", digest,
        artifact.version, counted, { counted, seated, zeroScore, displaced }, limitations));
    }
  }
}

function inspectOverview(path: string, census: OverviewCensusV2, ledger: FileLedger | null, sources: CompletenessSource[], findings: AuditFinding[]): void {
  const summed = census.rows.reduce((out, row) => addCoverage(out, row.totals), emptyCoverage());
  if (!sameCoverage(summed, census.summary)) findings.push(error("completeness", `${path} summary does not equal its module x language rows`));
  for (const row of census.rows) if (!balancedCoverage(row.totals)) findings.push(error("completeness", `${path} has an unbalanced ${row.module}/${row.language} file row`));
  if (ledger && (census.identity.files.contentDigest !== ledger.contentManifestDigest || census.identity.files.rows !== ledger.counted.length)) {
    findings.push(error("completeness", `${path} does not name the file ledger denominator it summarizes`));
  }
  if (ledger && !sameCoverage(census.summary, ledger.summary)) findings.push(error("completeness", `${path} does not preserve the file ledger's coverage buckets`));
  const limitations = census.identity.files.completeness.capReached ? ["overview inherits a capped file scan"] : [];
  sources.push(source("overview-census", "file", "file", path, sha256(stableJson(census)), census.version,
    census.summary.total, numericCoverage(census.summary), limitations));
}

function inspectScope(path: string, census: ScopeCensusV2, ledger: FileLedger | null, units: UnitsArtifact | null,
  attribution: AttributionArtifact | null, sources: CompletenessSource[], findings: AuditFinding[]): void {
  const rows = census.rows.filter((row): row is ScopeCensusRow => row.kind === "census");
  const unavailable = census.rows.filter((row) => row.kind === "census-unavailable");
  const coverage = rows.reduce((out, row) => addCoverage(out, row.coverage.totals), emptyCoverage());
  const selection = rows.reduce((out, row) => addSelection(out, row.selection.totals), emptySelection());
  for (const row of rows) {
    if (!balancedCoverage(row.coverage.totals)) findings.push(error("completeness", `${path} has unbalanced file coverage for ${row.module}/${row.language}`));
    if (!balancedSelection(row.selection.totals)) findings.push(error("completeness", `${path} has unbalanced partition selection for ${row.module}/${row.language}`));
  }
  if (!sameCoverage(coverage, census.summary.coverage)) findings.push(error("completeness", `${path} coverage summary does not equal its rows`));
  if (census.summary.selection && !sameSelection(selection, census.summary.selection)) findings.push(error("completeness", `${path} selection summary does not equal its rows`));
  if (census.summary.unavailableRows !== unavailable.length) findings.push(error("completeness", `${path} unavailable row count does not reconcile`));
  if (census.summary.coverage.total !== census.identity.files.rows) findings.push(error("completeness", `${path} file coverage does not conserve its named denominator`));
  if (census.identity.partition && census.summary.selection && census.summary.selection.counted !== census.identity.partition.rows) {
    findings.push(error("completeness", `${path} partition selection does not conserve its named denominator`));
  }
  if (ledger && (census.identity.files.contentDigest !== ledger.contentManifestDigest || census.identity.files.rows !== ledger.counted.length)) {
    findings.push(error("completeness", `${path} names a different file denominator`));
  }
  if (units && census.identity.partition
    && (census.identity.partition.contentDigest !== unitsContentDigest(units) || census.identity.partition.rows !== units.partition.length)) {
    findings.push(error("completeness", `${path} names a different partition denominator`));
  }
  if (attribution && census.identity.attributionDigest !== attributionContentDigest(attribution)) {
    findings.push(error("completeness", `${path} names a different attribution source`));
  }
  const commonLimits = [
    ...(census.identity.files.completeness.capReached ? ["scope inherits a capped file scan"] : []),
    ...unavailable.map((row) => `scope census unavailable: ${row.cause}`)
  ];
  const digest = sha256(stableJson(census));
  sources.push(source(`scope:${census.featureKey}:files`, "file", "file", path, digest, census.version,
    census.identity.files.rows, numericCoverage(census.summary.coverage), commonLimits));
  if (census.identity.partition && census.summary.selection) {
    sources.push(source(`scope:${census.featureKey}:partition`, "file", "partition-cell", path, digest, census.version,
      census.identity.partition.rows, numericSelection(census.summary.selection), commonLimits));
  }
}

async function auditBoundaryIdentity(runDir: string, manifest: RunManifest): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const ledger = await readResult<FileLedger>(runDir, "ledger/files.json", findings);
  if (!ledger) return findings;
  const derived = ledgerContentIdentity(ledger);
  if (derived !== ledger.contentManifestDigest) findings.push(error("boundary-identity", "ledger/files.json content identity cannot be re-derived"));
  if (manifest.snapshot?.contentManifestDigest !== ledger.contentManifestDigest) findings.push(error("boundary-identity", "ledger/files.json content identity differs from the run snapshot"));
  return findings;
}

export async function auditNotApplicablePremises(runDir: string, contract: ContractManifest): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  for (const instance of contract.expected.filter((row) => row.enforced).sort((a, b) => a.path.localeCompare(b.path))) {
    const path = join(runDir, instance.path);
    if (!await exists(path)) continue; // contract-instances names the missing artifact.
    let envelope: ArtifactResult<unknown>;
    try { envelope = await readJson<ArtifactResult<unknown>>(path); }
    catch { continue; }
    if (envelope.status !== "not-applicable") continue;
    findings.push(...await validateNotApplicable(runDir, instance.path, envelope));
  }
  return findings;
}

async function validateNotApplicable(runDir: string, artifactPath: string, result: NotApplicable): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  if (typeof result.determination !== "string" || !result.determination.trim()
    || !Array.isArray(result.basedOn) || !result.basedOn.length || result.basedOn.some((row) => typeof row !== "string" || !row.trim())
    || typeof result.coverageDigest !== "string" || !result.coverageDigest.trim()) {
    return [error("not-applicable", `${artifactPath} has an incomplete NotApplicable premise` )];
  }
  if (result.determination !== "not-detected" && result.determination !== "single-module") {
    findings.push(error("not-applicable", `${artifactPath} uses unsupported NotApplicable determination ${result.determination}; no premise validator exists`));
  }
  const references = new Set(result.basedOn);
  if (references.size !== result.basedOn.length) {
    findings.push(error("not-applicable", `${artifactPath} names the same coverage basis more than once`));
  }
  const bases: CoverageBasisValue[] = [];
  if (result.determination === "not-detected") {
    if (!result.basedOn.includes(FILE_COMPLETENESS_BASIS) || !result.basedOn.some((row) => row.startsWith("ledger/mechanisms.json#mechanism:"))) {
      findings.push(error("not-applicable", `${artifactPath} claims not-detected without both file completeness and mechanism coverage premises`));
    }
  }
  if (result.determination === "single-module") {
    if (!result.basedOn.includes(FILE_COMPLETENESS_BASIS) || !result.basedOn.includes(FILE_ROOTS_BASIS)
      || !result.basedOn.some((row) => row.startsWith("ledger/mechanisms.json#mechanism:"))) {
      findings.push(error("not-applicable", `${artifactPath} claims single-module without file completeness, root census and resolver-coverage premises`));
    }
  }
  for (const reference of result.basedOn) {
    try { bases.push({ reference, value: await resolveBasis(runDir, reference) }); }
    catch (basisError) {
      findings.push(error("not-applicable", `${artifactPath} cannot resolve ${reference}: ${(basisError as Error).message}`));
    }
  }
  if (references.size === result.basedOn.length && bases.length === result.basedOn.length && coverageBasisDigest(bases) !== result.coverageDigest) {
    findings.push(error("not-applicable", `${artifactPath} coverageDigest does not match its current basedOn records`));
  }
  for (const basis of bases) {
    if (basis.reference === FILE_COMPLETENESS_BASIS) {
      const value = basis.value as { capReached?: unknown; skippedByCap?: unknown; droppedRoots?: unknown; readFailures?: unknown };
      if (value.capReached === true || Number(value.skippedByCap ?? 0) > 0 || Number(value.readFailures ?? 0) > 0 || (Array.isArray(value.droppedRoots) && value.droppedRoots.length > 0)) {
        findings.push(error("not-applicable", `${artifactPath} claims ${result.determination} from a capped, dropped or unread file scan; it must be Unavailable`));
      }
    }
    if (basis.reference.startsWith("ledger/mechanisms.json#mechanism:")) {
      const value = basis.value as { declaration?: { availability?: { status?: string }; takesMatrixRows?: boolean }; matrix?: { totals?: { noMechanism?: number; mechanismUnavailable?: number } } };
      if (value.declaration?.availability?.status !== "available") findings.push(error("not-applicable", `${artifactPath} claims ${result.determination} while its mechanism is unavailable; it must be Unavailable`));
      if (result.determination === "not-detected") {
        if (value.declaration?.takesMatrixRows !== true || !value.matrix?.totals) {
          findings.push(error("not-applicable", `${artifactPath} claims not-detected without a file-domain mechanism matrix; it must be Unavailable`));
        } else if (Number(value.matrix.totals.noMechanism ?? 0) > 0 || Number(value.matrix.totals.mechanismUnavailable ?? 0) > 0) {
          findings.push(error("not-applicable", `${artifactPath} claims not-detected with partial mechanism coverage; it must be Unavailable`));
        }
      }
    }
    if (basis.reference === FILE_ROOTS_BASIS && result.determination === "single-module"
      && (!Array.isArray(basis.value) || basis.value.length !== 1)) {
      findings.push(error("not-applicable", `${artifactPath} claims single-module but the layer-1 ledger has ${Array.isArray(basis.value) ? basis.value.length : "an invalid number of"} roots`));
    }
  }
  return findings;
}

async function resolveBasis(runDir: string, reference: string): Promise<unknown> {
  if (reference === FILE_COMPLETENESS_BASIS) {
    const result = await readJson<ArtifactResult<FileLedger>>(join(runDir, "ledger", "files.json"));
    if (result.status !== "built") throw new Error(`file ledger is ${result.status}`);
    return fileCompletenessValue({
      ...result.value.completeness,
      readFailures: result.value.counted.filter((row) => row.content.status === "absent").length
    });
  }
  if (reference === FILE_ROOTS_BASIS) {
    const result = await readJson<ArtifactResult<FileLedger>>(join(runDir, "ledger", "files.json"));
    if (result.status !== "built") throw new Error(`file ledger is ${result.status}`);
    return fileRootCensusValue(result.value.completeness.roots);
  }
  const prefix = "ledger/mechanisms.json#mechanism:";
  if (reference.startsWith(prefix)) {
    const result = await readJson<ArtifactResult<MechanismLedger>>(join(runDir, "ledger", "mechanisms.json"));
    if (result.status !== "built") throw new Error(`mechanism ledger is ${result.status}`);
    return mechanismCoverageValue(result.value, reference.slice(prefix.length));
  }
  throw new Error("basis kind is not registered");
}

/** How many unclaimed-read ids one advisory names before it rolls the rest up. A finding is a bounded field. */
const UNCLAIMED_READ_ADVISORY_LIMIT = 20;

function auditInvestigationClosure(results: InvestigationResults | null, evidence: readonly EvidenceItem[], demand: RunMetrics["sourceWindowDemand"]): AuditFinding[] {
  if (!results) return [error("investigation-closure", "L7 investigation results were not available to the closure check")];
  const findings: AuditFinding[] = [];
  // ONE aggregate advisory for the reads a recorded ceiling displaced, and it comes first so that it is the
  // finding this check seals into `FreezeAuditCheck.reason` when it is the only thing to report.
  //
  // THE RULING THIS SETTLES. Two modules held opposite policies on one fact. `read-coverage.ts` reports "N
  // counted read obligations were never opened" as `level: "warning"`, and says why at :67 — an advisory that
  // is necessarily true every time trains the author to ignore advisories. This check reported the SAME fact,
  // per row, as a freeze-blocking error. Measured: a four-document wcp run failed freeze with 1,777 errors, of
  // which 1,687 (892 source-reading, 795 decision-reading) no work item could ever clear, because they are
  // written once at prepare into `investigation/results.json` and no runtime mutator can reach that file. The
  // same code with the ceiling raised from 60 to 1,500 produced zero of them. Across the whole workspace, 43 of
  // 83 runs carried such a read and not one of them had ever been frozen — the budget had stopped being a
  // performance knob and become a correctness cliff, and a cliff that hid an entire class of runs from
  // knowledge. Ruled: a ceiling this run recorded itself is a LIMITATION, and limitations are recorded, not
  // fatal. What stays fatal is the source failing to yield (`unavailable`, below) and a ledger that lies —
  // `read-coverage.ts` still errors on a work item disposed `found` whose windows never touch what it reports,
  // and `read-execution.ts` still refuses an execution that claims displacement while covering its whole span.
  const displacedExecutions = results.executions.filter((row) => row.outcome === "budget-displaced");
  const displacedDispositions = results.dispositions.filter((row) => row.status === "displaced").length;
  if (displacedExecutions.length) {
    findings.push({
      level: "warning",
      document: "investigation-closure",
      message: displacedReadsAdvisory({ causes: displacedExecutions.map((row) => row.cause), displacedDispositions, demand })
    });
  }
  // ADVISORY, not an error, and not silence either.
  //
  // The check only ever asked the forward question — did every AUTHORIZED read complete — so a run that read
  // without authorization sealed as `passed, 0 findings`. Making it an error would fail every overview and
  // feature run today, because prepare reads the target's project documents before any ReadSpec exists; the gap
  // is a property of the current L5/L7 split, not of a run. But a clean verdict printed beside a non-zero
  // `sourceReadsWithoutObligation` is the artifact contradicting itself — the count says something happened and
  // the verdict says nothing did. Advisory keeps freeze open while making the check's own record disagree with
  // "nothing to report", and the ids make it actionable: a bare count tells an auditor nothing to go look at.
  const unclaimed = unclaimedReads(results, evidence);
  if (unclaimed.length) {
    const named = unclaimed.slice(0, UNCLAIMED_READ_ADVISORY_LIMIT);
    const rest = unclaimed.length - named.length;
    findings.push({
      level: "warning",
      document: "investigation-closure",
      message: `${unclaimed.length} recorded read(s) are claimed by no read execution: ${named.join(", ")}${rest ? ` (+${rest} more)` : ""}. A run with no ReadSpec authorizes none, so prepare-time reads land here until layer 5 issues run-scoped authorizations.`
    });
  }
  // Still hard, and unchanged: the source would not yield. A missing file, a rejected path or a span the file
  // does not have is a defect in the authorization or the target, not a number an operator can raise.
  for (const execution of results.executions.filter((row) => row.outcome === "unavailable")) {
    findings.push(error("investigation-closure", `source-reading ${execution.declarationId} remains pending: ${execution.cause ?? "authorized source unavailable"}`));
  }
  for (const disposition of results.dispositions.filter((row) => row.status === "pending")) {
    findings.push(error("investigation-closure", `decision-reading ${disposition.declarationId} remains pending after its authorized read`));
  }
  return findings;
}

/**
 * Evidence kinds produced by reading the target's bytes.
 *
 * All four go through `SourceReader`/`sourceSearch`: `readme` and `manifest` are whole-file windows
 * (`context.ts` project documents), `search` carries excerpts, `source` is a bounded window. Counting only
 * `source` measured "unclaimed source entries" while the field claimed to measure unauthorized READS — on the
 * first wcp overview that left `manifest` 11, `readme` 3 and `search` 5 outside both buckets, a fourth state
 * in a field whose whole purpose is to have none.
 */
const READ_DERIVED_EVIDENCE_KINDS: ReadonlySet<EvidenceItem["kind"]> = new Set(["source", "readme", "manifest", "search"]);

/**
 * Recorded reads that no execution claims, with their ids.
 *
 * Every `ReadExecutionRecord` names the evidence its authorized read produced, so the unclaimed remainder is
 * exactly the reads that happened outside the authorization chain. With no results at all, every recorded read
 * is unaccounted — the honest reading, not a reason to report zero.
 *
 * The ids travel with the count because a bare `10` cannot be acted on: an auditor holding it has no way to
 * find which reads were unaccounted.
 */
function unclaimedReads(results: InvestigationResults | null, evidence: readonly EvidenceItem[]): readonly string[] {
  const claimed = new Set<string>();
  for (const execution of results?.executions ?? []) for (const id of execution.evidenceIds) claimed.add(id);
  return evidence.filter((item) => READ_DERIVED_EVIDENCE_KINDS.has(item.kind) && !claimed.has(item.id)).map((item) => item.id).sort();
}

function buildClosure(plan: InvestigationPlan, results: InvestigationResults | null, evidence: readonly EvidenceItem[]): KnowledgeCompleteness["closure"] {
  const byStatus: Record<string, number> = {};
  for (const item of plan.items) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
  return {
    workItems: {
      positive: byStatus.found ?? 0,
      negative: (byStatus["searched-not-found"] ?? 0) + (byStatus["cannot-determine"] ?? 0) + (byStatus["not-applicable"] ?? 0),
      pending: (byStatus.pending ?? 0) + (byStatus.in_progress ?? 0),
      byStatus
    },
    decisions: {
      positive: results?.dispositions.filter((row) => row.status === "fulfilled").length ?? 0,
      negative: results?.dispositions.filter((row) => row.status === "closed-negative").length ?? 0,
      pending: results?.dispositions.filter((row) => row.status === "pending").length ?? 0,
      displaced: results?.dispositions.filter((row) => row.status === "displaced").length ?? 0
    },
    probeResiduals: results?.residuals.length ?? 0,
    materialFlowsWithTraces: plan.items.filter((item) => item.material && item.status === "found" && MATERIAL_FLOW_DIMENSIONS.has(item.dimension) && item.traceIds.length > 0).length,
    // Recorded only when the results were there to count. A sealed `authorizedReads: 0` says "this run
    // authorized no reading"; an absent one says "the check never saw the results" — two different facts that
    // a `?? 0` would print as the same number.
    ...(results ? {
      authorizedReads: results.executions.length,
      readsDisplacedByBudget: results.executions.filter((row) => row.outcome === "budget-displaced").length
    } : {}),
    sourceReadsWithoutObligation: unclaimedReads(results, evidence).length
  };
}

function groupDomains(sources: CompletenessSource[]): DomainCompleteness[] {
  const groups = new Map<string, CompletenessSource[]>();
  for (const row of sources) {
    const key = `${row.coverageDomain}\0${row.unitKind}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row); else groups.set(key, [row]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, rows]) => {
    const sorted = rows.sort((a, b) => a.id.localeCompare(b.id));
    return { coverageDomain: sorted[0]!.coverageDomain, unitKind: sorted[0]!.unitKind,
      status: sorted.every((row) => row.status === "complete") ? "complete" : "limited", sources: sorted };
  });
}

function source(id: string, coverageDomain: CompletenessSource["coverageDomain"], unitKind: CompletenessSource["unitKind"],
  artifact: string, contentDigest: string, producerVersion: string, denominatorRows: number,
  accounting: Record<string, number>, limitations: string[]): CompletenessSource {
  return { id, coverageDomain, unitKind, identity: { artifact, contentDigest, producerVersion }, denominatorRows,
    accounting, status: limitations.length ? "limited" : "complete", limitations };
}

async function readResult<T>(runDir: string, relativePath: string, findings: AuditFinding[]): Promise<T | null> {
  const path = join(runDir, relativePath);
  if (!await exists(path)) return null; // contract-instances owns missing-path findings.
  let result: ArtifactResult<T>;
  try { result = await readJson<ArtifactResult<T>>(path); }
  catch (readError) {
    findings.push(error("completeness", `${relativePath} cannot be read: ${(readError as Error).message}`));
    return null;
  }
  switch (result.status) {
    case "built": return result.value;
    case "not-applicable": findings.push(error("completeness", `${relativePath} has no denominator because it is NotApplicable(${result.determination})`)); return null;
    case "unavailable": findings.push(error("completeness", `${relativePath} has no denominator because it is Unavailable(${result.cause})`)); return null;
    default: return assertNever(result, `${relativePath} artifact result`);
  }
}

function emptyCoverage(): { total: number; counted: number; excluded: number; unexplained: number } { return { total: 0, counted: 0, excluded: 0, unexplained: 0 }; }
function addCoverage<T extends { total: number; counted: number; excluded: number; unexplained: number }>(out: T, row: T): T {
  out.total += row.total; out.counted += row.counted; out.excluded += row.excluded; out.unexplained += row.unexplained; return out;
}
function balancedCoverage(row: { total: number; counted: number; excluded: number; unexplained: number }): boolean { return row.total === row.counted + row.excluded + row.unexplained; }
function sameCoverage(a: { total: number; counted: number; excluded: number; unexplained: number }, b: { total: number; counted: number; excluded: number; unexplained: number }): boolean { return a.total === b.total && a.counted === b.counted && a.excluded === b.excluded && a.unexplained === b.unexplained; }
function numericCoverage(row: { total: number; counted: number; excluded: number; unexplained: number }): Record<string, number> { return { total: row.total, counted: row.counted, excluded: row.excluded, unexplained: row.unexplained }; }
function emptySelection(): { counted: number; seated: number; zeroScore: number; displaced: number } { return { counted: 0, seated: 0, zeroScore: 0, displaced: 0 }; }
function addSelection<T extends { counted: number; seated: number; zeroScore: number; displaced: number }>(out: T, row: T): T { out.counted += row.counted; out.seated += row.seated; out.zeroScore += row.zeroScore; out.displaced += row.displaced; return out; }
function balancedSelection(row: { counted: number; seated: number; zeroScore: number; displaced: number }): boolean { return row.counted === row.seated + row.zeroScore + row.displaced; }
function sameSelection(a: { counted: number; seated: number; zeroScore: number; displaced: number }, b: { counted: number; seated: number; zeroScore: number; displaced: number }): boolean { return a.counted === b.counted && a.seated === b.seated && a.zeroScore === b.zeroScore && a.displaced === b.displaced; }
function numericSelection(row: { counted: number; seated: number; zeroScore: number; displaced: number }): Record<string, number> { return { counted: row.counted, seated: row.seated, zeroScore: row.zeroScore, displaced: row.displaced }; }
function error(document: string, message: string): AuditFinding { return { level: "error", document, message }; }
