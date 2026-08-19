// Packet-readings projection (57B-441 R0). The numbers below are hand-derived from the two checked-in fixture
// run directories, not read back off the extractor, and the two fixtures are built so the load-bearing ones can
// be derived WITHOUT counting bytes by eye:
//
//   * `packet-twin-overviews` holds two overview documents over the SAME work items, evidence and traces. An
//     overview packet mentions its document only in the H1 line, so the two packets are byte-identical except
//     for the document id: every attributed bucket must match exactly, the packet sizes must differ by exactly
//     len("overview-engineering") - len("overview-product") = 4, and the run's duplicate bytes must equal the
//     second packet's attributed bytes to the byte.
//   * `packet-feature-blocks` holds one feature document whose three blocks share an evidence id and a trace id,
//     so the renderer's cross-block "see the section 1 block" lines and the completeness row for a
//     searched-not-found work item are the entire `anchor-line` bucket — three lines whose bytes are spelled out
//     below as literals.
//
// If the renderer's line shape changes, the projection stops finding these chunks and the units land in
// `absentUnits`; that is the intended red, and the `absentUnits` assertions are what catch it. To make it green
// again, re-render each fixture's `context/authoring/<document>.md` with `buildAuthoringPacket(document, plan,
// evidenceById, traces, {}, undefined, undefined, 0)` over that fixture's own run.json / workitems.json /
// evidence.json / traces.json, and move the digests and byte numbers below to what the new renderer produces.

import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPacketReadings, type DocumentPacketReading, type PacketReadings } from "../packet-readings.ts";
import { stableJson } from "../../src/base/util.ts";

const TWIN = join(import.meta.dirname, "fixtures", "packet-twin-overviews");
const FEATURE = join(import.meta.dirname, "fixtures", "packet-feature-blocks");

const twin = extractPacketReadings(TWIN);
const feature = extractPacketReadings(FEATURE);

function document(readings: PacketReadings, id: string): DocumentPacketReading {
  const found = readings.documents.find((entry) => entry.documentId === id);
  assert.ok(found, `missing document ${id}`);
  return found;
}
function bucketSum(reading: DocumentPacketReading): number {
  const b = reading.buckets;
  return b["work-item"] + b.evidence + b.trace + b["anchor-line"] + b.unattributed;
}
async function copyFixture(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "packet-readings-"));
  await cp(source, dir, { recursive: true });
  return dir;
}
function packetPath(runDir: string, documentId: string): string {
  return join(runDir, "context", "authoring", `${documentId}.md`);
}

// --- ① per-document readings: the four numbers the baseline is made of ---

test("per-document readings report sections, claims, packet bytes and audit findings from the run's own artifacts", () => {
  const product = document(twin, "overview-product");
  const engineering = document(twin, "overview-engineering");

  // sections come from the manifest (2 and 3), claims from claims/<id>/*.json (2+1 and 1+1).
  assert.deepEqual([product.sections, product.claims], [2, 3]);
  assert.deepEqual([engineering.sections, engineering.claims], [3, 2]);
  // audit/audit.json: one error + one warning on product, one warning on engineering.
  assert.deepEqual([product.auditErrors, product.auditWarnings], [1, 1]);
  assert.deepEqual([engineering.auditErrors, engineering.auditWarnings], [0, 1]);
  assert.deepEqual(twin.totals, { documents: 2, sections: 5, claims: 5, packetBytes: 2400, auditErrors: 1, auditWarnings: 3, auditFindings: 4 });
  // The fourth finding is scoped to `condition-coverage`, which is not a document: visible, not dropped.
  assert.deepEqual(twin.auditUnscoped, { errors: 0, warnings: 1, scopes: ["condition-coverage"] });
  // Conservation on the audit side: every finding is either on a document or in the unscoped bucket.
  const perDocument = twin.documents.reduce((sum, entry) => sum + entry.auditErrors + entry.auditWarnings, 0);
  assert.equal(perDocument + twin.auditUnscoped.errors + twin.auditUnscoped.warnings, twin.totals.auditFindings);
});

