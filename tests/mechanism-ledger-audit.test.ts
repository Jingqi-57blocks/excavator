import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { ReportRequest } from "../src/base/types.ts";
import { prepareRun } from "../src/run/run.ts";
import { auditMechanismLedger } from "../src/assurance/mechanism-ledger-audit.ts";
import type { ContractManifest } from "../src/contract/contract-manifest.ts";
import type { ArtifactResult } from "../src/base/artifact-result.ts";
import type { FileLedger } from "../src/snapshot/file-ledger.ts";
import type { MechanismDeclaration, MechanismLedger } from "../src/mechanism/mechanism-ledger.ts";
import { unavailable } from "../src/base/artifact-result.ts";
import { writeJson } from "../src/base/util.ts";
import { copyFixture, createCodeGraphFixture, tempDir } from "./helpers.ts";

/**
 * The layer-2 audit verifies the ledger the run RECORDED — against itself and against the layer-1 rows it
 * claims to account for — never against what today's registries would produce. Every check below therefore
 * survives an archived run, and every one of them is asserted by tampering: a check nobody can make fail is
 * indistinguishable from no check, which is the shape the whole contract exists to remove.
 */

const BUDGETS = { prepareMs: 60_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

async function overviewRequest(): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return { target, codegraph, workdir, language: "zh-CN", detailLevel: "standard", overviewAudiences: ["product"], features: [], budgets: BUDGETS };
}

interface Prepared {
  runDir: string;
  contract: ContractManifest;
  files: ArtifactResult<FileLedger>;
  ledger: MechanismLedger;
}

async function prepared(): Promise<Prepared> {
  const { runDir } = await prepareRun(await overviewRequest());
  const contract = JSON.parse(await readFile(join(runDir, "contract", "contract-manifest.json"), "utf8")) as ContractManifest;
  const files = JSON.parse(await readFile(join(runDir, "ledger", "files.json"), "utf8")) as ArtifactResult<FileLedger>;
  const envelope = JSON.parse(await readFile(join(runDir, "ledger", "mechanisms.json"), "utf8")) as ArtifactResult<MechanismLedger>;
  assert.equal(envelope.status, "built", "a prepared run records a built layer-2 ledger");
  if (envelope.status !== "built") throw new Error("unreachable");
  return { runDir, contract, files, ledger: envelope.value };
}

/**
 * Rewrite a ledger as the previous schema version would have written it.
 *
 * An archived run is verified under the schema it recorded, so the v1 fixtures below are built by REMOVING what
 * v2 added rather than by hand: a hand-written v1 could differ from a real one in a way that made the "old
 * checks still run" claim vacuous.
 */
function downgradeToV1(ledger: MechanismLedger): void {
  (ledger as { version: string }).version = "mechanisms-ledger-v1";
  for (const mechanism of ledger.mechanisms) delete (mechanism as Partial<MechanismDeclaration>).takesMatrixRows;
}

/** Write a mutated ledger back and audit it, so each finding is asserted on one deliberate lie. */
async function auditWith(run: Prepared, mutate: (ledger: MechanismLedger) => void): Promise<string[]> {
  const ledger = JSON.parse(JSON.stringify(run.ledger)) as MechanismLedger;
  mutate(ledger);
  await writeJson(join(run.runDir, "ledger", "mechanisms.json"), { status: "built", value: ledger });
  const findings = await auditMechanismLedger(run.runDir, run.contract, run.files);
  assert.ok(findings.every((finding) => finding.level === "error"), JSON.stringify(findings));
  return findings.map((finding) => finding.message);
}

test("a freshly prepared run's layer-2 ledger satisfies its own audit", async () => {
  const run = await prepared();
  assert.deepEqual(await auditMechanismLedger(run.runDir, run.contract, run.files), []);
  assert.ok(run.ledger.fileMatrix.length > 0, "and it really has matrix rows to check");
  assert.equal(run.ledger.counted, run.files.status === "built" ? run.files.value.summary.counted : -1);
});

