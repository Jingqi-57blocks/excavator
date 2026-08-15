import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { addSourceEvidence, prepareRun } from "../src/core/run.ts";
import { MAX_WINDOW_LINES } from "../src/snapshot/source.ts";
import type { ReportRequest } from "../src/core/types.ts";
import { copyFixture, tempDir } from "./helpers.ts";

// A window holds at most 240 lines. The ARTIFACT was always honest about that — `endLine` records what was
// actually read, so the read residual counts the remainder as unread — but the CALLER was told nothing, and a
// caller who believes one window covered a 378-line function stops reading. The reading gate cannot catch it:
// it requires a window OVERLAPPING a decision function, not covering it.
//
// The two ways a request comes back short are different facts and must not share a message. The cap leaves
// real code unread; a short file leaves nothing unread. A false "the cap truncated you" is how a true one
// stops being read.

const BUDGETS = { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 50, maxSourceCharacters: 900_000, maxFiles: 10_000, maxFeatureNodes: 80, maxExpansionDepth: 2 };

interface WindowResult {
  clamped?: boolean;
  requestedEndLine?: number;
  unreadFrom?: number;
  notice?: string;
  evidence: { startLine: number; endLine: number; content: string };
}

async function runWithLongFile(): Promise<{ runDir: string; lines: number }> {
  const target = await copyFixture("residual-target");
  const lines = 400;
  await writeFile(join(target, "src/long.ts"), Array.from({ length: lines }, (_, index) => `export const L${index} = ${index};`).join("\n"));
  const workdir = await tempDir();
  const request: ReportRequest = { target, workdir, language: "en-US", detailLevel: "standard", overviewAudiences: ["product"], features: [], budgets: BUDGETS };
  const { runDir } = await prepareRun(request);
  return { runDir, lines };
}

test("a request past the cap says how much was recorded and where reading must resume", async () => {
  const { runDir, lines } = await runWithLongFile();
  const result = await addSourceEvidence(runDir, "src/long.ts", 1, lines, "the whole file at once") as unknown as WindowResult;

  assert.equal(result.clamped, true);
  assert.equal(result.evidence.endLine, MAX_WINDOW_LINES, "the window itself is unchanged — it always recorded the truth");
  assert.equal(result.requestedEndLine, lines);
  assert.equal(result.unreadFrom, MAX_WINDOW_LINES + 1);
  assert.match(result.notice ?? "", new RegExp(`at most ${MAX_WINDOW_LINES} lines`));
  assert.match(result.notice ?? "", /still unread/);
  assert.equal(result.evidence.content.split("\n").length, MAX_WINDOW_LINES);
});

// The false-alarm case. Nothing is unread here, so nothing may claim otherwise.
test("a request past the end of a short file is not reported as a cap truncation", async () => {
  const { runDir } = await runWithLongFile();
  const result = await addSourceEvidence(runDir, "src/server.ts", 1, 900, "past the end of a five-line file") as unknown as WindowResult;

  assert.equal(result.clamped, undefined, "the cap did not bind — the file ended");
  assert.equal(result.unreadFrom, undefined);
  assert.match(result.notice ?? "", /do not exist, so nothing is left unread/);
});

test("a request the file satisfies exactly carries no notice at all", async () => {
  const { runDir } = await runWithLongFile();
  const result = await addSourceEvidence(runDir, "src/long.ts", 10, 40, "an ordinary window") as unknown as WindowResult;

  assert.equal(result.clamped, undefined);
  assert.equal(result.notice, undefined, "a notice on every call is a notice nobody reads");
  assert.equal(result.evidence.endLine, 40);
});

// The span that is exactly the cap is the off-by-one this pair exists to pin.
test("a request of exactly the cap is satisfied, and one line more is not", async () => {
  const { runDir } = await runWithLongFile();
  const exact = await addSourceEvidence(runDir, "src/long.ts", 1, MAX_WINDOW_LINES, "exactly the cap") as unknown as WindowResult;
  assert.equal(exact.clamped, undefined);
  assert.equal(exact.evidence.endLine, MAX_WINDOW_LINES);

  const overBy1 = await addSourceEvidence(runDir, "src/long.ts", 1, MAX_WINDOW_LINES + 1, "one line past the cap") as unknown as WindowResult;
  assert.equal(overBy1.clamped, true);
  assert.equal(overBy1.unreadFrom, MAX_WINDOW_LINES + 1);
});
