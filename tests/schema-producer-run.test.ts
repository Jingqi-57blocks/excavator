import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { ArtifactResult } from "../src/base/artifact-result.ts";
import { notApplicable } from "../src/base/artifact-result.ts";
import {
  coverageBasisDigest, fileCompletenessValue, FILE_COMPLETENESS_BASIS, mechanismCoverageBasisName, mechanismCoverageValue
} from "../src/base/coverage-basis.ts";
import type { ReportRequest } from "../src/base/types.ts";
import { writeJson } from "../src/base/util.ts";
import type { ContractManifest } from "../src/contract/contract-manifest.ts";
import type { ProducerFactSet } from "../src/facts/envelope.ts";
import { auditNotApplicablePremises } from "../src/freeze/completeness.ts";
import type { MechanismLedger } from "../src/mechanism/mechanism-ledger.ts";
import { PLAN_BUDGET_TABLE } from "../src/report/plan-budget.ts";
import { PLANNER_PACKET_BYTE_LIMIT, renderPlannerPacket } from "../src/report/planner-packet.ts";
import { REPORT_POLICY_REGISTRY } from "../src/report/report-policy-registry.ts";
import { readReportRequests } from "../src/report/report-requests-artifact.ts";
import { buildTopicCatalog } from "../src/report/topic-catalog.ts";
import { loadTopicCatalogSource } from "../src/report/topic-catalog-source.ts";
import type { FileLedger } from "../src/snapshot/file-ledger.ts";
import { freezeRun, prepareRun } from "../src/run/run.ts";
import { copyFixture, createCodeGraphFixture, disposeAllWorkItems, manifestOf, tempDir } from "./helpers.ts";

/**
 * The db-schema producer, on real prepares of three targets whose shapes differ on purpose.
 *
 * Before 57B-483 this envelope was a policy skip on every run — `policy: not-run-scoped` — so the entity facet
 * of the topic catalog was `ledger-absent` on every run too, and a report could not name a single database
 * table. These tests are the positive assertion that replaced it: not "the envelope is no longer unavailable",
 * but "these three tables, with these names, anchored in these files, reach the plan".
 *
 * THE THREE TARGETS ARE THE THREE ANSWERS, and they are three different sentences rather than three shades of
 * empty. `schema-target` declares tables in both a migration and a gorm model → `Built`. `schema-free-target`
 * declares none AND every counted file is inside the db-schema mechanism's declared extensions → the
 * determination `NotApplicable{not-detected}`, whose premise layer 8 re-resolves. `sample-target` declares none
 * either, but three of its five counted files (`README.md`, `package.json`, a `.vue`) are outside that coverage
 * → `Unavailable`, because nobody read those files and nobody may say what is not in them.
 */

const BUDGETS = {
  prepareMs: 60_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50,
  maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2
};

async function requestFor(fixture: string): Promise<ReportRequest> {
  const target = await copyFixture(fixture);
  const workdir = await tempDir("excavator-schema-");
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return { target, codegraph, workdir, language: "zh-CN", detailLevel: "standard", overviewAudiences: ["product"], features: [], budgets: BUDGETS };
}

async function preparedOn(fixture: string): Promise<{ runDir: string; envelope: ArtifactResult<ProducerFactSet> }> {
  const { runDir } = await prepareRun(await requestFor(fixture));
  return { runDir, envelope: await readEnvelope(runDir) };
}

async function readEnvelope(runDir: string): Promise<ArtifactResult<ProducerFactSet>> {
  return JSON.parse(await readFile(join(runDir, "facts", "producers", "db-schema.json"), "utf8")) as ArtifactResult<ProducerFactSet>;
}

async function readContract(runDir: string): Promise<ContractManifest> {
  return JSON.parse(await readFile(join(runDir, "contract", "contract-manifest.json"), "utf8")) as ContractManifest;
}

