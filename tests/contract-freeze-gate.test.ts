import test from "node:test";
import assert from "node:assert/strict";
import { join, sep } from "node:path";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { ReportRequest, RunManifest } from "../src/base/types.ts";
import { auditRun, freezeRun, prepareRun } from "../src/run/run.ts";
import { ARTIFACT_REGISTRY } from "../src/base/artifact-registry.ts";
import { auditContractInstances } from "../src/freeze/contract-instance-audit.ts";
import { assuranceGenerationAtLeast, CONTRACT_MANIFEST_ASSURANCE_GENERATION } from "../src/base/assurance-version.ts";
import type { ContractManifest } from "../src/contract/contract-manifest.ts";
import { ledgerContentIdentity, type FileLedger } from "../src/snapshot/file-ledger.ts";
import type { ArtifactResult } from "../src/base/artifact-result.ts";
import { canonicalJson, exists, sha256, stableJson, writeJson } from "../src/base/util.ts";
import type { MechanismLedger } from "../src/mechanism/mechanism-ledger.ts";
import { copyFixture, createCodeGraphFixture, disposeAllWorkItems, tempDir } from "./helpers.ts";

/**
 * Freeze verifies the run against the contract that was materialized before any producer ran — per INSTANCE,
 * not per artifact family. A slot satisfied by feature A used to cover feature B, which is how a run with two
 * features could lose one feature's whole working set and still pass.
 */

const BUDGETS = { prepareMs: 60_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 120_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

async function twoFeatureRequest(): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return {
    target, codegraph, workdir, language: "zh-CN", detailLevel: "standard", overviewAudiences: [],
    features: [
      { subject: "Leave management", aliases: ["leave", "holiday"], audiences: ["product"] },
      { subject: "Order processing", aliases: ["order", "checkout"], audiences: ["product"] }
    ],
    budgets: BUDGETS
  };
}

async function overviewRequest(): Promise<ReportRequest> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return { target, codegraph, workdir, language: "zh-CN", detailLevel: "standard", overviewAudiences: ["product"], features: [], budgets: BUDGETS };
}

/** Every per-feature context cache the run wrote, found by shape rather than by re-deriving the cache key. */
async function featureCachePaths(workdir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".json") && path.includes(`${sep}features${sep}`)) found.push(path);
    }
  };
  await walk(workdir);
  return found.sort();
}

async function readManifest(runDir: string): Promise<RunManifest> {
  return JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as RunManifest;
}

test("the registry covers all eight layer slots and every layer-3 producer", () => {
  const layers = [...new Set(ARTIFACT_REGISTRY.slots.map((slot) => slot.layer))].sort((a, b) => a - b);
  assert.deepEqual(layers, [1, 2, 3, 4, 5, 6, 7, 8], "a layer with no registered slot has no expected artifact and therefore cannot fail");
  assert.deepEqual(ARTIFACT_REGISTRY.producers.map((producer) => producer.id).sort(),
    ["codegraph", "crossrepo", "db-schema", "framework", "native-graph", "probe", "vocabulary"]);
  for (const entry of [...ARTIFACT_REGISTRY.slots, ...ARTIFACT_REGISTRY.producers]) {
    assert.ok(entry.schemaId.length > 0, `${entry.id} declares a schema id`);
    assert.ok(entry.validatorVersion.length > 0, `${entry.id} declares a validator version`);
    assert.equal(typeof entry.enforced, "boolean", `${entry.id} states explicitly whether it is enforced today`);
    assert.ok(entry.enforcementNote.length > 0, `${entry.id} states why it is or is not enforced`);
  }
  assert.ok(ARTIFACT_REGISTRY.producers.every((producer) => producer.layer === 3));
});