test("breaking conservation in one mechanism is an error naming that mechanism", async () => {
  const run = await prepared();
  const victim = run.ledger.fileMatrix[0].mechanismId;
  const messages = await auditWith(run, (ledger) => { ledger.fileMatrix[0].totals.covered += 1; });
  assert.ok(messages.some((message) => message.includes(victim) && /does not account for every counted row/.test(message)),
    `a mechanism that drops rows must be named: ${JSON.stringify(messages, null, 2)}`);
});

test("rebinding the ledger to a different layer-1 corpus is an error", async () => {
  const run = await prepared();
  const messages = await auditWith(run, (ledger) => { ledger.identity.filesContentManifestDigest = "0".repeat(64); });
  assert.ok(messages.some((message) => /bound to a different layer-1 corpus/.test(message)),
    `every cell counts rows from one corpus, and the ledger says which: ${JSON.stringify(messages, null, 2)}`);
});

test("a matrix default for an extension layer 1 never counted is a ghost row and an error", async () => {
  const run = await prepared();
  // `files: 0` keeps the group sum intact, so this asserts the ghost check itself rather than the sum check.
  const messages = await auditWith(run, (ledger) => {
    ledger.fileMatrix[0].defaults.push({ extension: ".ghost", files: 0, cell: "covered" });
  });
  assert.ok(messages.some((message) => /\.ghost/.test(message) && /not a counted group/.test(message)),
    `layer 2 may only account for rows layer 1 counted: ${JSON.stringify(messages, null, 2)}`);
});

test("a group whose size disagrees with layer 1 is an error even when the total still adds up", async () => {
  const run = await prepared();
  const messages = await auditWith(run, (ledger) => {
    const row = ledger.fileMatrix[0];
    row.defaults[0].files += 3;
    row.defaults[1].files -= 3;
  });
  assert.ok(messages.some((message) => /layer 1 counted/.test(message)),
    `a compensating pair of wrong group sizes must not cancel out: ${JSON.stringify(messages, null, 2)}`);
});

test("the three cells cannot be minted independently of the availability the run observed", async () => {
  const run = await prepared();
  const covered = run.ledger.fileMatrix.find((row) => row.totals.covered > 0);
  assert.ok(covered, "the fixture has at least one mechanism with covered cells");
  const claimingCoverage = await auditWith(run, (ledger) => {
    const declaration = ledger.mechanisms.find((entry) => entry.id === covered.mechanismId);
    if (declaration) declaration.availability = { status: "unavailable", cause: "pretend the binding vanished" };
  });
  assert.ok(claimingCoverage.some((message) => /recorded as unavailable .* yet \d+ of its cells claim coverage/.test(message)),
    `a missing dependency and a covered cell cannot both be true: ${JSON.stringify(claimingCoverage, null, 2)}`);

  const claimingBlindness = await auditWith(run, (ledger) => {
    const row = ledger.fileMatrix.find((entry) => entry.mechanismId === covered.mechanismId);
    if (!row) return;
    row.totals.covered -= 1;
    row.totals.mechanismUnavailable += 1;
  });
  assert.ok(claimingBlindness.some((message) => /recorded as available yet 1 of its cells say the mechanism was unavailable/.test(message)),
    `an available mechanism may not report itself blind on a row: ${JSON.stringify(claimingBlindness, null, 2)}`);
});

test("tampering with the compression is caught by expanding it against layer 1", async () => {
  const run = await prepared();
  const flipped = await auditWith(run, (ledger) => {
    const row = ledger.fileMatrix.find((entry) => entry.defaults.some((group) => group.cell === "no-mechanism"));
    assert.ok(row, "a mechanism with an uncovered group");
    const group = row.defaults.find((entry) => entry.cell === "no-mechanism");
    if (group) Object.assign(group, { cell: "covered", cause: undefined });
  });
  assert.ok(flipped.some((message) => /do not match its own compressed rows/.test(message)),
    `the published totals and the folded form must agree: ${JSON.stringify(flipped, null, 2)}`);

  const invented = await auditWith(run, (ledger) => {
    ledger.fileMatrix[0].exceptions.push({ relativePath: "does/not/exist.ts", cell: "covered" });
  });
  assert.ok(invented.some((message) => /does\/not\/exist\.ts/.test(message) && /not a counted row/.test(message)),
    `an exception for a path outside the corpus is a ghost too: ${JSON.stringify(invented, null, 2)}`);
});