test("prepare recovers the target's physical tables into the layer-3 envelope, anchored where they are declared", async () => {
  const { envelope } = await preparedOn("schema-target");
  assert.equal(envelope.status, "built", envelope.status === "unavailable" ? envelope.cause : envelope.status);
  if (envelope.status !== "built") return;

  // The three tables the fixture declares, by name. Two sources contribute: a Sequelize migration pair and a
  // gorm model whose `TableName()` resolves through a typed string constant in a SEPARATE package.
  assert.deepEqual(envelope.value.facts.map((fact) => fact.detail["name"]), ["leave_approval", "leave_balance", "leave_request"]);
  assert.deepEqual([...new Set(envelope.value.facts.map((fact) => fact.kind))], ["db-table"]);

  const byName = new Map(envelope.value.facts.map((fact) => [String(fact.detail["name"]), fact]));
  // `leave_request` is declared twice — the migration and the model — and anchors at the migration, which is the
  // declaration closest to physical DDL. `leave_balance` exists only in the gorm model, and anchors there.
  assert.equal(byName.get("leave_request")!.detail["anchorFile"], "migrations/20200117111801-create-leave-request.js");
  assert.equal(byName.get("leave_request")!.detail["declarations"], 2);
  assert.equal(byName.get("leave_request")!.detail["columns"], 5);
  assert.equal(byName.get("leave_balance")!.detail["anchorFile"], "internal/model/leave.go");
  assert.equal(byName.get("leave_balance")!.detail["anchorSymbol"], "LeaveBalance");

  // Each fact holds a REAL partition membership — one anchor cell, in the file the table is declared in — and
  // not one anchor went unmapped. A fact that seated nowhere would be counted, and here the count is zero.
  for (const [name, fact] of byName) {
    assert.equal(fact.membership.kind, "unit", `${name} takes the anchor-cell arm`);
    if (fact.membership.kind !== "unit") continue;
    assert.ok(fact.membership.unitId.endsWith(`:${fact.detail["anchorFile"]}`), `${name} seats in its own declaring file: ${fact.membership.unitId}`);
  }
  assert.deepEqual(envelope.value.membershipUnmapped, []);
  assert.deepEqual(envelope.value.unmappableFactIds, []);
  assert.deepEqual(envelope.value.completeness.byKind, { "db-table": 3 });

  const completeness = envelope.value.producerCompleteness;
  assert.equal(completeness["tables"], 3);
  assert.equal(completeness["formats"], "gorm, sequelize-migration");
  assert.equal(completeness["filesParsed"], 4);
  assert.equal(completeness["filesOutsideLedger"], 0);
  // The one declaration that holds no seat: `leave_request`'s gorm model. Counted, not assumed.
  assert.equal(completeness["tableDeclarationsBeyondAnchor"], 1);
  assert.equal(completeness["engine"], "MySQL");
  assert.equal(envelope.value.identity.producerVersion, "schema-facts-v1");
});

test("a target with no schema and full mechanism coverage is a determination whose premise layer 8 accepts", async () => {
  const { runDir, envelope } = await preparedOn("schema-free-target");
  assert.equal(envelope.status, "not-applicable", envelope.status === "unavailable" ? envelope.cause : envelope.status);
  if (envelope.status !== "not-applicable") return;
  assert.equal(envelope.determination, "not-detected");
  assert.deepEqual(envelope.basedOn, [FILE_COMPLETENESS_BASIS, mechanismCoverageBasisName("db-schema")]);

  // The premise is not merely stated: layer 8 re-resolves both records from the run and re-derives the digest.
  assert.deepEqual(await auditNotApplicablePremises(runDir, await readContract(runDir)), []);
  await disposeAllWorkItems(runDir);
  const frozen = await freezeRun(runDir);
  assert.equal(frozen.frozen, true, JSON.stringify(frozen.findings, null, 2));
});