test("a prepared run carries its bound contract and its layer-1 ledger on disk", async () => {
  const { runDir } = await prepareRun(await overviewRequest());
  for (const name of ["run-intent.json", "requirements.json", "contract-manifest.json"]) {
    assert.ok(await exists(join(runDir, "contract", name)), `contract/${name} is materialized at prepare`);
  }
  const ledger = JSON.parse(await readFile(join(runDir, "ledger", "files.json"), "utf8")) as ArtifactResult<FileLedger>;
  assert.equal(ledger.status, "built");
  const manifest = await readManifest(runDir);
  assert.equal(ledger.status === "built" ? ledger.value.contentManifestDigest : null, manifest.snapshot?.contentManifestDigest,
    "the ledger and the snapshot are bound by the tier2 whole-table digest");
  assert.deepEqual(await auditContractInstances(runDir, manifest), [], "a freshly prepared run satisfies its own contract");
});

test("a missing layer-1 ledger fails the contract instance audit and freeze", async () => {
  const { runDir } = await prepareRun(await overviewRequest());
  await disposeAllWorkItems(runDir);
  await rm(join(runDir, "ledger", "files.json"));
  const manifest = await readManifest(runDir);
  const findings = await auditContractInstances(runDir, manifest);
  assert.ok(findings.some((finding) => finding.level === "error" && /ledger\/files\.json/.test(finding.message)), JSON.stringify(findings, null, 2));
  const frozen = await freezeRun(runDir);
  assert.equal(frozen.frozen, false, "a run missing a required contract instance cannot be frozen");
  assert.ok(frozen.findings.some((finding) => /ledger\/files\.json/.test(finding.message)));
});

test("a missing layer-2 mechanism ledger fails the contract instance audit and freeze", async () => {
  // The registry slot is `enforced: true` as of this slice. Flipping the flag without producing the artifact
  // was checked first and turned three existing assertions red with exactly this message, which is what makes
  // the flag a claim rather than decoration.
  const { runDir } = await prepareRun(await overviewRequest());
  await disposeAllWorkItems(runDir);
  assert.ok(await exists(join(runDir, "ledger", "mechanisms.json")), "every prepare writes the layer-2 ledger");
  await rm(join(runDir, "ledger", "mechanisms.json"));
  const manifest = await readManifest(runDir);
  const findings = await auditContractInstances(runDir, manifest);
  assert.ok(findings.some((finding) => finding.level === "error" && /ledger\/mechanisms\.json/.test(finding.message)), JSON.stringify(findings, null, 2));
  const frozen = await freezeRun(runDir);
  assert.equal(frozen.frozen, false, "a run missing a required contract instance cannot be frozen");
  assert.ok(frozen.findings.some((finding) => /ledger\/mechanisms\.json/.test(finding.message)));
});

test("every prepare writes the layer-3 artifact and all seven producer envelopes, and removing one is a finding", async () => {
  // The registry slots are `enforced: true` as of this slice, and that flag is only honest because
  // `src/run/facts-stage.ts` writes all eight records unconditionally. Checked by removal, one at a time.
  const { runDir } = await prepareRun(await overviewRequest());
  await disposeAllWorkItems(runDir);
  const paths = ["facts/units.json", ...ARTIFACT_REGISTRY.producers.map((producer) => `facts/producers/${producer.id}.json`)];
  assert.equal(paths.length, 8);
  for (const path of paths) assert.ok(await exists(join(runDir, path)), `${path} is written by every prepare`);
  const manifest = await readManifest(runDir);
  assert.deepEqual(await auditContractInstances(runDir, manifest), [], "and a freshly prepared run satisfies all eight");

  for (const path of paths) {
    const kept = await readFile(join(runDir, path), "utf8");
    await rm(join(runDir, path));
    const findings = await auditContractInstances(runDir, manifest);
    assert.ok(findings.some((finding) => finding.level === "error" && finding.message.includes(path)),
      `${path} missing must be an error naming it: ${JSON.stringify(findings)}`);
    await writeFile(join(runDir, path), kept);
  }
  assert.deepEqual(await auditContractInstances(runDir, manifest), [], "and restoring them clears the findings");
});

