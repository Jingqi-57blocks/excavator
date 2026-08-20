import test from "node:test";
import assert from "node:assert/strict";
import { cp, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { sha256 } from "../src/base/util.ts";
import { tempDir } from "./helpers.ts";
import type { EvidenceItem, InvestigationPlan } from "../src/base/types.ts";
import { GROUNDING_RULES } from "../src/report/unit-grounding-audit.ts";
import { OUTPUT_BUDGET_DEFERRAL, enumeratesUnboundEvidence, renderUnitPacket, unitPacketDigest, UNIT_PACKET_VERSION } from "../src/report/unit-packet.ts";
import { UNIT_PACKET_FORBIDDEN_INPUT_PREFIXES, loadUnitPacketSource, renderUnitPacketForRun } from "../src/report/unit-packet-source.ts";
import { WORK_ITEM_STATUSES } from "../src/report/topic-candidate.ts";
import { plannedRun, unitDraftFor } from "./unit-fixture.ts";
import { checkpointUnit } from "../src/report/unit-checkpoint.ts";
import {
  MINI_FOUND_ONE_EVIDENCE, MINI_FOUND_TWO_EVIDENCE,
  dossierOf, miniPacket, miniPlan, packetInput, reachOf, topicsOf, type MiniPlan
} from "./unit-grounding-fixture.ts";

/**
 * R4b - the unit packet: the view ONE authoring unit is written from.
 *
 * The measured failure it closes (57B-453): a document written from the old per-document packet could not ground
 * 60.1% of its material obligations, and for the evidence the packet DID render it never said which work item that
 * evidence belonged to - so the author inferred the binding from line ranges and got 5 of 18 wrong. Every test
 * below is about one of the two halves of that: the binding is carried at OBLIGATION granularity, and nothing is
 * dropped to fit a byte bound.
 *
 * The pure tests run over the frozen mini fixture with an in-memory plan; the loader tests run over a real planned
 * run. Neither writes into a fixture.
 */

const LEAF_FEATURE = "overview-product::leaf::feature";
const LEAF_DIMENSION = "overview-product::leaf::work-item-dimension";
const APPENDIX = "overview-product::appendix::coverage";
const SYNTHESIS = "overview-product::synthesis::document";

let shared: Promise<MiniPlan> | null = null;
function plan(): Promise<MiniPlan> { return (shared ??= miniPlan()); }

/** The evidence ids the packet's own obligation table gives for one work item, parsed out of the markdown. */
function evidenceIdsFromPacketRow(markdown: string, workItemId: string): string[] {
  const rows = markdown.split("\n").filter((line) => line.startsWith(`| \`${workItemId}\` |`));
  assert.equal(rows.length >= 1, true, `the packet must carry a row for ${workItemId}`);
  const columns = rows[0]!.split("|").map((cell) => cell.trim());
  // `| workItemId | dimension | status | material | evidenceIds | traceIds |` -> index 5 is evidenceIds.
  return [...columns[5]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
}

function traceIdsFromPacketRow(markdown: string, workItemId: string): string[] {
  const row = markdown.split("\n").find((line) => line.startsWith(`| \`${workItemId}\` |`))!;
  const columns = row.split("|").map((cell) => cell.trim());
  return [...columns[6]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
}

// --- (1) obligation granularity: the 57B-453 answerability test ---------------------------------------

test("a material obligation's evidence ids are answerable from its own packet row, verbatim and in ledger order", async () => {
  const mini = await plan();
  const packet = miniPacket(mini, LEAF_FEATURE);
  const ledger = JSON.parse(await readFile(join(mini.runDir, "workitems.json"), "utf8")) as InvestigationPlan;

  // Read INDEPENDENTLY of the code under test: straight out of `workitems.json`, no id transformation.
  for (const workItemId of [MINI_FOUND_TWO_EVIDENCE, MINI_FOUND_ONE_EVIDENCE]) {
    const item = ledger.items.find((row) => row.id === workItemId)!;
    assert.deepEqual(evidenceIdsFromPacketRow(packet.markdown, workItemId), item.evidenceIds,
      `${workItemId}: the packet row must reproduce the ledger's evidence ids exactly, in the ledger's own order`);
    assert.deepEqual(traceIdsFromPacketRow(packet.markdown, workItemId), item.traceIds, `${workItemId}: trace ids too`);
  }
  // The unsorted pair is the point: a renderer that sorted would pass a set comparison and fail this one.
  assert.deepEqual(evidenceIdsFromPacketRow(packet.markdown, MINI_FOUND_TWO_EVIDENCE), ["S-bbbbbbbbbb", "S-aaaaaaaaaa"]);

  // And every id the row names is rendered in full below it, with the obligation it grounds named back.
  for (const evidenceId of ["S-aaaaaaaaaa", "S-bbbbbbbbbb", "S-cccccccccc"]) {
    assert.ok(packet.markdown.includes(`### \`${evidenceId}\``), `${evidenceId} must be rendered as its own block`);
  }
  const block = packet.markdown.slice(packet.markdown.indexOf("### `S-cccccccccc`")).split("\n### ")[0]!;
  assert.ok(block.includes(`grounds obligation(s): \`${MINI_FOUND_ONE_EVIDENCE}\``),
    `the S-cccccccccc block must name the obligation it grounds; got:\n${block}`);
  assert.deepEqual([...packet.renderedEvidenceIds], ["S-aaaaaaaaaa", "S-bbbbbbbbbb", "S-cccccccccc", "S-dddddddddd", "S-eeeeeeeeee"]);
});

test("every obligation of every unit's topics reaches that unit's packet - the closure reading, on the mini plan", async () => {
  const mini = await plan();
  const ledger = JSON.parse(await readFile(join(mini.runDir, "workitems.json"), "utf8")) as InvestigationPlan;
  const byId = new Map(ledger.items.map((item) => [item.id, item]));
  let checked = 0;
  for (const unit of mini.planCatalog.units) {
    if (unit.kind === "synthesis") continue;
    const packet = miniPacket(mini, unit.unitId);
    for (const topic of topicsOf(mini, unit)) {
      for (const binding of topic.bindings) {
        if (!binding.material) continue;
        for (const evidenceId of byId.get(binding.workItemId)!.evidenceIds) {
          assert.ok(packet.renderedEvidenceIds.includes(evidenceId),
            `${unit.unitId} names ${topic.topicId}, which binds ${binding.workItemId}, whose evidence ${evidenceId} is absent from its packet`);
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked > 0, "the closure reading must actually check something");
});

// --- (2) determinism and identity --------------------------------------------------------------------

test("the same inputs render the same bytes, twice", async () => {
  const mini = await plan();
  for (const unitId of [LEAF_FEATURE, LEAF_DIMENSION, APPENDIX]) {
    const first = miniPacket(mini, unitId);
    const second = miniPacket(mini, unitId);
    assert.equal(first.markdown, second.markdown, `${unitId}: byte-identical`);
    assert.equal(unitPacketDigest(first), unitPacketDigest(second));
    assert.equal(first.version, UNIT_PACKET_VERSION);
  }
});

// --- (3) the bound: two forms, neither of them truncation --------------------------------------------

test("over the bound, `refuse` names the bytes and the offending unit's topics", async () => {
  const mini = await plan();
  assert.throws(() => miniPacket(mini, LEAF_FEATURE, { byteLimit: 64, overBudget: "refuse" }), (error: Error) => {
    assert.match(error.message, /renders to \d+ bytes, over the declared bound of 64/);
    assert.match(error.message, /NOTHING has been dropped or shortened/);
    assert.match(error.message, /The offending unit's topics are: feature:/);
    assert.match(error.message, /truncation is not an option here/);
    return true;
  });
});

test("over the bound, `record-limitation` returns the WHOLE packet and says so in the header", async () => {
  const mini = await plan();
  const whole = miniPacket(mini, LEAF_FEATURE, { byteLimit: 1_048_576 });
  const bounded = miniPacket(mini, LEAF_FEATURE, { byteLimit: 64, overBudget: "record-limitation" });
  assert.equal(bounded.limitations.length, 1);
  assert.ok(bounded.bytes > bounded.byteLimit);
  assert.ok(bounded.markdown.includes("## Recorded limitations"), "the overrun is visible in the header, not only in a field");
  assert.match(bounded.limitations[0]!, /NOTHING has been dropped or shortened/);

  // Nothing dropped, stated as a comparison against the in-bound rendering rather than as a claim.
  assert.deepEqual([...bounded.renderedEvidenceIds], [...whole.renderedEvidenceIds]);
  assert.deepEqual([...bounded.obligationIds], [...whole.obligationIds]);
  for (const evidenceId of whole.renderedEvidenceIds) assert.ok(bounded.markdown.includes(`### \`${evidenceId}\``));
  for (const workItemId of whole.obligationIds) assert.ok(bounded.markdown.includes(`| \`${workItemId}\` |`));

  // 57B-453 mechanism B, as an anti-regression: none of the old clipping vocabulary may appear.
  for (const phrase of ["omitted rows remain in the frozen catalog", "clipped in this model view", "byte bound reached", "…"]) {
    assert.ok(!bounded.markdown.includes(phrase), `a unit packet must never contain ${JSON.stringify(phrase)}`);
  }
});

test("a packet inside its bound records no limitation", async () => {
  const mini = await plan();
  const packet = miniPacket(mini, APPENDIX, { byteLimit: 1_048_576 });
  assert.deepEqual([...packet.limitations], []);
  assert.ok(packet.bytes <= packet.byteLimit);
});

// --- (4) the reference is checked, not trusted -------------------------------------------------------

test("a topic whose digest moved is refused by name, with both digests", async () => {
  const mini = await plan();
  const unit = mini.unitsById.get(LEAF_FEATURE)!;
  const topics = topicsOf(mini, unit).map((topic, index) => index === 0 ? { ...topic, digest: "0".repeat(64) } : topic);
  assert.throws(() => renderUnitPacket(packetInput(mini, LEAF_FEATURE, {
    dossier: { source: "topics", topics, evidence: (dossierOf(mini, unit) as { evidence: ReadonlyMap<string, EvidenceItem> }).evidence }
  })), /digests to 0{64} but the recorded plan references [0-9a-f]{64}; the topic moved after the plan was validated/);
});

test("a binding whose evidence was not supplied is refused, not rendered as a gap", async () => {
  const mini = await plan();
  const unit = mini.unitsById.get(LEAF_FEATURE)!;
  const full = dossierOf(mini, unit) as { source: "topics"; topics: ReturnType<typeof topicsOf>; evidence: Map<string, EvidenceItem> };
  const short = new Map(full.evidence);
  short.delete("S-cccccccccc");
  assert.throws(() => renderUnitPacket(packetInput(mini, LEAF_FEATURE, { dossier: { source: "topics", topics: full.topics, evidence: short } })),
    /binds evidence "S-cccccccccc", which was not supplied .*the 57B-453 failure this packet exists to close/s);
});

test("an unknown unit id is refused with the plan's own unit list", async () => {
  const mini = await plan();
  assert.throws(() => renderUnitPacket({ ...packetInput(mini, LEAF_FEATURE), unitId: "not::a::unit" }),
    /Unknown authoring unit "not::a::unit"; this run's recorded plan holds \d+ unit\(s\)/);
});

// --- (5) a synthesis has nowhere to put a topic dossier ----------------------------------------------

test("the synthesis packet carries child summaries and no topic or evidence block at all", async () => {
  const mini = await plan();
  const packet = renderUnitPacket(packetInput(mini, SYNTHESIS, {
    dossier: {
      source: "child-summaries",
      children: [...mini.unitsById.get(SYNTHESIS)!.childUnitIds].sort().map((childUnitId) => ({
        version: "unit-summary-v1" as const,
        unitId: childUnitId,
        documentId: "overview-product",
        kind: mini.unitsById.get(childUnitId)!.kind,
        coveredTopicIds: mini.unitsById.get(childUnitId)!.topics.map((topic) => topic.topicId).sort(),
        keyStatements: [`${childUnitId} 已记录。`],
        unknowns: [],
        terminology: [],
        contentDigest: "1".repeat(64),
        claimsDigest: "2".repeat(64),
        childSummaryDigests: []
      }))
    }
  }));
  assert.ok(packet.markdown.includes("## Child summaries (4)"));
  assert.ok(!packet.markdown.includes("## Obligations bound"), "a synthesis reads no obligation row");
  assert.ok(!packet.markdown.includes("## Evidence bound"), "a synthesis reads no evidence record");
  assert.deepEqual([...packet.renderedEvidenceIds], []);
  assert.deepEqual([...packet.obligationIds], []);
});

test("the two dossier arms are refused when they do not match the unit's kind", async () => {
  const mini = await plan();
  assert.throws(() => renderUnitPacket(packetInput(mini, SYNTHESIS, { dossier: dossierOf(mini, mini.unitsById.get(LEAF_FEATURE)!) })),
    /Synthesis unit .* may not be handed a topic dossier/);
  assert.throws(() => renderUnitPacket(packetInput(mini, LEAF_FEATURE, { dossier: { source: "child-summaries", children: [] } })),
    /is a leaf, so it is written from its topics, not from child summaries/);
});

// --- (6) mechanism A: evidence no obligation binds ---------------------------------------------------

test("the appendix enumerates evidence no obligation binds; a leaf counts it in the header and does not", async () => {
  const mini = await plan();
  const stranded: EvidenceItem = {
    id: "MANIFEST-0000000001", snapshotId: "snap", kind: "manifest", title: "go.mod",
    path: "go.mod", reason: "captured at prepare", digest: "3".repeat(64), content: "module example\n"
  };
  const reach = { ...reachOf(mini), unbound: [stranded], frozenEvidenceIds: mini.evidence.size + 1 };
  const appendix = miniPacket(mini, APPENDIX, { reach });
  const leaf = miniPacket(mini, LEAF_FEATURE, { reach });

  assert.ok(appendix.markdown.includes("## Evidence this run captured that no obligation binds (1 record(s))"));
  assert.ok(appendix.markdown.includes("| `MANIFEST-0000000001` | manifest | go.mod | `go.mod` |"));
  assert.ok(!leaf.markdown.includes("## Evidence this run captured that no obligation binds"), "a leaf is not the coverage tail");
  for (const packet of [appendix, leaf]) {
    assert.match(packet.markdown, /evidence reach: 6 frozen evidence record\(s\) in this run, 5 of them bound by some work item, 1 bound by none/);
    assert.ok(packet.markdown.includes("cannot reach any unit packet through the binding path (obligation → evidence)"));
    assert.ok(packet.markdown.includes(APPENDIX), "every packet names the unit(s) that enumerate them");
  }
  // The census is NOT counted as rendered evidence: it is a list of ids, not the records themselves.
  assert.ok(!appendix.renderedEvidenceIds.includes("MANIFEST-0000000001"));

  // Gate 10's path: the appendix also carries the facet census, with the two empty states kept apart.
  assert.ok(appendix.markdown.includes("## Facet census of this run's Topic Catalog"));
  assert.ok(appendix.markdown.includes("`ledger-absent` (the producer's own artifact is missing or unavailable) and `ledger-empty` (the ledger is"));
  assert.ok(!leaf.markdown.includes("## Facet census"), "a leaf is not the coverage tail");
  const mini2 = await plan();
  for (const row of mini2.catalog.facets.filter((entry) => entry.outcome.state !== "populated")) {
    const reason = row.outcome.state === "populated" ? "" : row.outcome.reason;
    assert.ok(appendix.markdown.includes(`| ${row.facet} | ${row.outcome.state} |`), `${row.facet} must appear with its own state`);
    assert.ok(appendix.markdown.includes(reason), `${row.facet} must carry the ledger's own reason verbatim`);
  }
  assert.deepEqual([true, false, false, false], [enumeratesUnboundEvidence("appendix"), enumeratesUnboundEvidence("leaf"), enumeratesUnboundEvidence("bridge"), enumeratesUnboundEvidence("synthesis")]);
});

// --- (7) the promise the author reads is the rule the audit applies ----------------------------------

test("the packet prints the grounding rule for every status, verbatim from the audit, and defers the output budget", async () => {
  const mini = await plan();
  const packet = miniPacket(mini, LEAF_FEATURE);
  assert.deepEqual(GROUNDING_RULES.map((rule) => rule.status), [...WORK_ITEM_STATUSES], "one rule per status, in the pinned order");
  for (const rule of GROUNDING_RULES) {
    assert.ok(packet.markdown.includes(`- \`${rule.status}\` — needs a ${rule.requires}.`), `the ${rule.status} rule must be printed verbatim`);
  }
  assert.ok(packet.markdown.includes(OUTPUT_BUDGET_DEFERRAL), "the absent output budget is stated, not silently omitted");
  assert.match(packet.markdown, /- input budget \(plan, per unit for overview-product\): 786432 bytes; document total 3145728 bytes/);
  assert.ok(packet.markdown.includes("that unit grounds these obligations too — in"), "the duplication rule is stated rather than resolved");
});

// --- (8) the loader, over a real planned run ---------------------------------------------------------

test("the loader renders every unit of a real planned run, defaults its bound to the plan's, and reads no authoring input", async () => {
  const run = await plannedRun(["product"]);
  for (const unitId of run.view.collectionOrder) {
    const unit = run.view.byId.get(unitId)!;
    if (unit.kind === "synthesis") continue;
    const { packet, readPaths } = await renderUnitPacketForRun(run.runDir, { unitId, overBudget: "refuse" });
    assert.equal(packet.byteLimit, 786_432, `${unitId}: the bound comes from the plan's perUnitInputBytes`);
    assert.deepEqual([...packet.limitations], []);
    for (const readPath of readPaths) {
      for (const prefix of UNIT_PACKET_FORBIDDEN_INPUT_PREFIXES) {
        assert.ok(!readPath.startsWith(prefix), `${unitId} read ${readPath}, which is an authoring-side input`);
      }
    }
    assert.ok(readPaths.includes("evidence.json") && readPaths.includes("plan/catalog.json"));
    const second = await renderUnitPacketForRun(run.runDir, { unitId, overBudget: "refuse" });
    assert.equal(second.packet.markdown, packet.markdown, `${unitId}: two loads, same bytes`);
  }
});

test("a synthesis packet is refused until its children are collected, and renders their summaries afterwards", async () => {
  const run = await plannedRun(["product"]);
  const synthesis = run.view.collectionOrder.find((unitId) => run.view.byId.get(unitId)!.kind === "synthesis")!;
  await assert.rejects(renderUnitPacketForRun(run.runDir, { unitId: synthesis, overBudget: "refuse" }),
    /cannot be given a packet yet: its child .* is not collected/);
  for (const unitId of run.view.collectionOrder) {
    if (run.view.byId.get(unitId)!.kind === "synthesis") continue;
    await checkpointUnit(run.runDir, await unitDraftFor(run, unitId));
  }
  const { packet } = await renderUnitPacketForRun(run.runDir, { unitId: synthesis, overBudget: "refuse" });
  assert.ok(packet.markdown.includes("## Child summaries (1)"));
  assert.ok(packet.markdown.includes("This is a synthesis unit: it names no topic and reads no evidence record."));
  const source = await loadUnitPacketSource(run.runDir, { unitId: synthesis, overBudget: "refuse" });
  assert.ok(source.readPaths.some((path) => path.startsWith("units/") && path.endsWith("summary.json")));
});

// --- (9) 57B-452, for a read-only command ------------------------------------------------------------

/**
 * A copied run must render ITS OWN packet, and rendering must not write a byte into either tree.
 *
 * `tests/run-relocation.test.ts` owns the command-by-command coverage of the section path and is not touched here;
 * this is the same fixture shape for the one read-only command R4b adds. It is the stronger form of the check,
 * because a read-only command has no legitimate write at all: both trees must come out unchanged, and the two
 * renderings must be byte-identical (a packet cites digests and ids, never a location, so where the run sits cannot
 * change what an author reads).
 */
async function treeDigest(dir: string): Promise<Map<string, string>> {
  const rows = new Map<string, string>();
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) rows.set(relative(dir, full), sha256(await readFile(full)));
    }
  };
  await walk(dir);
  return rows;
}

test("relocated run: the copy renders its own unit packet, and neither tree is written to", async () => {
  const run = await plannedRun(["product"]);
  const unitId = run.view.collectionOrder.find((id) => run.view.byId.get(id)!.kind === "appendix")!;
  const original = await renderUnitPacketForRun(run.runDir, { unitId, overBudget: "refuse" });

  const moved = await tempDir("excavator-unit-packet-relocated-");
  await cp(run.workdir, moved, { recursive: true });
  const copyRunDir = join(moved, relative(run.workdir, run.runDir));
  const beforeOriginal = await treeDigest(run.workdir);
  const beforeCopy = await treeDigest(moved);

  const fromCopy = await renderUnitPacketForRun(copyRunDir, { unitId, overBudget: "refuse" });
  assert.equal(fromCopy.packet.markdown, original.packet.markdown, "the same run renders the same packet wherever it sits");
  assert.deepEqual([...await treeDigest(run.workdir)], [...beforeOriginal], "the original tree must not change");
  assert.deepEqual([...await treeDigest(moved)], [...beforeCopy], "and neither must the copy: rendering a packet is a read");
});