test("an exception that restates its group's default is a non-canonical fold and an error", async () => {
  const run = await prepared();
  const messages = await auditWith(run, (ledger) => {
    const row = ledger.fileMatrix[0];
    const group = row.defaults.find((entry) => entry.files > 0 && entry.cell === "covered");
    assert.ok(group, "a covered group to restate");
    const victim = (run.files.status === "built" ? run.files.value.counted : []).find((counted) => counted.extension === group.extension);
    assert.ok(victim);
    row.exceptions.push({ relativePath: victim.relativePath, cell: "covered" });
  });
  assert.ok(messages.some((message) => /restate their group's default/.test(message)),
    `two spellings of one cell make the artifact's bytes depend on which one a reader trusts: ${JSON.stringify(messages, null, 2)}`);
});

test("a per-language census that does not add up to the matrix is an error", async () => {
  const run = await prepared();
  const messages = await auditWith(run, (ledger) => { ledger.byLanguage[0].covered += 5; });
  assert.ok(messages.some((message) => /per-language census does not add up/.test(message)),
    `the census is a view of the matrix, never a second opinion: ${JSON.stringify(messages, null, 2)}`);
});

test("a matrix row for a non-file domain is an error, and a missing declaration is too", async () => {
  const run = await prepared();
  const wrongDomain = await auditWith(run, (ledger) => {
    const declaration = ledger.mechanisms.find((entry) => entry.id === ledger.fileMatrix[0].mechanismId);
    if (declaration) declaration.coverageDomain = "corpus";
  });
  assert.ok(wrongDomain.some((message) => /carries \(file x mechanism\) rows/.test(message)),
    `a per-file grid for a corpus census would be a coverage claim it never made: ${JSON.stringify(wrongDomain, null, 2)}`);

  const undeclared = await auditWith(run, (ledger) => {
    ledger.mechanisms = ledger.mechanisms.filter((entry) => entry.id !== ledger.fileMatrix[0].mechanismId);
  });
  assert.ok(undeclared.some((message) => /which the ledger never declares/.test(message)),
    `cells without a declaration have no domain, unit kind or availability: ${JSON.stringify(undeclared, null, 2)}`);
});

test("deleting a whole matrix row is an error, because the declaration says the row should be there", async () => {
  const run = await prepared();
  // Before `takesMatrixRows`, this edit was undetectable: the row's conservation obligation, its availability
  // agreement and its per-language census all went with it, and the audit only ever walked the rows present.
  const victim = "search";
  assert.ok(run.ledger.fileMatrix.some((row) => row.mechanismId === victim), "the fixture really has a search row");
  const messages = await auditWith(run, (ledger) => {
    ledger.fileMatrix = ledger.fileMatrix.filter((row) => row.mechanismId !== victim);
    ledger.byLanguage = ledger.byLanguage.filter((row) => row.mechanismId !== victim);
  });
  assert.ok(messages.some((message) => message.includes(victim) && /declare they take \(file x mechanism\) rows and have none/.test(message)),
    `a removed row must be named as missing: ${JSON.stringify(messages, null, 2)}`);
});

test("the declared row expectation matches the grid in both directions", async () => {
  const run = await prepared();
  const declared = new Set(run.ledger.mechanisms.filter((mechanism) => mechanism.takesMatrixRows).map((mechanism) => mechanism.id));
  assert.deepEqual([...declared].sort(), run.ledger.fileMatrix.map((row) => row.mechanismId).sort(),
    "a freshly prepared ledger declares exactly the rows it carries");
  assert.ok(run.ledger.mechanisms.some((mechanism) => !mechanism.takesMatrixRows),
    "and some mechanisms legitimately take none (crossrepo, ctags-census, codegraph), which is the case the field disambiguates");

  const disowned = await auditWith(run, (ledger) => {
    const declaration = ledger.mechanisms.find((entry) => entry.id === ledger.fileMatrix[0].mechanismId);
    if (declaration) declaration.takesMatrixRows = false;
  });
  assert.ok(disowned.some((message) => /carry \(file x mechanism\) rows without declaring they take any/.test(message)),
    `flipping the flag rather than removing the row must not be a way out: ${JSON.stringify(disowned, null, 2)}`);
});

test("one mechanism id, one declaration and one matrix row — duplicates are an error under every version", async () => {
  const run = await prepared();
  const twiceDeclared = await auditWith(run, (ledger) => { ledger.mechanisms.push({ ...ledger.mechanisms[0] }); });
  assert.ok(twiceDeclared.some((message) => /declares \S+ more than once/.test(message)),
    `a second declaration silently wins the map lookup: ${JSON.stringify(twiceDeclared, null, 2)}`);

  const twiceRowed = await auditWith(run, (ledger) => { ledger.fileMatrix.push(JSON.parse(JSON.stringify(ledger.fileMatrix[0])) as typeof ledger.fileMatrix[0]); });
  assert.ok(twiceRowed.some((message) => /carries matrix rows for \S+ more than once/.test(message)),
    `two grids for one mechanism make its cells ambiguous: ${JSON.stringify(twiceRowed, null, 2)}`);

  // Uniqueness needs nothing v2 added, so an archived v1 run is held to it as well.
  const v1Duplicate = await auditWith(run, (ledger) => {
    downgradeToV1(ledger);
    ledger.mechanisms.push({ ...ledger.mechanisms[0] });
  });
  assert.ok(v1Duplicate.some((message) => /declares \S+ more than once/.test(message)),
    `v1 bytes support this check, so it runs: ${JSON.stringify(v1Duplicate, null, 2)}`);
});

test("an archived v1 ledger keeps its old checks and is not failed by the new one", async () => {
  const run = await prepared();
  // Skipped, not failed: v1 declarations never carried `takesMatrixRows`, so there is no expectation to compare
  // against, and inventing one from today's registry is the retroactive-failure shape the contract forbids.
  const v1MissingRow = await auditWith(run, (ledger) => {
    downgradeToV1(ledger);
    ledger.fileMatrix = ledger.fileMatrix.filter((row) => row.mechanismId !== "search");
    ledger.byLanguage = ledger.byLanguage.filter((row) => row.mechanismId !== "search");
  });
  assert.deepEqual(v1MissingRow, [], `a v1 run must not acquire a new obligation retroactively: ${JSON.stringify(v1MissingRow, null, 2)}`);

  // And every check its own bytes support still runs.
  const v1Unbalanced = await auditWith(run, (ledger) => {
    downgradeToV1(ledger);
    ledger.fileMatrix[0].totals.covered += 1;
  });
  assert.ok(v1Unbalanced.some((message) => /does not account for every counted row/.test(message)),
    `conservation is checkable from v1 bytes and stays checked: ${JSON.stringify(v1Unbalanced, null, 2)}`);
});

test("a recorded 'we could not find out' is read as a state, not skipped as an absence", async () => {
  const run = await prepared();
  await writeJson(join(run.runDir, "ledger", "mechanisms.json"), unavailable("availability probing failed: pretend a probe threw", true));
  const findings = await auditMechanismLedger(run.runDir, run.contract, run.files);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "error");
  assert.match(findings[0].message, /records the mechanism ledger as unavailable: availability probing failed/);

  await writeJson(join(run.runDir, "ledger", "mechanisms.json"), { status: "not-applicable", determination: "no-mechanisms", basedOn: ["ledger/files.json"], coverageDigest: "x" });
  const inapplicable = await auditMechanismLedger(run.runDir, run.contract, run.files);
  assert.ok(inapplicable.some((finding) => /not-applicable/.test(finding.message)),
    "every run has a corpus and a set of mechanisms, so 'provably does not apply' cannot be true here");
});