test("every prepare writes the layer-4 attribution record, including a run with no feature at all", async () => {
  // The slot is `enforced: true` as of this slice, and that flag is only honest because
  // `src/run/attribution-stage.ts` writes the record on the success path and the failure path alike. Checked on
  // the overview-only request precisely because it selects nothing: `featureCount: 0` is the record, not a
  // missing file.
  const { runDir } = await prepareRun(await overviewRequest());
  await disposeAllWorkItems(runDir);
  const path = join(runDir, "attribution", "attribution.json");
  assert.ok(await exists(path), "an overview-only prepare still writes the attribution record");
  const record = JSON.parse(await readFile(path, "utf8")) as ArtifactResult<{ featureCount: number; selections: unknown[]; identity: Record<string, unknown>; denominator: { cells: number } }>;
  assert.equal(record.status, "built");
  if (record.status !== "built") return;
  assert.equal(record.value.featureCount, 0);
  assert.deepEqual(record.value.selections, [], "a run that selected nothing publishes no selection, not a fabricated one");
  assert.ok(record.value.denominator.cells > 0, "and it still states the denominator it would have seated into");

  const manifest = await readManifest(runDir);
  assert.deepEqual(await auditContractInstances(runDir, manifest), [], "a freshly prepared run satisfies the slot");
  const kept = await readFile(path, "utf8");
  await rm(path);
  const findings = await auditContractInstances(runDir, manifest);
  assert.ok(findings.some((finding) => finding.level === "error" && finding.message.includes("attribution/attribution.json")),
    `removing it must be an error naming it: ${JSON.stringify(findings)}`);
  await writeFile(path, kept);
  assert.deepEqual(await auditContractInstances(runDir, manifest), []);
});

test("a two-feature prepare's attribution balances per selection and carries no feature subject in its identity", async () => {
  const request = await twoFeatureRequest();
  const { runDir } = await prepareRun(request);
  const record = JSON.parse(await readFile(join(runDir, "attribution", "attribution.json"), "utf8")) as ArtifactResult<{
    featureCount: number;
    denominator: { cells: number };
    identity: Record<string, unknown>;
    selections: Array<{ featureKey: string; conservation: Array<{ totals: { counted: number; seated: number; zeroScore: number; displaced: number } }>; projection: { retained: { nodes: number; seated: number; missCounts: Record<string, number> } } }>;
  }>;
  assert.equal(record.status, "built");
  if (record.status !== "built") return;
  assert.equal(record.value.featureCount, 2, "one selection per feature — the law holds per selection, not per run");
  for (const selection of record.value.selections) {
    const totals = selection.conservation[0]!.totals;
    assert.equal(totals.counted, record.value.denominator.cells);
    assert.equal(totals.seated + totals.zeroScore + totals.displaced, totals.counted, `${selection.featureKey} does not balance`);
    const missed = Object.values(selection.projection.retained.missCounts).reduce((sum, value) => sum + value, 0);
    assert.equal(selection.projection.retained.seated + missed, selection.projection.retained.nodes);
  }
  // The layer-4 identity may not be keyed by what a feature is CALLED for an audience; the run intent summary
  // carries the operator's own subject and aliases, and nothing about which document wanted them.
  const identity = JSON.stringify(record.value.identity);
  for (const forbidden of ["product", "engineering", "outputLanguage", request.target]) {
    assert.ok(!identity.includes(forbidden), `the attribution identity leaked ${forbidden}`);
  }
});

test("a cached feature context with no selection trace is refused, not served as a selection that never ran", async () => {
  const request = await twoFeatureRequest();
  await prepareRun(request);
  // The cache the first prepare wrote, doctored the way a pre-trace builder would have left it. The path is
  // untouched, so this is exactly the false hit a forgotten version bump would produce.
  const caches = await featureCachePaths(request.workdir);
  assert.ok(caches.length >= 2, `the first prepare really cached its features: ${JSON.stringify(caches)}`);
  const cached = JSON.parse(await readFile(caches[0]!, "utf8")) as Record<string, unknown>;
  assert.ok("selectionTrace" in cached, "the cache entry carries the trace in the first place");
  delete cached.selectionTrace;
  await writeFile(caches[0]!, JSON.stringify(cached));
  await assert.rejects(prepareRun(request), /carries no selection trace/);
});

