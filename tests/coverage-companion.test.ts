import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COVERAGE_STATEMENT_PREFIXES, coverageStatementSentence, readsAsCovered } from "../src/investigation/coverage-statement.ts";
import {
  coverageStatements,
  packetCoverageStatements,
  renderCoverageCompanion,
  renderCoverageStateBlock,
  type CoverageStateFacts
} from "../src/report/coverage-companion.ts";
import { loadCoverageStateFacts } from "../src/report/coverage-companion-source.ts";
import { PACKET_STATED_UNKNOWNS, TOPIC_CATALOG_LEDGER, UNIT_LEDGER_RELATIVE_PATH, WORK_ITEM_LEDGER } from "../src/report/coverage-projection.ts";
import { accountPlanObligations } from "../src/report/plan-obligation-conservation.ts";
import { parsePlanProposal } from "../src/report/plan-proposal.ts";
import { readUnitGroundingForRun } from "../src/report/unit-grounding-reading.ts";
import { checkpointUnit } from "../src/report/unit-checkpoint.ts";
import { unitPathKey } from "../src/report/unit-paths.ts";
import { installFixturePlan, manifestOf } from "./helpers.ts";
import { plannedRun, unitDraftFor } from "./unit-fixture.ts";
import { MINI_DOCUMENTS, miniRun } from "./plan-fixture.ts";
import { loadUnitPlanView } from "../src/report/unit-plan-view.ts";

// THE COMPANION, AS A WORDING AUTHORITY AND AS A SAME-SOURCE READING (57B-434 R7a, closing 57B-449 + 57B-456).
//
// Two things have to hold and they pull in different directions. The companion must SAY the run's coverage state in
// words a reader cannot mistake for "covered" — which is the two defects — and it must not become a second
// derivation of any number the plan or the ledgers already own, which is what the epic forbids outright. So the
// tests below are half wording (an empty denominator, a displacement) and half identity (field-for-field against
// `accountPlanObligations`, the R5a ownership reading, and `coverage/read-obligations.json` read straight off disk).
//
// The fixture is a FROZEN RUN IN THIS REPOSITORY, so every number here is recomputed on every `npm test` rather
// than checked in. Its shape is stated where it is used: 4 read obligations, 1 of them never opened, an obligation
// ledger of 6 work items, and a `completeness-v1` record that predates the three displacement fields — which is
// what makes it the real `ledger-absent` case for the closure and not a contrived one.

let planned: { readonly runDir: string; readonly facts: CoverageStateFacts } | null = null;

async function plannedMiniRun(): Promise<{ readonly runDir: string; readonly facts: CoverageStateFacts }> {
  if (planned) return planned;
  const run = await miniRun(MINI_DOCUMENTS);
  await installFixturePlan(run.runDir);
  const { facts } = await loadCoverageStateFacts(run.runDir);
  return (planned = { runDir: run.runDir, facts });
}

function statement(facts: CoverageStateFacts, title: string) {
  const row = coverageStatements(facts).find((entry) => entry.title.startsWith(title));
  assert.ok(row, `no statement titled ${JSON.stringify(title)}; the companion holds: ${coverageStatements(facts).map((entry) => entry.title).join(" | ")}`);
  return row.statement;
}

// --- the same-source law: nothing here is a second derivation --------------------------------------------------

test("the read denominator IS the read-obligation ledger's own row count, read off disk", async () => {
  const { runDir, facts } = await plannedMiniRun();
  const ledger = JSON.parse(await readFile(join(runDir, "coverage", "read-obligations.json"), "utf8")) as { obligations: unknown[]; summary: { excludedContained: number; excludedDeclarationOnly: number } };
  assert.equal(facts.read.obligationRows, ledger.obligations.length, "the denominator is the ledger's rows, not its counted subset");
  const residual = JSON.parse(await readFile(join(runDir, "coverage", "read-residual.json"), "utf8")) as { summary: { covered: number; partial: number; notOpened: number; cannotDetermine: number } };
  assert.equal(facts.read.withWindowRows, residual.summary.covered + residual.summary.partial);
  assert.equal(facts.read.notOpenedRows, residual.summary.notOpened);
  assert.equal(facts.read.ledgerExcludedRows, ledger.summary.excludedDeclarationOnly + ledger.summary.excludedContained);
  // Guard against a vacuous version of this test: the fixture must actually leave something unread.
  assert.ok(facts.read.obligationRows > 0 && facts.read.notOpenedRows > 0, `the fixture must exercise the non-empty arm: ${JSON.stringify(facts.read)}`);
  const read = statement(facts, "Read obligations");
  assert.equal(read.state, "violations");
  assert.equal(readsAsCovered(read), false);
});

