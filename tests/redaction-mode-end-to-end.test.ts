import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
import type { ReportRequest } from "../src/base/types.ts";
import { auditRun, prepareRun, runStatus, searchSourceEvidence } from "../src/run/run.ts";
import { recordedUnderRedaction, REDACTION_MODE_ASSURANCE_GENERATION } from "../src/base/assurance-version.ts";
import { copyFixture, tempDir } from "./helpers.ts";

// REDACTION MODE, TESTED AS A PROPERTY OF THE RUN RATHER THAN OF ONE FUNCTION.
//
// The mode began as an option on the recording call sites, and the review found that five of them did not
// receive it: a run that ASKED for redaction recorded README windows, route windows, fact packs, context
// excerpts and search receipts verbatim. The mode was applied where it was remembered, which is the same as
// not having a mode.
//
// Two assertions, and the second is the sensitive one. Searching artifacts for the secret catches a leak
// only where a probe thought to look; `auditRun` re-derives every recorded window under the run's own mode
// and compares digests, so ANY path that recorded under a different mode makes the run fail its own audit —
// including paths this test never enumerates. That is how the original defect was found.

const BUDGETS = { prepareMs: 60_000, authorMs: 60_000, maxGraphQueries: 40, maxSourceWindows: 60, maxSourceCharacters: 200_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

const SECRET = "sk-live-aB3dEfGh7Jk2Lm9Np4Qr";

/** A target whose README and source both carry a written-out credential, on the paths prepare records. */
async function targetWithSecret(): Promise<string> {
  const target = await copyFixture();
  await writeFile(join(target, "README.md"), `# Sample\n\nRun it with:\n\n    DB_PASSWORD=${SECRET}\n`, "utf8");
  await writeFile(join(target, "deploy.sh"), `#!/bin/sh\nexport API_TOKEN=${SECRET}\nexec ./server --role admin\n`, "utf8");
  return target;
}

async function request(target: string, redactSecrets: boolean): Promise<ReportRequest> {
  return {
    target, workdir: await tempDir(), language: "en-US", detailLevel: "standard", overviewAudiences: [],
    features: [{ subject: "Leave management", aliases: ["leave", "holiday", "admin"], audiences: ["product"] }],
    budgets: BUDGETS, redactSecrets,
  } as ReportRequest;
}

/** The audit findings that mean "a recorded window does not match what re-reading the source produces". */
function rederivationFindings(result: { findings: Array<{ level: string; message: string }> }): string[] {
  return result.findings.filter((finding) => /digest|excerpt|stale|redact/i.test(finding.message)).map((finding) => finding.message);
}

/** Every recorded byte of a run directory, so a leak cannot hide in an artifact the test did not name. */
async function allArtifactText(runDir: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(json|md|jsonl)$/.test(entry.name)) parts.push(await readFile(path, "utf8"));
    }
  };
  await walk(runDir);
  return parts.join("\n");
}

test("a run with redaction ON records no secret on any surface, and audits itself green", async () => {
  const target = await targetWithSecret();
  const { runDir } = await prepareRun(await request(target, true));

  // A search receipt is its own recording surface, and it is cached across runs of the same snapshot.
  await searchSourceEvidence(runDir, ["API_TOKEN", "DB_PASSWORD"], "probe the search receipt path", { maxResults: 10 });

  const recorded = await allArtifactText(runDir);
  assert.doesNotMatch(recorded, new RegExp(SECRET), "the credential must not appear in ANY recorded artifact");
  assert.match(recorded, /<redacted>/, "and the run must actually have redacted something, not merely missed the file");

  // Scoped to the re-derivation findings: this run was never authored, so the coverage findings a
  // prepare-only run naturally carries are not what is under test. A window recorded under the other mode
  // shows up here and nowhere else.
  const stale = rederivationFindings(await auditRun(runDir));
  assert.deepEqual(stale, [], `an ON run must satisfy its own re-derivation; a half-redacted run reports stale digests: ${stale.join(" | ")}`);

  assert.equal((await runStatus(runDir)).sourceText, "redacted", "and the mode is legible to whoever reads the run");
});

test("a run with redaction OFF records the source as written, and also audits itself green", async () => {
  const target = await targetWithSecret();
  const { runDir } = await prepareRun(await request(target, false));
  await searchSourceEvidence(runDir, ["API_TOKEN", "DB_PASSWORD"], "probe the search receipt path", { maxResults: 10 });

  const recorded = await allArtifactText(runDir);
  assert.match(recorded, new RegExp(SECRET), "verbatim is what an explicit false asks for, and it is honoured exactly");

  assert.deepEqual(rederivationFindings(await auditRun(runDir)), [], "and the re-derivation follows the run's own mode");

  assert.equal((await runStatus(runDir)).sourceText, "verbatim", "the operator is told, whether or not they asked");
});