test("a cached feature context from another allocator generation is refused", async () => {
  const request = await twoFeatureRequest();
  await prepareRun(request);
  const caches = await featureCachePaths(request.workdir);
  assert.ok(caches.length >= 2);
  const cached = JSON.parse(await readFile(caches[0]!, "utf8")) as Record<string, unknown>;
  assert.equal(cached.selectionTraceVersion, "selection-trace-v5");
  cached.selectionTraceVersion = "selection-trace-v4";
  await writeFile(caches[0]!, JSON.stringify(cached));
  await assert.rejects(prepareRun(request), /instead of "selection-trace-v5"|mixing allocator generations/);
});

test("a prepared run's layer-3 records carry the units digest and no feature key", async () => {
  const request = await twoFeatureRequest();
  const { runDir } = await prepareRun(request);
  const units = JSON.parse(await readFile(join(runDir, "facts", "units.json"), "utf8")) as ArtifactResult<{ identity: Record<string, unknown>; partition: unknown[] }>;
  assert.equal(units.status, "built");
  if (units.status !== "built") return;
  assert.ok(units.value.partition.length > 0, "the fixture target really has counted files to partition");
  const digest = sha256(canonicalJson(units.value));
  // Two features, so a feature key that had leaked into an identity would be there to find. The check is on the
  // IDENTITY rather than the whole file, because the `probe` envelope's cause honestly explains that probes run
  // per feature today — that sentence is the record, not a leak.
  const keys = request.features.map((feature) => feature.subject);
  const skipped: string[] = [];
  const checked: string[] = [];
  for (const producer of ARTIFACT_REGISTRY.producers) {
    const envelope = JSON.parse(await readFile(join(runDir, "facts", "producers", `${producer.id}.json`), "utf8")) as ArtifactResult<{ identity: Record<string, string> }>;
    if (envelope.status !== "built") {
      skipped.push(`${producer.id}: ${envelope.status === "unavailable" ? envelope.cause : envelope.status}`);
      continue;
    }
    checked.push(producer.id);
    const identity = canonicalJson(envelope.value.identity);
    assert.ok(!/feature/i.test(identity), `${producer.id}'s identity may not mention a feature: layer-3 facts are feature-free`);
    for (const subject of keys) assert.ok(!identity.includes(subject), `${producer.id}'s identity may not carry ${subject}`);
    assert.equal(envelope.value.identity.unitsContentDigest, digest,
      `${producer.id} must bind to the partition generation its memberships name`);
  }
  // Everything above is inside an `if built` and would therefore pass on a run where NOTHING was built — the loop
  // would spin over unavailable envelopes and assert nothing. `codegraph` is the producer this fixture really does
  // build, so it is named: the day index resolution regresses, this test goes red instead of quietly emptying.
  assert.ok(checked.includes("codegraph"),
    `no codegraph envelope was built, so the identity checks above examined nothing. Skipped: ${skipped.join(" | ")}`);
});