test("twin overview packets differ by exactly the document id, so every attributed bucket matches", () => {
  const product = document(twin, "overview-product");
  const engineering = document(twin, "overview-engineering");

  // The only per-document text in an overview packet is `# Authoring packet — <id>`.
  const idDelta = Buffer.byteLength("overview-engineering") - Buffer.byteLength("overview-product");
  assert.equal(idDelta, 4);
  assert.equal(engineering.packetBytes - product.packetBytes, idDelta);
  assert.equal(engineering.buckets.unattributed - product.buckets.unattributed, idDelta);

  // Same work items, same evidence, same traces => identical attributed bytes, to the byte.
  assert.deepEqual(product.buckets["work-item"], engineering.buckets["work-item"]);
  assert.deepEqual(product.buckets.evidence, engineering.buckets.evidence);
  assert.deepEqual(product.buckets.trace, engineering.buckets.trace);
  assert.deepEqual(product.units, { total: 6, full: 6, anchorOnly: 0, absent: 0 });
  assert.deepEqual(engineering.units, { total: 6, full: 6, anchorOnly: 0, absent: 0 });
  assert.deepEqual(product.absentUnits, []);
  assert.deepEqual(engineering.absentUnits, []);
  // 2 work items + 3 evidence ids + 1 trace = the 6 units the fixture plan declares.
  assert.equal(product.units.total, 2 + 3 + 1);
});

test("every packet byte lands in exactly one bucket, and the buckets sum to the file's byte length", () => {
  for (const readings of [twin, feature]) {
    for (const reading of readings.documents) {
      assert.equal(bucketSum(reading), reading.packetBytes, `${reading.documentId} buckets must sum to packetBytes`);
      // The on-disk file is the authority for the denominator; nothing is inferred.
      assert.equal(reading.packetBytes, readFileSync(packetPath(readings === twin ? TWIN : FEATURE, reading.documentId)).length);
    }
    assert.equal(readings.totals.packetBytes, readings.documents.reduce((sum, entry) => sum + entry.packetBytes, 0));
    assert.equal(readings.duplication.totalPacketBytes, readings.totals.packetBytes);
  }
});

test("each packet's bytes are pinned by digest, so a same-length edit cannot slip through the buckets", () => {
  // Pinned literals: the tripwire. The buckets only see byte COUNTS, so an edit inside `unattributed` that keeps
  // the length would move no number here without this.
  assert.equal(document(twin, "overview-product").packetDigest, "e5475b215c28e752f23ac9f4f86ca78c630b5caf637b5b951ab65867c61391e3");
  assert.equal(document(twin, "overview-engineering").packetDigest, "619f125c427dbe7c4dd697a13b3c2039827b6a052a092965603540e85bfc19b2");
  assert.equal(document(feature, "feature-leave-engineering").packetDigest, "f91a9acda7e140571d4643a940771e14831fccb3310a0a23d9c8fb4e448b5eed");
  // And the digest is of the packet the projection actually read, computed here independently of it.
  for (const [readings, dir] of [[twin, TWIN], [feature, FEATURE]] as const) {
    for (const reading of readings.documents) {
      assert.equal(reading.packetDigest, createHash("sha256").update(readFileSync(packetPath(dir, reading.documentId))).digest("hex"));
    }
  }
});

// --- ② cross-packet duplication: the epic's "改动前" denominator ---

test("duplicate bytes equal the second packet's attributed bytes, and the ratio is over ALL packet bytes", () => {
  const product = document(twin, "overview-product");
  const engineering = document(twin, "overview-engineering");
  const attributed = engineering.buckets["work-item"] + engineering.buckets.evidence + engineering.buckets.trace + engineering.buckets["anchor-line"];

  // Every unit appears in both packets, so the duplicate bytes are exactly one packet's worth of attribution.
  assert.equal(twin.duplication.duplicateBytes, attributed);
  assert.equal(twin.duplication.unitsTotal, 6);
  assert.equal(twin.duplication.unitsDuplicated, 6);
  // Denominator includes `unattributed`: 2400 total bytes, of which 1264 carry no stable id.
  assert.equal(twin.duplication.unattributedBytes, product.buckets.unattributed + engineering.buckets.unattributed);
  assert.equal(twin.duplication.duplicateRatio, Number((twin.duplication.duplicateBytes / 2400).toFixed(6)));
  assert.equal(twin.duplication.duplicateRatio, 0.236667);

  // Per unit: two packets, equal sizes, and the duplicate half is the second one.
  for (const unit of twin.duplication.duplicatedUnits) {
    assert.equal(unit.packets, 2);
    assert.deepEqual(unit.documentIds, ["overview-product", "overview-engineering"]);
    assert.equal(unit.bytes.length, 2);
    assert.equal(unit.bytes[0], unit.bytes[1], `${unit.id} renders identically in both packets`);
    assert.equal(unit.duplicateBytes, unit.bytes[1]);
  }
  assert.deepEqual(twin.duplication.duplicatedUnits.map((unit) => `${unit.kind}:${unit.id}`).sort(),
    ["evidence:E-1", "evidence:E-2", "evidence:E-3", "trace:T-1", "work-item:W-1", "work-item:W-2"]);
  // Sorted by duplicate bytes descending: the head of the list is the top offender.
  const bytes = twin.duplication.duplicatedUnits.map((unit) => unit.duplicateBytes);
  assert.deepEqual(bytes, [...bytes].sort((a, b) => b - a));
  // byKind totals are complete (no cap): they account for every unit the run rendered.
  assert.equal(Object.values(twin.duplication.byKind).reduce((sum, kind) => sum + kind.units, 0), twin.duplication.unitsTotal);
  assert.equal(Object.values(twin.duplication.byKind).reduce((sum, kind) => sum + kind.duplicateBytes, 0), twin.duplication.duplicateBytes);
});

