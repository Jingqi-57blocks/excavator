import { join, resolve } from "node:path";
import type { ChecklistItem, EvidenceItem, InvestigationChecklist, InvestigationPlan, InvestigationWorkItem, RunManifest, SearchReceipt, TraceCatalog, TraceRecord } from "../../base/types.ts";
import { exists, nowIso, readJson, redactionCacheTag, REDACTION_VERSION, sha256, stableJson, writeJson } from "../../base/util.ts";
import { appendTimeline } from "../../base/timeline.ts";
import { normalizeSupplement, recordSupplement } from "../../freeze/freeze.ts";
import { checklistUpdatesToWorkItems, mergeChecklist, mergeWorkItems, workItemsToChecklist } from "../../investigation/assurance.ts";
import { mergeTraces } from "../../investigation/investigation-artifacts.ts";
import { MAX_WINDOW_LINES, SourceReader, evidenceFromWindow, sourceSearch, type SourceSearchStats } from "../../snapshot/source.ts";
import { projectCacheDir, reDeriveIdentities } from "./runtime-identity.ts";
import { appendEvidence } from "../../investigation/evidence-store.ts";

export const SOURCE_SEARCH_VERSION = `source-search-v4-ranking-v1-${REDACTION_VERSION}`;

/** Cache identity for one redaction mode, exactly as `windowCacheVersion` is for windows. */
export function searchCacheVersion(redact: boolean): string {
  return `${SOURCE_SEARCH_VERSION}${redactionCacheTag(redact)}`;
}

/** The supplement flag pair a runtime mutator may carry, threaded from the CLI. */
export type SupplementInput = { reason?: string; workItemId?: string } | undefined;

function frozenGateError(command: string): Error {
  return new Error(`Run is frozen; \`${command}\` after freeze requires a supplement: pass --supplement-reason "<why the frozen knowledge is insufficient>" and --supplement-workitem <existing work item id>. Consume the frozen investigation knowledge as-is unless it is genuinely incomplete.`);
}

/**
 * The write-time freeze gate shared by the five runtime mutators. Before freeze it is a no-op. After freeze
 * a mutation must carry a supplement whose work item resolves in `workitems.json`.
 */
async function enforceFreezeGate(runDir: string, manifest: RunManifest, command: string, supplement: SupplementInput): Promise<{ reason: string; workItemId: string } | undefined> {
  const normalized = normalizeSupplement(supplement?.reason, supplement?.workItemId);
  if (!manifest.frozenAt) return undefined;
  if (!normalized) throw frozenGateError(command);
  const plan = await readJson<InvestigationPlan>(join(runDir, "workitems.json"));
  if (!plan.items.some((item) => item.id === normalized.workItemId)) {
    throw new Error(`Supplement work item not found in workitems.json: ${normalized.workItemId}. Pass --supplement-workitem with an existing work item id.`);
  }
  return normalized;
}

function supplementTimelineData(supplement: { reason: string; workItemId: string } | undefined): Record<string, unknown> {
  return supplement ? { supplement: true, supplementReason: supplement.reason, workItemId: supplement.workItemId } : {};
}

export async function addSourceEvidence(runDirInput: string, relativePath: string, startLine: number, endLine: number, reason: string, supplement?: SupplementInput): Promise<Record<string, unknown>> {
  const runDir = resolve(runDirInput);
  const runPath = join(runDir, "run.json");
  const manifest = await readJson<RunManifest>(runPath);
  if (!manifest.snapshot) throw new Error("Run has no source snapshot");
  const supp = await enforceFreezeGate(runDir, manifest, "source", supplement);
  const remainingWindows = Math.max(0, manifest.request.budgets.maxSourceWindows - manifest.metrics.sourceWindows);
  const remainingCharacters = Math.max(0, manifest.request.budgets.maxSourceCharacters - manifest.metrics.sourceCharacters);
  const reader = new SourceReader({
    target: manifest.request.target,
    snapshotId: manifest.snapshot.id,
    cacheDir: projectCacheDir(runDir),
    maxWindows: remainingWindows,
    maxCharacters: remainingCharacters,
    redact: Boolean(manifest.request.redactSecrets),
  });
  const window = await reader.window(relativePath, startLine, endLine, reason);
  const recorded = await appendEvidence(runDir, evidenceFromWindow(window), manifest.request.redactSecrets === true);
  manifest.evidenceDigest = recorded.checkpoint.tailDigest;
  manifest.metrics.sourceWindows += reader.stats.windows;
  manifest.metrics.sourceWindowCacheHits += reader.stats.hits;
  manifest.metrics.sourceCharacters += reader.stats.characters;
  manifest.updatedAt = nowIso();
  if (supp) manifest.metrics.supplements = (manifest.metrics.supplements ?? 0) + 1;
  await appendTimeline(runDir, manifest.id, { stage: "investigation", action: "source.window", subject: relativePath, evidenceIds: [window.id], data: { startLine, endLine, reason, cacheHit: reader.stats.hits > 0, ...supplementTimelineData(supp) } });
  manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
  await writeJson(runPath, manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);
  if (supp) await recordSupplement(runDir, "source", [window.id], supp);

  const short = window.endLine < endLine;
  const totalLines = short ? await reader.lineCount(relativePath) : 0;
  const cappedAt = short && window.endLine < totalLines;
  return {
    evidence: recorded.item,
    cacheHit: reader.stats.hits > 0,
    ...(cappedAt
      ? { clamped: true, requestedEndLine: endLine, unreadFrom: window.endLine + 1, unreadThrough: Math.min(endLine, totalLines), notice: `Only lines ${window.startLine}-${window.endLine} were recorded: one window holds at most ${MAX_WINDOW_LINES} lines. Lines ${window.endLine + 1}-${Math.min(endLine, totalLines)} are still unread — open another window if they carry behavior.` }
      : short
        ? { requestedEndLine: endLine, notice: `The file ends at line ${totalLines}; lines ${totalLines + 1}-${endLine} do not exist, so nothing is left unread here.` }
        : {}),
  };
}