test("a prepare failure records all eight layer-3 slots as unavailable rather than leaving them absent", async () => {
  const request = await overviewRequest();
  const missing = { ...request, target: join(request.target, "does-not-exist") };
  await assert.rejects(() => prepareRun(missing));
  const runs = join(await (async () => {
    const { projectWorkspace } = await import("../src/base/util.ts");
    return projectWorkspace(missing.workdir, missing.target);
  })(), "runs");
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(runs);
  assert.equal(entries.length, 1, "the failure left exactly one run directory");
  const runDir = join(runs, entries[0]!);
  for (const path of ["facts/units.json", ...ARTIFACT_REGISTRY.producers.map((producer) => `facts/producers/${producer.id}.json`)]) {
    const envelope = JSON.parse(await readFile(join(runDir, path), "utf8")) as ArtifactResult<unknown>;
    assert.equal(envelope.status, "unavailable", `${path} is a written record, never an absent file`);
    assert.match(envelope.status === "unavailable" ? envelope.cause : "", /source boundary could not be read/);
  }
  for (const path of ["context/overview-census.json", "workset/read-specs.json", "obligations/declarations.json"]) {
    const envelope = JSON.parse(await readFile(join(runDir, path), "utf8")) as ArtifactResult<unknown>;
    assert.equal(envelope.status, "unavailable", `${path} records the whole-layer failure instead of disappearing`);
  }
});

test("two prepares of the same request produce byte-identical layer-2 ledgers", async () => {
  // Through the real `prepareRun`, so the production wiring is what is pinned: availability is probed the way a
  // run probes it and nothing records a wall clock. Same machine only — availability is a per-machine
  // observation, and requiring byte equality across machines would mean not recording it honestly.
  const request = await overviewRequest();
  const first = await prepareRun(request);
  const second = await prepareRun(request);
  assert.notEqual(first.runDir, second.runDir);
  const bytes = async (runDir: string): Promise<string> => readFile(join(runDir, "ledger", "mechanisms.json"), "utf8");
  assert.equal(await bytes(first.runDir), await bytes(second.runDir));
  const envelope = JSON.parse(await bytes(first.runDir)) as ArtifactResult<MechanismLedger>;
  assert.equal(envelope.status, "built");
  if (envelope.status !== "built") return;
  const manifest = await readManifest(first.runDir);
  assert.equal(envelope.value.identity.filesContentManifestDigest, manifest.snapshot?.contentManifestDigest,
    "layer 2 is bound to the same corpus identity the run recorded");
  assert.ok(envelope.value.mechanisms.length >= 8, "every registered mechanism is declared, matrix or not");
});

test("freeze pins the layer-2 ledger digest in the knowledge record", async () => {
  const { runDir } = await prepareRun(await overviewRequest());
  await disposeAllWorkItems(runDir);
  const frozen = await freezeRun(runDir);
  assert.equal(frozen.frozen, true, JSON.stringify(frozen.findings, null, 2));
  const ledger = JSON.parse(await readFile(join(runDir, "ledger", "mechanisms.json"), "utf8")) as unknown;
  assert.equal(frozen.knowledge?.mechanismsLedgerDigest, sha256(stableJson(ledger)),
    "the frozen record pins WHICH coverage declarations this run applied, so a later registry change cannot move retroactively");
});

test("deleting one feature's working set is an error naming that instance, even when the other feature still has one", async () => {
  const { runDir } = await prepareRun(await twoFeatureRequest());
  const manifest = await readManifest(runDir);
  const contractManifest = JSON.parse(await readFile(join(runDir, "contract", "contract-manifest.json"), "utf8")) as ContractManifest;
  const factPacks = contractManifest.expected.filter((instance) => instance.slotId === "workset.fact-pack");
  assert.equal(factPacks.length, 2, "two features expect two fact-pack instances");
  assert.deepEqual(await auditContractInstances(runDir, manifest), []);

  const victim = factPacks[1];
  await rm(join(runDir, victim.path));
  const findings = await auditContractInstances(runDir, manifest);
  assert.ok(findings.some((finding) => finding.level === "error" && finding.message.includes(victim.instanceKey)),
    `the finding must name the missing instance: ${JSON.stringify(findings, null, 2)}`);
});