test("the material side is field-for-field the plan's own accounting and the R5a ownership reading", async () => {
  const { runDir, facts } = await plannedMiniRun();
  const manifest = await manifestOf(runDir);
  const view = await loadUnitPlanView(runDir, manifest);
  // Re-derived from the catalog and the recorded proposal, INDEPENDENTLY of the companion, and compared whole.
  const proposal = parsePlanProposal(JSON.parse(await readFile(join(runDir, "plan", "catalog.json"), "utf8")) as Record<string, unknown>);
  const recomputed = proposal.proposal
    ? accountPlanObligations(view.catalog, proposal.proposal.units, new Map(view.planCatalog.dispositions.map((row) => [row.topicId, row])))
    : null;
  if (recomputed) assert.deepEqual(facts.material.accounting, recomputed, "the companion must not hold a second accounting");
  else assert.deepEqual(facts.material.accounting, view.planCatalog.obligationAccounting, "the companion reads the recorded accounting");

  const grounding = await readUnitGroundingForRun(runDir);
  assert.deepEqual(facts.material.accounting, grounding.accounting, "one accounting, two readers");
  assert.deepEqual(
    facts.material.documents.map((row) => ({ documentId: row.documentId, reachedObligations: row.reachedObligations, unowned: row.unownedObligationIds.length, ownedByUnit: row.ownedByUnit })),
    grounding.ownership.map((row) => ({ documentId: row.documentId, reachedObligations: row.reachedObligations, unowned: row.unownedObligationIds.length, ownedByUnit: row.owedByUnit.map((entry) => ({ unitId: entry.unitId, owned: entry.owed })) })),
    "per-document ownership is the R5a reading's own rows"
  );
});

test("the determination census counts the obligation ledger's own rows", async () => {
  const { runDir, facts } = await plannedMiniRun();
  const ledger = JSON.parse(await readFile(join(runDir, "workitems.json"), "utf8")) as { items: { id: string; status: string }[] };
  assert.equal(facts.determinations.rows, ledger.items.length, "the ledger's rows, not the plan's material projection of them");
  assert.deepEqual(facts.determinations.cannotDetermineIds, ledger.items.filter((item) => item.status === "cannot-determine").map((item) => item.id).sort());
  assert.equal(facts.determinations.determinedNegative, ledger.items.filter((item) => item.status === "searched-not-found").length);
});

// --- no combined figure, ever ----------------------------------------------------------------------------------

test("nothing in the companion is a percentage or a cross-ledger sum", async () => {
  const { facts } = await plannedMiniRun();
  const rendered = renderCoverageCompanion(facts);
  // The prose names 665 of 946 as the cost of the join it refuses; that sentence is the only place a ratio-shaped
  // pair of numbers may appear, so the check is on the `%` character, which nothing legitimate here produces.
  assert.ok(!rendered.includes("%"), "a single blended coverage figure is the one number this file may not print");
  // Every statement names exactly one ledger, and the ledgers are not merged: four distinct denominators.
  const ledgers = new Set(coverageStatements(facts).map((row) => row.statement.ledger));
  assert.ok(ledgers.size >= 4, `expected at least four distinct denominators, got: ${[...ledgers].join(" | ")}`);
});

test("the companion is deterministic: two renderings of one fact set are one byte sequence", async () => {
  const { facts } = await plannedMiniRun();
  assert.equal(renderCoverageCompanion(facts), renderCoverageCompanion(facts));
  assert.equal(renderCoverageStateBlock(facts), renderCoverageStateBlock(facts));
});

// --- 57B-449: an empty denominator, on the value layer ---------------------------------------------------------

test("a run with zero read obligations reads as vacuous, never as covered", async () => {
  const { facts } = await plannedMiniRun();
  const empty: CoverageStateFacts = {
    ...facts,
    read: { ...facts.read, obligationRows: 0, withWindowRows: 0, notOpenedRows: 0, unreconcilableRows: 0, ledgerExcludedRows: 0, uncoveredLines: 0 }
  };
  const read = statement(empty, "Read obligations");
  assert.equal(read.state, "vacuous");
  assert.equal(read.state === "vacuous" && read.source, "ledger-empty");
  assert.equal(readsAsCovered(read), false);
  // THE FALSIFICATION. The old wording — "every strong-partition obligation has at least one window", and any
  // covered-family sentence — must be unreachable over an empty denominator. Restoring either reddens here.
  const sentence = coverageStatementSentence(read);
  assert.ok(!sentence.includes(COVERAGE_STATEMENT_PREFIXES.complete), sentence);
  assert.ok(!sentence.includes("at least one window"), sentence);
  // And it stays absent in both renderings, not just in the statement.
  for (const rendered of [renderCoverageCompanion(empty), renderCoverageStateBlock(empty)]) {
    const readLine = rendered.split("\n").find((line) => line.includes("read obligations") && line.includes("vacuous ("));
    assert.ok(readLine, rendered);
    assert.ok(readLine.includes("ledger-empty"), readLine);
  }
});