export async function searchSourceEvidence(runDirInput: string, termsInput: string[], reason: string, options: { maxResults?: number; pathPrefixes?: string[]; regex?: boolean; caseSensitive?: boolean } = {}, supplement?: SupplementInput): Promise<Record<string, unknown>> {
  const runDir = resolve(runDirInput);
  const runPath = join(runDir, "run.json");
  const manifest = await readJson<RunManifest>(runPath);
  if (!manifest.snapshot) throw new Error("Run has no source snapshot");
  const supp = await enforceFreezeGate(runDir, manifest, "search", supplement);
  const terms = [...new Set(termsInput.map((term) => term.trim()).filter((term) => options.regex ? term.length > 0 : term.length >= 2))];
  if (!terms.length) throw new Error(options.regex ? "Regex source search requires a non-empty expression" : "Source search requires at least one term of two or more characters");
  const maxResults = Math.min(200, Math.max(1, options.maxResults ?? 50));
  const pathPrefixes = [...new Set((options.pathPrefixes ?? []).map((prefix) => prefix.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean))];
  if (pathPrefixes.some((prefix) => prefix === ".." || prefix.startsWith("../") || prefix.includes("/../"))) throw new Error("Source search path prefix escapes the target");

  const identities = await reDeriveIdentities(runDir, manifest);
  if (!identities) throw new Error("Run has no source snapshot");
  if (!identities.drift.comparable) {
    throw new Error(`Source snapshot identity cannot be re-derived: this run was prepared by scanner ${identities.drift.recordedScannerVersion} and the current scanner is ${identities.drift.currentScannerVersion}. Re-prepare the run before recording more evidence against it.`);
  }
  if (identities.drift.snapshotChanged) throw new Error("Source snapshot changed after context preparation");
  const current = identities.current;
  const scopedFiles = pathPrefixes.length
    ? current.files.filter((file) => pathPrefixes.some((prefix) => file.relativePath === prefix || file.relativePath.startsWith(`${prefix}/`)))
    : current.files;
  const searchVersion = searchCacheVersion(manifest.request.redactSecrets === true);
  const key = sha256(stableJson({ searchVersion, snapshotId: manifest.snapshot.id, terms: [...terms].sort(), pathPrefixes: [...pathPrefixes].sort(), maxResults, regex: Boolean(options.regex), caseSensitive: Boolean(options.caseSensitive) }));
  const cachePath = join(projectCacheDir(runDir), "searches", manifest.snapshot.id, `${key}.json`);
  const cached = await exists(cachePath) ? await readJson<SearchReceipt>(cachePath) : null;
  let data: SearchReceipt;
  let cacheHit = false;
  if (cached && cached.searchVersion === searchVersion) {
    data = cached;
    cacheHit = true;
  } else {
    const stats: SourceSearchStats = { total: 0, returned: 0, truncated: false };
    const matches = await sourceSearch(scopedFiles, terms, { maxResults, regex: options.regex, caseSensitive: options.caseSensitive, redact: manifest.request.redactSecrets === true }, stats);
    data = {
      searchVersion,
      terms,
      pathPrefixes,
      candidateFiles: scopedFiles.length,
      maxResults,
      regex: Boolean(options.regex),
      caseSensitive: Boolean(options.caseSensitive),
      truncated: stats.truncated,
      ...(stats.truncated ? { atLeast: stats.total } : {}),
      matches: matches.map((match) => ({ path: match.file.relativePath, line: match.line, excerpt: match.excerpt, matchedTerms: match.matchedTerms, score: match.score })),
    };
    await writeJson(cachePath, data);
  }
  const item: EvidenceItem = {
    id: `SEARCH-${key.slice(0, 12)}`,
    snapshotId: manifest.snapshot.id,
    kind: "search",
    title: `Source search: ${terms.join(", ")}`,
    data,
    reason,
    digest: sha256(stableJson(data)),
  };
  const recorded = await appendEvidence(runDir, item, manifest.request.redactSecrets === true);
  manifest.evidenceDigest = recorded.checkpoint.tailDigest;
  manifest.metrics.sourceSearches = (manifest.metrics.sourceSearches ?? 0) + (cacheHit ? 0 : 1);
  manifest.metrics.sourceSearchCacheHits = (manifest.metrics.sourceSearchCacheHits ?? 0) + (cacheHit ? 1 : 0);
  manifest.metrics.sourceFilesSearched = (manifest.metrics.sourceFilesSearched ?? 0) + (cacheHit ? 0 : scopedFiles.length);
  manifest.updatedAt = nowIso();
  if (supp) manifest.metrics.supplements = (manifest.metrics.supplements ?? 0) + 1;
  await appendTimeline(runDir, manifest.id, { stage: "investigation", action: "source.search", evidenceIds: [item.id], data: { terms, pathPrefixes, maxResults, cacheHit, matchCount: Array.isArray(data.matches) ? data.matches.length : 0, reason, ...supplementTimelineData(supp) } });
  manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
  await writeJson(runPath, manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);
  if (supp) await recordSupplement(runDir, "search", [item.id], supp);
  return { evidence: recorded.item, cacheHit, ...((recorded.item.data as SearchReceipt | undefined) ?? data) };
}