test("a run prepared before the contract existed is grandfathered, and one prepared after is not", async () => {
  const { runDir } = await prepareRun(await overviewRequest());
  const manifest = await readManifest(runDir);
  assert.ok(assuranceGenerationAtLeast(manifest, CONTRACT_MANIFEST_ASSURANCE_GENERATION),
    `a fresh run is prepared under generation ${CONTRACT_MANIFEST_ASSURANCE_GENERATION} or later: ${manifest.assuranceVersion}`);
  await rm(join(runDir, "contract"), { recursive: true });
  const current = await auditContractInstances(runDir, manifest);
  assert.ok(current.some((finding) => finding.level === "error" && /contract-manifest\.json/.test(finding.message)),
    "a generation-10 run with no contract on disk lost a required record");

  const legacy: RunManifest = { ...manifest, assuranceVersion: "assurance-v9-mode-redaction-v7" };
  assert.deepEqual(await auditContractInstances(runDir, legacy), [], "an archived pre-contract run verifies with no migration");
});

test("audit reports a scanner generation change as a warning rather than a false source-drift error", async () => {
  const { runDir } = await prepareRun(await overviewRequest());
  const runPath = join(runDir, "run.json");
  const manifest = await readManifest(runDir);
  assert.ok(manifest.snapshot);
  manifest.snapshot.scannerVersion = "git-aware-source-boundary-v1";
  await writeJson(runPath, manifest);
  const audit = await auditRun(runDir);
  const drift = audit.findings.filter((finding) => finding.document === "snapshot");
  assert.ok(drift.some((finding) => finding.level === "warning" && /scanner/i.test(finding.message)),
    `a re-derivation the scanner cannot perform is a stated limit: ${JSON.stringify(drift, null, 2)}`);
  assert.deepEqual(drift.filter((finding) => finding.level === "error" && /source snapshot changed/.test(finding.message)), [],
    "an incomparable identity must not be reported as a changed source tree");
});

test("a counted row with no content identity is an audit error, not a quiet absence", async () => {
  const { runDir } = await prepareRun(await overviewRequest());
  const manifest = await readManifest(runDir);
  const ledgerPath = join(runDir, "ledger", "files.json");
  const envelope = JSON.parse(await readFile(ledgerPath, "utf8")) as ArtifactResult<FileLedger>;
  assert.equal(envelope.status, "built");
  if (envelope.status !== "built") return;

  // The shape a lost race between `lstat` and `readFile` leaves behind. It used to be spelled `excluded`, which
  // made a failed read indistinguishable from a policy decision — and neither spelling was ever checked.
  const victim = envelope.value.counted[0];
  victim.content = { status: "absent", reason: "read-failed" };
  envelope.value.contentManifestDigest = ledgerContentIdentity(envelope.value);
  await writeJson(ledgerPath, envelope);
  assert.ok(manifest.snapshot);
  // Rebound so the snapshot/ledger digest check stays quiet and this assertion is about the one finding.
  manifest.snapshot.contentManifestDigest = envelope.value.contentManifestDigest;

  const findings = await auditContractInstances(runDir, manifest);
  const boundary = findings.filter((finding) => finding.message.startsWith("ledger/files.json"));
  assert.equal(boundary.length, 1, `exactly the counted-row finding: ${JSON.stringify(findings, null, 2)}`);
  assert.equal(boundary[0].level, "error");
  assert.match(boundary[0].message, /counted row/);
  assert.ok(boundary[0].message.includes(victim.relativePath), `the finding names the row: ${boundary[0].message}`);
  assert.ok(boundary[0].message.includes("read-failed"), "and the reason it carries");
  // Editing the corpus digest also breaks what layer 2 is bound to, and that is a SECOND real finding: every
  // cell in the mechanism ledger counts the rows of one corpus, and this run no longer has that corpus.
  const mechanism = findings.filter((finding) => finding.message.startsWith("ledger/mechanisms.json"));
  assert.equal(mechanism.length, 1, JSON.stringify(findings, null, 2));
  assert.match(mechanism[0].message, /bound to a different layer-1 corpus/);
  assert.equal(findings.length, 2, `and nothing else: ${JSON.stringify(findings, null, 2)}`);
});

