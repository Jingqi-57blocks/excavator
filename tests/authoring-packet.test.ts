import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { DocumentPlan, EvidenceItem, FeatureFactPack, InvestigationPlan, InvestigationWorkItem, SectionClaim, TraceCatalog, TraceRecord } from "../src/base/types.ts";
import { auditAuthoringPacketConsumption, buildAuthoringPacket, DIMENSION_FACT_CATEGORY, packetEvidenceForDocument } from "../src/report/authoring-packet.ts";
import { FACT_PACK_CATEGORIES } from "../src/context/factpack.ts";
import { freezeRun, prepareRun } from "../src/run/run.ts";
import { atomicWrite, exists } from "../src/base/util.ts";
import { copyFixture, createCodeGraphFixture, disposeAllWorkItems, tempDir } from "./helpers.ts";
import { v2Pack, type FactPackItemSeed } from "./factpack-v2-fixture.ts";

const DOC_ID = "feature-abc-engineering";
const NO_TRACES: TraceCatalog = { version: 1, runId: "run-x", traces: [] };

function section(index: number, title: string): DocumentPlan["sections"][number] {
  return { index, title, file: `/x/${index}.md`, claimsFile: `/x/${index}.json`, complete: false };
}
function featureDoc(sections: Array<[number, string]>, id = DOC_ID): DocumentPlan {
  return { id, kind: "feature", audience: "engineering", subject: "Leave", templatePath: "/t", contextPath: "/c", sections: sections.map(([i, t]) => section(i, t)) };
}
function overviewDoc(): DocumentPlan {
  return { id: "overview-product", kind: "overview", audience: "product", templatePath: "/t", contextPath: "/c", sections: [section(1, "Purpose"), section(2, "System parts")] };
}
function wi(partial: Partial<InvestigationWorkItem> & { id: string; dimension: string }): InvestigationWorkItem {
  return {
    id: partial.id,
    dimension: partial.dimension,
    scope: partial.scope ?? "feature:abc",
    hypothesis: partial.hypothesis ?? `hypothesis for ${partial.dimension}`,
    status: partial.status ?? "found",
    material: partial.material ?? true,
    requiredFor: partial.requiredFor ?? [DOC_ID],
    evidenceIds: partial.evidenceIds ?? [],
    traceIds: partial.traceIds ?? [],
    reportSection: partial.reportSection,
    searchScope: partial.searchScope,
    reason: partial.reason,
    settledBy: partial.settledBy,
    origin: partial.origin ?? "default"
  };
}
function plan(items: InvestigationWorkItem[]): InvestigationPlan {
  return { version: 1, runId: "run-x", createdAt: "2026-01-01T00:00:00Z", items };
}
function sourceEvidence(id: string, content: string): EvidenceItem {
  return { id, snapshotId: "snap", kind: "source", title: `${id} window`, path: "svc/service.go", startLine: 500, endLine: 520, content, reason: "r", digest: "d" };
}
function factEvidence(id: string, category: string, itemCount: number, truncated: boolean): EvidenceItem {
  return { id, snapshotId: "snap", kind: "derived", title: `Fact pack: ${category}`, data: { category, coverage: { category, method: "scan", itemCount, truncated } }, reason: "r", digest: "d" };
}
function searchEvidence(id: string): EvidenceItem {
  return { id, snapshotId: "snap", kind: "search", title: "search", data: { terms: ["escalation"], candidateFiles: 12, truncated: false, matches: [{ path: "svc/service.go", line: 1, excerpt: "x", matchedTerms: ["escalation"], score: 1 }] }, reason: "r", digest: "d" };
}
function evidenceMap(items: EvidenceItem[]): Map<string, EvidenceItem> {
  return new Map(items.map((item) => [item.id, item]));
}
function factPack(items: FactPackItemSeed[], coverage: FeatureFactPack["coverage"]): Record<string, FeatureFactPack> {
  return { abc: v2Pack(items, { featureKey: "abc", snapshotId: "snap", coverage }) };
}

// --- 1. determinism ---