test("an absent closure is not a zero, and its sentence is not the empty one", async () => {
  const { facts } = await plannedMiniRun();
  // The mini fixture is a `completeness-v1` run: 57B-451's three displacement fields do not exist in it, so this
  // is the real named-absence case rather than a contrived one.
  assert.equal(facts.read.closure.state, "not-measured", JSON.stringify(facts.read.closure));
  const authorized = statement(facts, "Authorized reads");
  assert.equal(authorized.state, "vacuous");
  assert.equal(authorized.state === "vacuous" && authorized.source, "ledger-absent");
  const rendered = renderCoverageStateBlock(facts);
  assert.ok(rendered.includes("NOT MEASURED for this run, not zero"), rendered);
  assert.ok(!rendered.includes("0 decision reading(s) are sealed as `displaced`"), "an unmeasured field may not be printed as a zero");
});

// --- 57B-456: displacement, on the value layer -----------------------------------------------------------------

test("a displaced-non-zero run is not covered, and displacement never reads as a settled negative", async () => {
  const { facts } = await plannedMiniRun();
  const displaced: CoverageStateFacts = {
    ...facts,
    read: { ...facts.read, closure: { state: "recorded", authorizedReads: 473, readsDisplacedByBudget: 247, displacedDispositions: 247 } },
    determinations: { ...facts.determinations, determinedNegative: 41 }
  };
  const authorized = statement(displaced, "Authorized reads");
  assert.equal(authorized.state, "violations", "a run that read 226 of 473 authorized reads is not a covered run");
  assert.equal(readsAsCovered(authorized), false);
  assert.equal(authorized.state === "violations" && authorized.entries[0]!.kind, "displaced-by-budget");
  assert.equal(authorized.state === "violations" && authorized.conservation.excluded, 247);

  // THE FALSIFICATION for "take displacement out of the state derivation": with the same authorized total and
  // nothing displaced, the very same statement IS covered. So the arm is decided by the displacement and by
  // nothing else, and dropping it from the derivation would turn this run's report into a clean one.
  const undisplaced: CoverageStateFacts = { ...displaced, read: { ...displaced.read, closure: { state: "recorded", authorizedReads: 473, readsDisplacedByBudget: 0, displacedDispositions: 0 } } };
  assert.equal(statement(undisplaced, "Authorized reads").state, "complete");

  // The two sentences 57B-456 requires to stay apart, in the rendered block rather than in isolation.
  const rendered = renderCoverageStateBlock(displaced);
  assert.ok(rendered.includes("never attempted"), rendered);
  assert.ok(rendered.includes("41 obligations were READ AND SETTLED NEGATIVELY"), rendered);
  const displacedLine = rendered.split("\n").find((line) => line.includes("never attempted"))!;
  const negativeLine = rendered.split("\n").find((line) => line.includes("READ AND SETTLED NEGATIVELY"))!;
  assert.ok(!displacedLine.includes("SETTLED NEGATIVELY"));
  assert.ok(!negativeLine.includes("never attempted"));
  assert.notEqual(displacedLine, negativeLine);
});

// --- the packet block is the epoch-only half, and that is load-bearing -----------------------------------------

test("the packet block renders the epoch-only statements and nothing the plan or the catalog can move", async () => {
  const { facts } = await plannedMiniRun();
  const block = renderCoverageStateBlock(facts);
  const packetTitles = packetCoverageStatements(facts).map((row) => row.title);
  for (const title of packetTitles) assert.ok(block.includes(title), `${title} must be in the packet block`);
  // The two families a packet may NOT carry: their titles must be absent, because the packet's bytes are the
  // unit's cache identity and both of these move when the plan is divided or one topic is edited.
  const companionOnly = coverageStatements(facts).map((row) => row.title).filter((title) => !packetTitles.includes(title));
  assert.ok(companionOnly.length >= 2, companionOnly.join(" | "));
  for (const title of companionOnly) assert.ok(!block.includes(title), `${title} must NOT be in a packet: it is not epoch-only`);
  // Perturbing the plan-derived and catalog-derived halves must not change one byte of the block.
  const perturbed: CoverageStateFacts = {
    ...facts,
    material: { ...facts.material, documents: [] },
    topics: { ...facts.topics, topics: facts.topics.topics + 7, unknownTopicIds: ["invented:topic"], topicResidual: [] }
  };
  assert.equal(renderCoverageStateBlock(perturbed), block, "a topic edit or a plan division may not move an appendix's cache identity");
});