export async function updateChecklist(runDirInput: string, updates: Partial<ChecklistItem>[], supplement?: SupplementInput): Promise<InvestigationChecklist> {
  const runDir = resolve(runDirInput);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const supp = await enforceFreezeGate(runDir, manifest, "checklist", supplement);
  const path = join(runDir, "checklist.json");
  const existing = await readJson<InvestigationChecklist>(path);
  const merged = mergeChecklist(existing, updates);
  await writeJson(path, merged);
  const planPath = join(runDir, "workitems.json");
  const plan = mergeWorkItems(await readJson<InvestigationPlan>(planPath), checklistUpdatesToWorkItems(updates));
  await writeJson(planPath, plan);
  const ids = updates.map((item) => item.id).filter((id): id is string => Boolean(id));
  manifest.metrics.workItems = { total: plan.items.length, complete: plan.items.filter((item) => !["pending", "in_progress"].includes(item.status)).length };
  if (supp) manifest.metrics.supplements = (manifest.metrics.supplements ?? 0) + 1;
  await appendTimeline(runDir, manifest.id, { stage: "investigation", action: "workitems.updated", workItemIds: ids, ...(supp ? { data: supplementTimelineData(supp) } : {}) });
  manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
  await writeJson(join(runDir, "run.json"), manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);
  if (supp) await recordSupplement(runDir, "checklist", ids, supp);
  return merged;
}

export async function updateWorkItems(runDirInput: string, updates: Partial<InvestigationWorkItem>[], supplement?: SupplementInput): Promise<InvestigationPlan> {
  const runDir = resolve(runDirInput);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const supp = await enforceFreezeGate(runDir, manifest, "workitem", supplement);
  const path = join(runDir, "workitems.json");
  const plan = mergeWorkItems(await readJson<InvestigationPlan>(path), updates);
  await writeJson(path, plan);
  await writeJson(join(runDir, "checklist.json"), workItemsToChecklist(plan));
  const ids = updates.map((item) => item.id).filter((id): id is string => Boolean(id));
  manifest.metrics.workItems = { total: plan.items.length, complete: plan.items.filter((item) => !["pending", "in_progress"].includes(item.status)).length };
  if (supp) manifest.metrics.supplements = (manifest.metrics.supplements ?? 0) + 1;
  await appendTimeline(runDir, manifest.id, { stage: "investigation", action: "workitems.updated", workItemIds: ids, ...(supp ? { data: supplementTimelineData(supp) } : {}) });
  manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
  await writeJson(join(runDir, "run.json"), manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);
  if (supp) await recordSupplement(runDir, "workitem", ids, supp);
  return plan;
}

export async function updateTraces(runDirInput: string, updates: TraceRecord[], supplement?: SupplementInput): Promise<TraceCatalog> {
  const runDir = resolve(runDirInput);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  const supp = await enforceFreezeGate(runDir, manifest, "trace", supplement);
  const path = join(runDir, "traces.json");
  const catalog = mergeTraces(await readJson<TraceCatalog>(path), updates);
  await writeJson(path, catalog);
  const ids = updates.map((trace) => trace.id);
  manifest.metrics.traces = catalog.traces.length;
  if (supp) manifest.metrics.supplements = (manifest.metrics.supplements ?? 0) + 1;
  await appendTimeline(runDir, manifest.id, { stage: "investigation", action: "traces.updated", traceIds: ids, ...(supp ? { data: supplementTimelineData(supp) } : {}) });
  manifest.metrics.timelineEvents = (manifest.metrics.timelineEvents ?? 0) + 1;
  await writeJson(join(runDir, "run.json"), manifest);
  await writeJson(join(runDir, "metrics.json"), manifest.metrics);
  if (supp) await recordSupplement(runDir, "trace", ids, supp);
  return catalog;
}