test("buildAuthoringPacket is deterministic: the same inputs render byte-identical output", () => {
  const document = featureDoc([[2, "Entry points"], [4, "States"], [6, "Data"]]);
  const workItems = plan([
    wi({ id: "feature:abc:ui-entrypoints", dimension: "ui-entrypoints", reportSection: 2, evidenceIds: ["S-2"] }),
    wi({ id: "feature:abc:states-and-lifecycle", dimension: "states-and-lifecycle", reportSection: 4, evidenceIds: ["S-4"], traceIds: ["T-1"] }),
    wi({ id: "feature:abc:entities-and-fields", dimension: "entities-and-fields", reportSection: 6, evidenceIds: ["FACT-abc-entities", "SEARCH-1"] })
  ]);
  const evidence = evidenceMap([sourceEvidence("S-2", "line"), sourceEvidence("S-4", "state\ncode"), factEvidence("FACT-abc-entities", "entities", 3, false), searchEvidence("SEARCH-1")]);
  const traces: TraceCatalog = { version: 1, runId: "run-x", traces: [{ id: "T-1", title: "flow", type: "business-flow", status: "verified", confidence: "high", documentIds: [DOC_ID], steps: [{ index: 1, action: "a", evidenceIds: ["S-4"] }], createdAt: "2026-01-01T00:00:00Z" }] };
  const packs = factPack([{ category: "entities", name: "LeaveRecord", filePath: "svc/model.go", line: 10, source: "graph" }], [{ category: "entities", method: "graph", itemCount: 1, truncated: false }]);
  const first = buildAuthoringPacket(document, workItems, evidence, traces, packs);
  const second = buildAuthoringPacket(document, workItems, evidence, traces, packs);
  assert.equal(first, second);
  assert.ok(first.length > 0);
});

// --- 2. organization ---

test("feature packets block by reportSection with template titles; empty sections are omitted", () => {
  const document = featureDoc([[2, "Entry points"], [3, "Rules"], [4, "States"], [6, "Data"]]);
  const workItems = plan([
    wi({ id: "feature:abc:ui-entrypoints", dimension: "ui-entrypoints", reportSection: 2, evidenceIds: ["S-2"] }),
    wi({ id: "feature:abc:states-and-lifecycle", dimension: "states-and-lifecycle", reportSection: 4, evidenceIds: ["S-4"] }),
    wi({ id: "feature:abc:entities-and-fields", dimension: "entities-and-fields", reportSection: 6, evidenceIds: ["S-6"] })
  ]);
  const blocks = packetEvidenceForDocument(document, workItems);
  assert.deepEqual(blocks.map((block) => block.key), ["section 2", "section 4", "section 6"], "section 3 owns no work item and is omitted");

  const markdown = buildAuthoringPacket(document, workItems, evidenceMap([sourceEvidence("S-2", "a"), sourceEvidence("S-4", "b"), sourceEvidence("S-6", "c")]), NO_TRACES, {});
  assert.ok(markdown.includes("## Section 2 — Entry points"));
  assert.ok(markdown.includes("## Section 4 — States"));
  assert.ok(markdown.includes("## Section 6 — Data"));
  assert.ok(!markdown.includes("Rules"), "the empty Rules section is omitted, title and all");
});

test("reportSection-less logic-disposition items surface in a trailing block instead of vanishing", () => {
  const document = featureDoc([[2, "Entry points"], [3, "Rules"]]);
  const workItems = plan([
    wi({ id: "feature:abc:ui-entrypoints", dimension: "ui-entrypoints", reportSection: 2, evidenceIds: ["S-2"] }),
    wi({ id: "feature:abc:logic:CalculationAuto@svc/service.go:415", dimension: "logic-disposition", reportSection: undefined, status: "pending", evidenceIds: [] })
  ]);
  const blocks = packetEvidenceForDocument(document, workItems);
  assert.deepEqual(blocks.map((block) => block.key), ["section 2", "logic-disposition"], "the unpinned logic item forms a trailing block, section 3 (empty) is omitted");
  const markdown = buildAuthoringPacket(document, workItems, evidenceMap([sourceEvidence("S-2", "a")]), NO_TRACES, {});
  assert.ok(markdown.includes("## Logic disposition — rescued decision functions (place each where its behavior belongs)"));
  assert.ok(markdown.includes("`feature:abc:logic:CalculationAuto@svc/service.go:415`"), "the forced logic item is listed for the author");
});