test("a single-packet run has zero duplication and still accounts for every byte", () => {
  assert.equal(feature.duplication.duplicateBytes, 0);
  assert.equal(feature.duplication.duplicateRatio, 0);
  assert.deepEqual(feature.duplication.duplicatedUnits, []);
  assert.equal(feature.duplication.unitsTotal, 7); // 3 work items + 3 evidence ids + 1 trace
  assert.equal(bucketSum(document(feature, "feature-leave-engineering")), feature.totals.packetBytes);
});

// --- ③ the anchor-line bucket: cross-block back references and completeness rows ---

test("the anchor-line bucket is exactly the renderer's back-reference lines plus the completeness row", () => {
  const reading = document(feature, "feature-leave-engineering");
  assert.equal(reading.blocks, 3); // section 1, section 2, and the trailing logic-disposition block

  // The three lines that name an id outside its own rendered chunk, spelled out. Sum: 35 + 35 + 47.
  const backReferences = [
    "- `E-1` — see the section 1 block",
    "- `T-1` — see the section 1 block",
    "- `W-3` — src/**/*.ts for resubmit and reopen"
  ];
  const expected = backReferences.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
  assert.equal(expected, 117);
  assert.equal(reading.buckets["anchor-line"], expected);

  const packet = readFileSync(packetPath(FEATURE, "feature-leave-engineering"), "utf8");
  for (const line of backReferences) assert.ok(packet.includes(`\n${line}`), `packet must contain ${line}`);
  // The ids are still `full` units: their own chunk is rendered once, in the first block that claims them.
  assert.deepEqual(reading.units, { total: 7, full: 7, anchorOnly: 0, absent: 0 });
});

