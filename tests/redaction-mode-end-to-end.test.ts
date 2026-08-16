import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
import type { ReportRequest } from "../src/core/types.ts";
import { auditRun, prepareRun, runStatus, searchSourceEvidence } from "../src/core/run.ts";
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
  assert.match(recorded, new RegExp(SECRET), "the default is verbatim: a local run reads code the operator already has");

  assert.deepEqual(rederivationFindings(await auditRun(runDir)), [], "and the re-derivation follows the run's own mode");

  assert.equal((await runStatus(runDir)).sourceText, "verbatim", "the operator is told, whether or not they asked");
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