test("overview packets list project work items in one single-level block, no per-section split", () => {
  const document = overviewDoc();
  const workItems = plan([
    wi({ id: "project:literal-secrets", dimension: "literal-secrets", scope: "project", requiredFor: ["overview-product"], reportSection: undefined, evidenceIds: ["S-1"] }),
    wi({ id: "project:guard-polarity", dimension: "guard-polarity", scope: "project", requiredFor: ["overview-product"], reportSection: undefined, evidenceIds: ["S-2"] })
  ]);
  const blocks = packetEvidenceForDocument(document, workItems);
  assert.deepEqual(blocks.map((block) => block.key), ["project"]);
  const markdown = buildAuthoringPacket(document, workItems, evidenceMap([sourceEvidence("S-1", "a"), sourceEvidence("S-2", "b")]), NO_TRACES, {});
  assert.ok(markdown.includes("## Project investigation"));
  assert.ok(!/## Section \d/.test(markdown), "an overview packet carries no per-section blocks");
});

test("a prd feature packet flattens §10-12-pinned work items into one block instead of vanishing (57B-380)", () => {
  // prd-feature.md has 10 chapters, but work-item reportSections run 1..12. In a section-keyed packet a §10-12
  // item would match no section block yet is not `undefined`, so it would silently vanish. The prd path uses
  // one flat "feature" block for every pinned item, plus the trailing logic-disposition block.
  const prdDoc: DocumentPlan = { id: "feature-abc-prd", kind: "feature", audience: "prd", subject: "Leave", templatePath: "/t", contextPath: "/c", sections: [section(1, "Boundary"), section(2, "Rules")] };
  const workItems = plan([
    wi({ id: "feature:abc:boundary", dimension: "boundary", reportSection: 1, requiredFor: ["feature-abc-prd"], evidenceIds: ["S-1"] }),
    wi({ id: "feature:abc:connected-change-scope", dimension: "connected-change-scope", reportSection: 10, requiredFor: ["feature-abc-prd"], evidenceIds: ["S-10"] }),
    wi({ id: "feature:abc:tests", dimension: "tests", reportSection: 11, requiredFor: ["feature-abc-prd"], evidenceIds: ["S-11"] }),
    wi({ id: "feature:abc:coverage-accounting", dimension: "coverage-accounting", reportSection: 12, requiredFor: ["feature-abc-prd"], evidenceIds: ["S-12"] }),
    wi({ id: "feature:abc:logic:Calc@svc/service.go:415", dimension: "logic-disposition", reportSection: undefined, requiredFor: ["feature-abc-prd"], status: "pending", evidenceIds: [] })
  ]);
  const blocks = packetEvidenceForDocument(prdDoc, workItems);
  assert.deepEqual(blocks.map((block) => block.key), ["feature", "logic-disposition"]);
  const featureBlock = blocks.find((block) => block.key === "feature")!;
  const ids = featureBlock.workItems.map((item) => item.id);
  for (const id of ["feature:abc:boundary", "feature:abc:connected-change-scope", "feature:abc:tests", "feature:abc:coverage-accounting"]) {
    assert.ok(ids.includes(id), `${id} vanished from the prd packet`);
  }
  assert.deepEqual(featureBlock.evidenceIds, ["S-1", "S-10", "S-11", "S-12"]);

  const markdown = buildAuthoringPacket(prdDoc, workItems, evidenceMap([sourceEvidence("S-1", "a"), sourceEvidence("S-10", "b"), sourceEvidence("S-11", "c"), sourceEvidence("S-12", "d")]), NO_TRACES, {});
  assert.ok(markdown.includes("## Feature investigation"));
  assert.ok(markdown.includes("## Logic disposition — rescued decision functions (place each where its behavior belongs)"));
  assert.ok(!/## Section \d/.test(markdown), "a prd packet carries no per-section blocks");
});

// --- 3. excerpt discipline ---

test("excerpts clip with a footnote; FACT/SEARCH/trace render as summary lines; evidence deduplicates across sections", () => {
  const document = featureDoc([[4, "States"], [6, "Data"]]);
  const longContent = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
  const workItems = plan([
    wi({ id: "feature:abc:states-and-lifecycle", dimension: "states-and-lifecycle", reportSection: 4, evidenceIds: ["S-long", "S-shared"], traceIds: ["T-1"] }),
    wi({ id: "feature:abc:entities-and-fields", dimension: "entities-and-fields", reportSection: 6, evidenceIds: ["S-shared", "FACT-abc-entities", "SEARCH-1"] })
  ]);
  const evidence = evidenceMap([sourceEvidence("S-long", longContent), sourceEvidence("S-shared", "shared window"), factEvidence("FACT-abc-entities", "entities", 4, true), searchEvidence("SEARCH-1")]);
  const traces: TraceCatalog = { version: 1, runId: "run-x", traces: [{ id: "T-1", title: "Leave decision flow", type: "business-flow", status: "verified", confidence: "high", documentIds: [DOC_ID], steps: [{ index: 1, action: "a", evidenceIds: [] }, { index: 2, action: "b", evidenceIds: [] }, { index: 3, action: "c", evidenceIds: [] }], createdAt: "2026-01-01T00:00:00Z" }] };
  const markdown = buildAuthoringPacket(document, workItems, evidence, traces, factPack(
    ["A", "B", "C", "D"].map((name, index) => ({ category: "entities" as const, name, filePath: "svc/model.go", line: index + 1, source: "scan" as const, granularity: "source-line" as const })),
    [{ category: "entities", method: "scan", itemCount: 4, truncated: true, note: "item cap reached" }]
  ));

  assert.ok(markdown.includes("line 40") && !markdown.includes("line 41"), "excerpt keeps the first 40 lines only");
  assert.ok(markdown.includes("…clipped; full excerpt: evidence.json id S-long"), "a clipped excerpt carries the honest footnote");
  assert.ok(markdown.includes('search "escalation": 12 candidate file(s), 1 match(es)'), "search receipts render as one summary line");
  assert.ok(/fact pack entities: 4 item\(s\), truncated yes/.test(markdown), "FACT-* renders a coverage summary, not inline items");
  assert.ok(/`T-1` — Leave decision flow · verified · 3 steps/.test(markdown), "a trace renders id, title, status and step count");
  assert.ok(markdown.includes("`S-shared` — see the section 4 block"), "an evidence item seen earlier is referenced, not re-excerpted");
});

// --- 4. fact-pack layer ---

test("fact-pack items land in the section owning their category; truncated notes survive; a missing pack is honest", () => {
  const document = featureDoc([[4, "States"], [6, "Data"]]);
  const workItems = plan([
    wi({ id: "feature:abc:states-and-lifecycle", dimension: "states-and-lifecycle", reportSection: 4, evidenceIds: ["S-4"] }),
    wi({ id: "feature:abc:entities-and-fields", dimension: "entities-and-fields", reportSection: 6, evidenceIds: ["S-6"] })
  ]);
  const evidence = evidenceMap([sourceEvidence("S-4", "a"), sourceEvidence("S-6", "b")]);
  const packs = factPack(
    [
      { category: "states", name: "LeaveStatus", filePath: "svc/constant/leave.go", line: 51, source: "graph" },
      { category: "entities", name: "LeaveRecord", filePath: "svc/model.go", line: 10, source: "graph" }
    ],
    [
      { category: "states", method: "graph", itemCount: 1, truncated: true, note: "the feature scope node cap was reached upstream" },
      { category: "entities", method: "graph", itemCount: 1, truncated: false }
    ]
  );
  const markdown = buildAuthoringPacket(document, workItems, evidence, NO_TRACES, packs);

  const statesBlock = markdown.split("## Section 4 — States")[1].split("## Section 6 — Data")[0];
  assert.ok(statesBlock.includes("#### states"), "the states category is listed under the section owning states-and-lifecycle");
  assert.ok(statesBlock.includes("`LeaveStatus` — `svc/constant/leave.go:51`"), "the states fact item is rendered with its file:line");
  assert.ok(statesBlock.includes("Truncated: the feature scope node cap was reached upstream"), "a truncated category carries its note verbatim");
  assert.ok(!statesBlock.includes("LeaveRecord"), "an entities item does not leak into the states section");

  const dataBlock = markdown.split("## Section 6 — Data")[1];
  assert.ok(dataBlock.includes("`LeaveRecord` — `svc/model.go:10`"), "the entities fact item lands in the data section");

  // A feature run with no fact pack renders an honest note rather than throwing.
  const noPack = buildAuthoringPacket(document, workItems, evidence, NO_TRACES, {});
  assert.ok(noPack.includes("No fact pack was produced for this feature"));
});

// --- 5. freezeRun integration ---

async function featureRequest() {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return { target, codegraph, workdir, language: "zh-CN", detailLevel: "standard" as const, overviewAudiences: [] as ("product" | "engineering")[], features: [{ subject: "Leave management", aliases: ["leave", "holiday"], audiences: ["product" as const] }], budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 } };
}

test("a successful freeze writes one packet per document; a refused freeze writes none", async () => {
  const { runDir, manifest } = await prepareRun(await featureRequest());
  await disposeAllWorkItems(runDir);
  const result = await freezeRun(runDir);
  assert.equal(result.frozen, true, JSON.stringify(result.findings, null, 2));
  for (const document of manifest.documents) {
    assert.equal(await exists(join(runDir, "context", "authoring", `${document.id}.md`)), true, `packet missing for ${document.id}`);
  }
  const timeline = (await readFile(join(runDir, "timeline.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const frozen = timeline.find((event) => event.action === "investigation.frozen");
  assert.equal((frozen.data as Record<string, unknown>).authoringPackets, manifest.documents.length);

  // A run that still has pending required items is refused, and no packet is written.
  const { runDir: pendingDir, manifest: pendingManifest } = await prepareRun(await featureRequest());
  const refused = await freezeRun(pendingDir);
  assert.equal(refused.frozen, false);
  for (const document of pendingManifest.documents) {
    assert.equal(await exists(join(pendingDir, "context", "authoring", `${document.id}.md`)), false, `refused freeze wrote a packet for ${document.id}`);
  }
});

// --- 6. consumption advisory ---

async function packetRunDir(document: DocumentPlan): Promise<string> {
  const runDir = await tempDir("excavator-packet-");
  await atomicWrite(join(runDir, "context", "authoring", `${document.id}.md`), "packet");
  return runDir;
}
function claims(document: DocumentPlan, entries: Array<{ section: number; evidenceIds: string[] }>): Map<string, Array<{ section: number; claim: SectionClaim }>> {
  return new Map([[document.id, entries.map((entry, i) => ({ section: entry.section, claim: { id: `C-${i}`, marker: "fact" as const, statement: "s", evidenceIds: entry.evidenceIds } }))]]);
}

test("the consumption advisory is silent when evidence is consumed, warns per unconsumed section, and grandfathers a packet-less run", async () => {
  const document = featureDoc([[4, "States"]]);
  const workItems = plan([wi({ id: "feature:abc:states-and-lifecycle", dimension: "states-and-lifecycle", reportSection: 4, evidenceIds: ["S-1", "S-2"] })]);

  const runDir = await packetRunDir(document);
  const consumed = await auditAuthoringPacketConsumption(runDir, [document], workItems, claims(document, [{ section: 4, evidenceIds: ["S-1", "S-2"] }]));
  assert.deepEqual(consumed, [], "no warning when every listed evidence id is consumed by a claim");

  const unconsumed = await auditAuthoringPacketConsumption(runDir, [document], workItems, claims(document, [{ section: 4, evidenceIds: ["S-1"] }]));
  assert.equal(unconsumed.length, 1, "one warning for the section with unconsumed evidence");
  assert.equal(unconsumed[0].level, "warning");
  assert.equal(unconsumed[0].document, document.id);
  assert.ok(unconsumed[0].message.includes("section 4") && unconsumed[0].message.includes("S-2") && !unconsumed[0].message.includes("S-1"), unconsumed[0].message);

  // No packet on disk (fresh run dir): the check self-gates and stays silent, like an unfrozen run.
  const bare = await tempDir("excavator-packet-");
  const grandfathered = await auditAuthoringPacketConsumption(bare, [document], workItems, claims(document, []));
  assert.deepEqual(grandfathered, [], "a packet-less run is grandfathered");
});

// --- 7. mapping completeness (framework-neutral floor) ---

test("every fact-pack category is reachable through the dimension→category map", () => {
  const mapped = new Set(Object.values(DIMENSION_FACT_CATEGORY));
  for (const category of FACT_PACK_CATEGORIES) {
    assert.ok(mapped.has(category), `no dimension maps to fact-pack category ${category}`);
  }
});