test("a unit whose own chunk is gone but whose anchor line survives is reported anchor-only, not absent", async () => {
  const dir = await copyFixture(FEATURE);
  try {
    const path = packetPath(dir, "feature-leave-engineering");
    const packet = readFileSync(path, "utf8");
    // Drop E-1's full render (its heading line plus the fenced excerpt) but keep the section-2 back reference.
    const chunk = "- `E-1` — leave route handler (`src/leave.ts:10-12`)\n\n```\napp.post('/leave', requireManager, createLeave);\nconst MAX_DAYS = 20;\nreturn { ok: true };\n```\n";
    assert.ok(packet.includes(chunk), "fixture must contain E-1's full render");
    writeFileSync(path, packet.replace(chunk, ""));

    const readings = extractPacketReadings(dir);
    const reading = document(readings, "feature-leave-engineering");
    assert.deepEqual(reading.units, { total: 7, full: 6, anchorOnly: 1, absent: 0 });
    assert.deepEqual(reading.absentUnits, []);
    assert.equal(bucketSum(reading), reading.packetBytes);
    // E-1's bytes are now only its back-reference line, so the evidence bucket lost exactly its chunk.
    assert.equal(reading.buckets.evidence, document(feature, "feature-leave-engineering").buckets.evidence - Buffer.byteLength(chunk.trimEnd()));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a unit with no trace left in the packet is named in absentUnits rather than read as zero", async () => {
  const dir = await copyFixture(FEATURE);
  try {
    const path = packetPath(dir, "feature-leave-engineering");
    const kept = readFileSync(path, "utf8").split("\n").filter((line) => !line.includes("`E-1`")).join("\n");
    writeFileSync(path, kept);

    const readings = extractPacketReadings(dir);
    const reading = document(readings, "feature-leave-engineering");
    assert.deepEqual(reading.absentUnits, [{ kind: "evidence", id: "E-1" }]);
    assert.deepEqual(reading.units, { total: 7, full: 6, anchorOnly: 0, absent: 1 });
    // An absent unit contributes nothing to the duplication ledger and nothing to the attributed buckets, but
    // its packet's bytes are still fully accounted for.
    assert.equal(bucketSum(reading), reading.packetBytes);
    assert.equal(readings.duplication.byKind.evidence.units, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a chunk that occurs twice in one packet is a named failure, never a doubled attribution", async () => {
  const dir = await copyFixture(TWIN);
  try {
    const path = packetPath(dir, "overview-product");
    const packet = readFileSync(path, "utf8");
    const line = "- `W-1` — api-entrypoints · found · material · the leave route is the entry point";
    assert.ok(packet.includes(line));
    writeFileSync(path, packet.replace(line, `${line}\n${line}`));
    assert.throws(() => extractPacketReadings(dir), /packet readings: document overview-product: the rendered chunk for work-item W-1 occurs 2 times/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- ④ no silent empty: every unreadable input is a named failure ---

test("a missing or unusable required artifact fails by name, with no zero-valued reading", async () => {
  const cases: Array<[string, RegExp, (dir: string) => Promise<void>]> = [
    ["run.json", /packet readings: run.json is missing at/, async (dir) => rm(join(dir, "run.json"))],
    ["workitems.json", /packet readings: workitems.json is missing at/, async (dir) => rm(join(dir, "workitems.json"))],
    ["evidence.json", /packet readings: evidence.json is missing at/, async (dir) => rm(join(dir, "evidence.json"))],
    ["traces.json", /packet readings: traces.json is missing at/, async (dir) => rm(join(dir, "traces.json"))],
    ["audit.json", /packet readings: audit\/audit.json is missing at/, async (dir) => rm(join(dir, "audit", "audit.json"))],
    ["packet file", /packet readings: document overview-product has no authoring packet at context\/authoring\/overview-product.md/, async (dir) => rm(packetPath(dir, "overview-product"))],
    ["empty packet", /packet readings: the authoring packet for overview-product is empty \(0 bytes\)/, async (dir) => writeFile(packetPath(dir, "overview-product"), "")],
    ["claims directory", /packet readings: document overview-product has no claims directory at claims\/overview-product/, async (dir) => rm(join(dir, "claims", "overview-product"), { recursive: true })],
    ["unparseable json", /packet readings: workitems.json at .* is not valid JSON/, async (dir) => writeFile(join(dir, "workitems.json"), "{ not json")],
    ["documents array", /packet readings: run.json has no documents/, async (dir) => patchManifest(dir, (manifest) => { manifest.documents = []; })],
    ["sections array", /packet readings: document overview-product has no sections/, async (dir) => patchManifest(dir, (manifest) => { manifest.documents[0].sections = []; })],
    ["snapshot id", /packet readings: run.json has no snapshot id/, async (dir) => patchManifest(dir, (manifest) => { manifest.snapshot = null; })],
    ["knowledge epoch", /packet readings: run run-fixture-twin has no knowledgeEpoch/, async (dir) => patchManifest(dir, (manifest) => { delete manifest.knowledgeEpoch; })],
    ["audit level", /packet readings: audit finding for overview-product has unknown level "note"/, async (dir) => {
      const path = join(dir, "audit", "audit.json");
      const audit = JSON.parse(readFileSync(path, "utf8")) as { findings: Array<{ level: string }> };
      audit.findings[0].level = "note";
      await writeFile(path, JSON.stringify(audit));
    }],
    ["claims array", /packet readings: claims\/overview-product\/01.json has no claims array/, async (dir) => writeFile(join(dir, "claims", "overview-product", "01.json"), JSON.stringify({ version: 2, documentId: "overview-product", section: 1 }))]
  ];
  for (const [label, expected, mutate] of cases) {
    const dir = await copyFixture(TWIN);
    try {
      await mutate(dir);
      assert.throws(() => extractPacketReadings(dir), expected, `${label} must fail by name`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("a path that is not a run directory fails by name", () => {
  assert.throws(() => extractPacketReadings(join(TWIN, "no-such-directory")), /packet readings: .* is not a directory/);
});

// --- ⑤ determinism: the same run directory projects to the same bytes ---

test("re-running the extractor over the same run directory produces byte-identical output", () => {
  for (const dir of [TWIN, FEATURE]) {
    const first = stableJson(extractPacketReadings(dir));
    const second = stableJson(extractPacketReadings(dir));
    assert.equal(Buffer.compare(Buffer.from(first), Buffer.from(second)), 0, `${dir} must project to the same bytes twice`);
  }
});

async function patchManifest(dir: string, mutate: (manifest: Record<string, any>) => void): Promise<void> {
  const path = join(dir, "run.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  mutate(manifest);
  await writeFile(path, JSON.stringify(manifest, null, 2));
}