test("a target the schema mechanism only partly covers is a blind spot, never a determination", async () => {
  // `sample-target` holds a README, a package.json and a `.vue` — three counted rows outside the db-schema
  // mechanism's declared extensions. Nothing read them, so "this target declares no table" is unsayable.
  const { runDir, envelope } = await preparedOn("sample-target");
  assert.equal(envelope.status, "unavailable");
  if (envelope.status !== "unavailable") return;
  assert.match(envelope.cause, /covered only 2 of 5 counted file\(s\) \(3 outside its declared extensions, 0 unavailable at runtime\), so "this target declares no table" cannot be determined/);

  // The counter-tripwire for the arm above: forging the determination onto THIS run — where the coverage is
  // partial — has to be caught by the freeze auditor. Without this, "the producer returns Unavailable here"
  // would be a choice nothing enforces.
  const files = JSON.parse(await readFile(join(runDir, "ledger", "files.json"), "utf8")) as ArtifactResult<FileLedger>;
  const mechanisms = JSON.parse(await readFile(join(runDir, "ledger", "mechanisms.json"), "utf8")) as ArtifactResult<MechanismLedger>;
  assert.equal(files.status, "built");
  assert.equal(mechanisms.status, "built");
  if (files.status !== "built" || mechanisms.status !== "built") return;
  const basedOn = [FILE_COMPLETENESS_BASIS, mechanismCoverageBasisName("db-schema")];
  await writeJson(join(runDir, "facts", "producers", "db-schema.json"), notApplicable("not-detected", basedOn, coverageBasisDigest([
    {
      reference: FILE_COMPLETENESS_BASIS,
      value: fileCompletenessValue({ ...files.value.completeness, readFailures: files.value.counted.filter((row) => row.content.status === "absent").length })
    },
    { reference: mechanismCoverageBasisName("db-schema"), value: mechanismCoverageValue(mechanisms.value, "db-schema") }
  ])));
  const findings = await auditNotApplicablePremises(runDir, await readContract(runDir));
  assert.ok(findings.some((finding) => /db-schema\.json claims not-detected with partial mechanism coverage; it must be Unavailable/.test(finding.message)),
    JSON.stringify(findings, null, 2));
});

test("the entity facet becomes one topic per recovered table, and those tables reach the planner's packet", async () => {
  const { runDir } = await preparedOn("schema-target");
  await disposeAllWorkItems(runDir);
  const frozen = await freezeRun(runDir);
  assert.equal(frozen.frozen, true, JSON.stringify(frozen.findings, null, 2));

  // The run's OWN recorded requests, not a set this test invents: `prepare` writes them once per run, and a
  // packet rendered against invented ones would not be the packet this run's planner is handed.
  const requests = await readReportRequests(runDir);
  const source = await loadTopicCatalogSource(runDir, await manifestOf(runDir));
  const catalog = buildTopicCatalog(source);

  const entity = catalog.facets.find((row) => row.facet === "entity")!;
  assert.deepEqual(entity.outcome, { state: "populated", topics: 3 }, "one topic per fact, and the facet says so by count");
  const tables = catalog.topics.filter((topic) => topic.facet === "entity");
  assert.deepEqual(tables.map((topic) => topic.title).sort(), ["leave_approval", "leave_balance", "leave_request"]);
  assert.deepEqual([...new Set(tables.map((topic) => topic.source.ledger))], ["facts/producers/db-schema.json"]);
  assert.deepEqual([...new Set(tables.map((topic) => topic.kind))], ["db-table"]);
  // Every table fact is ROUTED, not merely present: nothing the schema producer published landed in the
  // catalog's unmapped census.
  assert.deepEqual(catalog.factRouting.unmapped.filter((row) => row.producer === "db-schema"), []);
  // And they arrive unobligated, exactly as route topics do: no work item in this run's obligation ledger binds
  // a table, so the join that would make one material does not exist yet. Asserted so the reading is on record
  // rather than discovered later as a surprise.
  assert.deepEqual([...new Set(tables.map((topic) => topic.materiality))], ["unobligated"]);

  const packet = renderPlannerPacket({
    catalog, requests, registry: REPORT_POLICY_REGISTRY, budgetTable: PLAN_BUDGET_TABLE,
    byteLimit: PLANNER_PACKET_BYTE_LIMIT, overBudget: "refuse"
  });
  assert.deepEqual(packet.limitations, []);
  assert.ok(packet.markdown.includes("| entity | populated |"), "the facet census row says the ledger is there");
  for (const name of ["leave_request", "leave_balance", "leave_approval"]) {
    assert.ok(packet.markdown.includes(name), `the planner is handed the table by name: ${name}`);
  }
});