test("a truncated contract manifest fails its own digest instead of silently expecting nothing", async () => {
  const { runDir } = await prepareRun(await overviewRequest());
  const manifest = await readManifest(runDir);
  const manifestPath = join(runDir, "contract", "contract-manifest.json");
  const contract = JSON.parse(await readFile(manifestPath, "utf8")) as ContractManifest;
  assert.ok(contract.expected.some((instance) => instance.enforced), "the run really does expect enforced instances");

  // Emptying `expected` used to turn the whole instance audit into a pass: every check iterates that list.
  contract.expected = [];
  await writeJson(manifestPath, contract);
  const findings = await auditContractInstances(runDir, manifest);
  assert.ok(findings.some((finding) => finding.level === "error" && /does not match its own digest/.test(finding.message)),
    `a contract record nobody verifies is decoration: ${JSON.stringify(findings, null, 2)}`);

  // And the two contract inputs are checked against the digests the manifest recorded for them.
  const restored = JSON.parse(await readFile(manifestPath, "utf8")) as ContractManifest;
  restored.expected = contract.expected;
  const intentPath = join(runDir, "contract", "run-intent.json");
  const runIntent = JSON.parse(await readFile(intentPath, "utf8")) as { target: string; digest: string };
  runIntent.target = `${runIntent.target}-elsewhere`;
  await writeJson(intentPath, runIntent);
  const swapped = await auditContractInstances(runDir, manifest);
  assert.ok(swapped.some((finding) => /run-intent\.json does not match its own digest/.test(finding.message)),
    `an edited contract input is caught by its own digest: ${JSON.stringify(swapped, null, 2)}`);
});

test("a prepare failure AFTER the boundary was read records the ledger as built, not as an unreadable boundary", async () => {
  // The budget is exhausted before the first check on the post-boundary side of the phase split, so this is
  // deterministic rather than a wall-clock bet: `readSourceBoundary` performs no deadline check at all, and
  // every later check — the feature loop, the project documents, the source windows — throws the same
  // `ExcavatorTimeoutError` through the same catch. Before the split, all of them were recorded as
  // `Unavailable{"the source boundary could not be read"}` while the ledger sat complete in memory, and the
  // instance audit then amplified that into an error against a run that had read the boundary fine.
  const request = await twoFeatureRequest();
  const starved: ReportRequest = { ...request, budgets: { ...BUDGETS, prepareMs: 1 } };
  await assert.rejects(() => prepareRun(starved), /exceeded 1ms/);

  const { runDir } = await findFailedRun(starved.workdir);
  const envelope = JSON.parse(await readFile(join(runDir, "ledger", "files.json"), "utf8")) as ArtifactResult<FileLedger>;
  assert.equal(envelope.status, "built", "the boundary WAS read; the ledger must not claim otherwise");
  if (envelope.status !== "built") return;
  assert.ok(envelope.value.counted.length > 0, "and it holds the rows it read");

  // Layer 2 follows the same phase: the corpus WAS read, so its mechanism declarations are built too.
  const mechanisms = JSON.parse(await readFile(join(runDir, "ledger", "mechanisms.json"), "utf8")) as ArtifactResult<MechanismLedger>;
  assert.equal(mechanisms.status, "built", "the corpus was read, so what could look at it is knowable");
  if (mechanisms.status === "built") {
    assert.equal(mechanisms.value.counted, envelope.value.summary.counted);
    assert.equal(mechanisms.value.identity.filesContentManifestDigest, envelope.value.contentManifestDigest);
  }

  const manifest = await readManifest(runDir);
  assert.equal(manifest.state, "failed");
  assert.equal(manifest.error?.stage, "prepare");
  assert.ok(manifest.snapshot, "a run that read its boundary records the snapshot it read");
  assert.equal(manifest.snapshot?.contentManifestDigest, envelope.value.contentManifestDigest, "and it is bound to the ledger");
  assert.deepEqual(manifest.metrics.warnings.filter((warning) => /boundary could not be read/.test(warning)), [],
    `no warning may assert a blindness the run did not have: ${JSON.stringify(manifest.metrics.warnings)}`);
  const investigation = JSON.parse(await readFile(join(runDir, "investigation", "results.json"), "utf8")) as ArtifactResult<unknown>;
  assert.equal(investigation.status, "unavailable", "the enforced L7 slot records the phase failure instead of disappearing");
  // What the instance audit must NOT say is anything about layer 1 or a missing L7 envelope: both layers wrote
  // the result they actually reached.
  const findings = await auditContractInstances(runDir, manifest);
  assert.deepEqual(findings.filter((finding) => /ledger\/files\.json|source boundary/.test(finding.message)), [],
    `layer 8 has nothing to report about a boundary that was read completely: ${JSON.stringify(findings, null, 2)}`);
  assert.deepEqual(findings.filter((finding) => /investigation\.read-results.*missing/.test(finding.message)), []);
});