test("every statement names one of the declared ledgers, and the packet's absence reason is the pinned constant", async () => {
  const { facts } = await plannedMiniRun();
  const named = new Set(coverageStatements(facts).map((row) => row.statement.ledger));
  // The two ledgers whose names are constants must be the names the statements actually print: a statement and its
  // source drifting into two spellings is how a reader ends up unable to check either.
  assert.ok(named.has(WORK_ITEM_LEDGER), [...named].join(" | "));
  assert.ok(named.has(TOPIC_CATALOG_LEDGER), [...named].join(" | "));
  assert.ok(named.has(UNIT_LEDGER_RELATIVE_PATH), [...named].join(" | "));
  // The packet's stated-unknowns absence is a CONSTANT, and the block prints it verbatim: a reworded explanation
  // would move every appendix's cache identity, which is the one thing the constant exists to prevent.
  assert.equal(PACKET_STATED_UNKNOWNS.state, "absent");
  const reason = PACKET_STATED_UNKNOWNS.state === "absent" ? PACKET_STATED_UNKNOWNS.reason : "";
  assert.ok(renderCoverageStateBlock({ ...facts, statedUnknowns: PACKET_STATED_UNKNOWNS }).includes(reason), reason);
});

// --- the CLI door ----------------------------------------------------------------------------------------------

test("the read-only CLI command renders the companion and writes nothing into the run", async () => {
  const { runDir } = await plannedMiniRun();
  const before = await readFile(join(runDir, "run.json"), "utf8");
  const first = await loadCoverageStateFacts(runDir);
  const second = await loadCoverageStateFacts(runDir);
  assert.equal(renderCoverageCompanion(first.facts), renderCoverageCompanion(second.facts), "two loads of one run render one byte sequence");
  assert.equal(await readFile(join(runDir, "run.json"), "utf8"), before, "the companion is read-only");
  // Every published path is run-relative and none is an authoring artifact.
  for (const path of first.readPaths) {
    assert.ok(!path.startsWith("/"), path);
    for (const forbidden of ["claims/", "context/authoring/", "prompts/", "reports/", "sections/"]) {
      assert.ok(!path.startsWith(forbidden), `${path} is an authoring artifact and the companion may not read it`);
    }
  }
  assert.ok(first.readPaths.includes("units/collected.json"), first.readPaths.join(", "));
});

test("a collected unit's stated unknowns reach the companion, and a drifted summary is refused", async () => {
  // The real collected path, through the real doors: draft, collect, then read the companion. Without this the
  // `present` arm of the unit-stated unknowns is never exercised and the `absent` arm would be the only one tested.
  const run = await plannedRun();
  const unitId = run.view.collectionOrder.find((id) => run.view.byId.get(id)!.kind !== "synthesis")!;
  const draft = await unitDraftFor(run, unitId, { unknowns: ["how the promotion window is chosen is not recorded"] });
  await checkpointUnit(run.runDir, draft);

  const { facts } = await loadCoverageStateFacts(run.runDir);
  assert.equal(facts.statedUnknowns.state, "present");
  const stated = facts.statedUnknowns.state === "present" ? facts.statedUnknowns : null;
  assert.equal(stated!.collectedUnits, 1);
  assert.deepEqual(stated!.units, [{ unitId, unknowns: ["how the promotion window is chosen is not recorded"] }]);
  const verdict = statement(facts, "Written units");
  assert.equal(verdict.state, "violations", "a unit that states an unknown is not a unit with nothing to report");
  assert.ok(renderCoverageCompanion(facts).includes("how the promotion window is chosen is not recorded"));

  // A summary whose bytes no longer digest to what the ledger recorded is a NAMED REFUSAL. Reporting the drifted
  // bytes would mean the companion quotes unknowns no recorded row vouches for.
  const summaryPath = join(run.runDir, "units", unitPathKey(unitId), "summary.json");
  const summary = JSON.parse(await readFile(summaryPath, "utf8")) as { unknowns: string[] };
  await writeFile(summaryPath, JSON.stringify({ ...summary, unknowns: ["edited after collection"] }, null, 2));
  await assert.rejects(loadCoverageStateFacts(run.runDir), /but the unit ledger recorded .*; re-collect it before reporting the unknowns it states/);
});