// THE DEFAULT ITSELF, PINNED — because flipping it moved no test.
//
// `redactSecrets` was `=== true` at the normalization point, so a request that never mentioned the field ran
// verbatim. The whole suite was green before that flip and green after it: 1178 tests, and not one of them
// asserted what a caller who says nothing gets. A security default nothing pins is a default that drifts back.
//
// The assertion is on the RECORDED BYTES, not on the manifest field. Reading the field back would pass even if
// normalization set it and every recording site ignored it — which is the exact failure the two tests above
// exist for. If `prepareRun` returns to `=== true`, the secret reappears in the run directory and this fails.
test("a request that never mentions redaction is redacted, not verbatim", async () => {
  const target = await targetWithSecret();
  const { target: _omit, ...rest } = await request(target, true);
  const silent = { ...rest, target } as ReportRequest;
  delete (silent as { redactSecrets?: boolean }).redactSecrets;

  const { runDir, manifest } = await prepareRun(silent);
  await searchSourceEvidence(runDir, ["API_TOKEN", "DB_PASSWORD"], "probe the search receipt path", { maxResults: 10 });

  const recorded = await allArtifactText(runDir);
  assert.doesNotMatch(recorded, new RegExp(SECRET), "an undecided caller must not leak a credential into the run directory");
  assert.match(recorded, /<redacted>/, "and the run redacted something, rather than the fixture simply lacking a secret");

  assert.equal(manifest.request.redactSecrets, true, "the manifest records the resolved mode, never `undefined`");
  assert.equal((await runStatus(runDir)).sourceText, "redacted", "and the mode it reports is the one it used");
});

// BOTH CLI REQUEST BUILDERS, because only one of them used to resolve the mode at all.
//
// `normalizeRequest` (prepare/report, from a request file) read the flags; `baseRequest` (overview/feature)
// never mentioned `redactSecrets`, so `excavator overview --no-redact` parsed the flag and dropped it. The help
// text promised a mode two of the three prepare commands could not reach. Source-level because `cli.ts` calls
// `main()` at module scope and cannot be imported — which is exactly why the gap survived: nothing could call
// the function to notice.
test("every CLI request builder resolves the redaction mode, and off is the only thing that has to be asked for", async () => {
  const source = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  const resolutions = source.match(/redactSecrets:\s*args\.noRedact === "true" \? false :/g) ?? [];
  assert.equal(resolutions.length, 2, "normalizeRequest and baseRequest both resolve the mode; a builder that omits it silently picks its own default");
  assert.doesNotMatch(source, /redactSecrets:\s*args\.redact === "true" \|\| raw\.redactSecrets === true/,
    "the retired `=== true` form meant an unstated request ran verbatim");
});

// What actually protects archived runs is NOT the version bump — `auditEvidenceCatalog` re-derives digests
// with no generation gate at all — it is this reading of the field. Before v9 redaction was unconditional,
// so a pre-v9 manifest is redacted whatever its request happens to say; a stray `redactSecrets: false` on
// one (a library caller's field surviving the request spread) would otherwise re-derive a redacted archive
// as plain and report every window in it stale.
test("a pre-v9 run is read as redacted whatever its request says", () => {
  const legacy = (assuranceVersion: string, redactSecrets?: boolean) =>
    ({ assuranceVersion, request: { redactSecrets } }) as unknown as Parameters<typeof recordedUnderRedaction>[0];

  assert.equal(recordedUnderRedaction(legacy("assurance-v8-redaction-v7")), true, "absent, old generation");
  assert.equal(recordedUnderRedaction(legacy("assurance-v8-redaction-v7", false)), true,
    "and an explicit false is not evidence before the generation that introduced the field");
  assert.equal(recordedUnderRedaction(legacy(`assurance-v${REDACTION_MODE_ASSURANCE_GENERATION}-mode-redaction-v7`, false)), false,
    "from v9 the run speaks for itself");
  assert.equal(recordedUnderRedaction(legacy(`assurance-v${REDACTION_MODE_ASSURANCE_GENERATION}-mode-redaction-v7`)), true,
    "and a v9 run with the field missing still reads as redacted, never as silently off");
});

// The two modes share a project cache keyed by snapshot. Without the mode in the cache key, whichever run
// went first would serve its bytes to the other — silently, and with the receipt's own digest self-consistent.
test("the two modes do not serve each other cached windows or search receipts", async () => {
  const target = await targetWithSecret();
  const workdir = await tempDir();

  const plainRun = await prepareRun({ ...(await request(target, false)), workdir } as ReportRequest);
  await searchSourceEvidence(plainRun.runDir, ["API_TOKEN"], "warm the shared cache", { maxResults: 10 });
  assert.match(await allArtifactText(plainRun.runDir), new RegExp(SECRET));

  // Same target, same workdir — so the same project cache — with the mode flipped.
  const redactedRun = await prepareRun({ ...(await request(target, true)), workdir } as ReportRequest);
  await searchSourceEvidence(redactedRun.runDir, ["API_TOKEN"], "must not hit the plain entry", { maxResults: 10 });
  assert.doesNotMatch(await allArtifactText(redactedRun.runDir), new RegExp(SECRET),
    "a warm plain cache must not satisfy a run that asked for redaction");
});