test("an unreadable target leaves a failed run directory whose layer-1 ledger records the cause", async () => {
  const workdir = await tempDir();
  const target = join(await tempDir(), "does-not-exist");
  const request: ReportRequest = { target, workdir, language: "zh-CN", detailLevel: "standard", overviewAudiences: ["product"], features: [], budgets: BUDGETS };
  await assert.rejects(() => prepareRun(request), /does-not-exist/);

  const { runDir } = await findFailedRun(workdir);
  const ledger = JSON.parse(await readFile(join(runDir, "ledger", "files.json"), "utf8")) as ArtifactResult<FileLedger>;
  assert.equal(ledger.status, "unavailable", "'the boundary could not be read' is a written record, not a missing file");
  if (ledger.status === "unavailable") {
    assert.match(ledger.cause, /does-not-exist/);
    assert.equal(typeof ledger.retryable, "boolean");
  }
  // No corpus means nothing to declare mechanisms over, and that is WRITTEN — not a missing file, and not a
  // ledger full of zeroes that would read as "we looked and found no mechanisms".
  const mechanisms = JSON.parse(await readFile(join(runDir, "ledger", "mechanisms.json"), "utf8")) as ArtifactResult<MechanismLedger>;
  assert.equal(mechanisms.status, "unavailable");
  if (mechanisms.status === "unavailable") assert.match(mechanisms.cause, /does-not-exist/);

  // Layer 4 follows for the same reason one layer up, and it is asserted rather than assumed: `attribution-stage.ts`
  // claims to write on the success path and the failure path alike, and only the failure half was ever unread.
  const attribution = JSON.parse(await readFile(join(runDir, "attribution", "attribution.json"), "utf8")) as ArtifactResult<unknown>;
  assert.equal(attribution.status, "unavailable", "a run with no selection writes the record, it does not omit the file");
  if (attribution.status === "unavailable") {
    assert.match(attribution.cause, /no selection to attribute/);
    assert.match(attribution.cause, /does-not-exist/, "and it names the cause it inherited rather than restating one");
  }

  const manifest = await readManifest(runDir);
  assert.equal(manifest.state, "failed");
  assert.equal(manifest.snapshot, null);
  assert.ok(await exists(join(runDir, "contract", "contract-manifest.json")), "the contract is materialized before the boundary is read, so it survives the failure");
});

/** Locate the single run directory a failed prepare left under a fresh workdir. */
async function findFailedRun(workdir: string): Promise<{ runDir: string }> {
  const { listDirectories } = await import("../src/base/util.ts");
  const projects = await listDirectories(workdir);
  assert.equal(projects.length, 1, `exactly one project directory: ${JSON.stringify(projects)}`);
  const runs = await listDirectories(join(projects[0], "runs"));
  assert.equal(runs.length, 1, `exactly one run directory: ${JSON.stringify(runs)}`);
  return { runDir: runs[0] };
}
