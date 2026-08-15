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
  unreadThrough?: number;
  notice?: string;
  evidence: { startLine: number; endLine: number; content: string };
}

/** `numbered(n)` writes an n-line file, so a test can say exactly where a file ends. */
function numbered(lines: number, prefix: string): string {
  return Array.from({ length: lines }, (_, index) => `export const ${prefix}${index} = ${index};`).join("\n");
}

async function runWithLongFile(extra: Record<string, number> = {}): Promise<{ runDir: string; target: string; lines: number }> {
  const target = await copyFixture("residual-target");
  const lines = 400;
  await writeFile(join(target, "src/long.ts"), numbered(lines, "L"));
  for (const [name, count] of Object.entries(extra)) await writeFile(join(target, `src/${name}`), numbered(count, "X"));
  const workdir = await tempDir();
  const request: ReportRequest = { target, workdir, language: "en-US", detailLevel: "standard", overviewAudiences: ["product"], features: [], budgets: BUDGETS };
  const { runDir } = await prepareRun(request);
  return { runDir, target, lines };
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

// The case arithmetic alone cannot decide: the file's last line falls exactly where the cap would have cut,
// so the cap test is satisfied while there is nothing after it. Measured before the fix, this pointed the
// reader at a line that does not exist and then charged a window against the budget to find out.
test("a file ending exactly at the cap is not reported as a cap truncation", async () => {
  const { runDir } = await runWithLongFile({ "exact240.ts": MAX_WINDOW_LINES });
  const result = await addSourceEvidence(runDir, "src/exact240.ts", 1, 500, "the file ends exactly at the cap") as unknown as WindowResult;

  assert.equal(result.clamped, undefined, "the cap did not cut anything off — the file ended there");
  assert.equal(result.unreadFrom, undefined, "there is no line 241 to point at");
  assert.match(result.notice ?? "", /file ends at line 240/);
  assert.doesNotMatch(result.notice ?? "", /still unread/);
});

test("the unread range a cap truncation names stops at the end of the file", async () => {
  const { runDir } = await runWithLongFile({ "f300.ts": 300 });
  const result = await addSourceEvidence(runDir, "src/f300.ts", 10, 400, "ask past the end, cap binds first") as unknown as WindowResult;

  assert.equal(result.clamped, true);
  assert.equal(result.evidence.endLine, 249);
  assert.equal(result.unreadFrom, 250);
  assert.equal(result.unreadThrough, 300, "not 400 — lines past the end are not unread, they are absent");
  assert.match(result.notice ?? "", /Lines 250-300 are still unread/);
});

// A file ending in a newline is the POSIX norm, and it is where the false alarm came back: the line count
// counted the empty segment after the final newline, so a 240-line file "ended" at 241 and the caller was
// told line 241 was still unread — then spent a window discovering it was nothing. Every fixture above is
// written WITHOUT a trailing newline, which is exactly why this layer went untested.
test("a trailing newline does not invent a line", async () => {
  const { runDir, target } = await runWithLongFile();
  await writeFile(join(target, "src/nl240.ts"), `${numbered(MAX_WINDOW_LINES, "N")}\n`);
  await writeFile(join(target, "src/crlf240.ts"), `${numbered(MAX_WINDOW_LINES, "R").replaceAll("\n", "\r\n")}\r\n`);
  await writeFile(join(target, "src/nl40.ts"), `${numbered(40, "S")}\n`);

  for (const path of ["src/nl240.ts", "src/crlf240.ts"]) {
    const result = await addSourceEvidence(runDir, path, 1, 500, "trailing newline at the cap") as unknown as WindowResult;
    assert.equal(result.clamped, undefined, `${path}: the file ended, the cap did not cut`);
    assert.match(result.notice ?? "", /file ends at line 240/, path);
    assert.doesNotMatch(result.notice ?? "", /still unread/, path);
  }

  // The absent range must start after the last REAL line, not after the window's phantom one.
  const short = await addSourceEvidence(runDir, "src/nl40.ts", 1, 500, "short file with trailing newline") as unknown as WindowResult;
  assert.match(short.notice ?? "", /file ends at line 40; lines 41-500 do not exist/);
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
