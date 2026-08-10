import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRun } from "../../src/run.ts";
import type { ReportRequest } from "../../src/types.ts";
import { extractKnowledge } from "../knowledge.ts";
import { loadExpected } from "../expected.ts";
import { checkContainment } from "../diff.ts";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "leave-mini");

/** Same copy-then-run pattern as tests/helpers.ts copyFixture, sourcing the eval fixture repo. */
async function prepareLeaveMini(): Promise<string> {
  const target = await mkdtemp(join(tmpdir(), "leave-mini-"));
  await cp(join(FIXTURE, "repo"), target, { recursive: true });
  const workdir = await mkdtemp(join(tmpdir(), "leave-mini-wd-"));
  const request = JSON.parse(await readFile(join(FIXTURE, "request.json"), "utf8")) as ReportRequest;
  request.target = target;
  request.workdir = workdir;
  const { runDir } = await prepareRun(request);
  return runDir;
}

test("prepareRun(leave-mini) is zero-model and lands every expected anchor in the prepared horizon", async () => {
  const runDir = await prepareLeaveMini();
  const knowledge = extractKnowledge(runDir);
  const expected = loadExpected(join(FIXTURE, "expected-knowledge.json"));

  // A freshly prepared run has scope but no authored claims/traces yet.
  assert.equal(knowledge.facts.length, 0);
  assert.ok(knowledge.prepareHorizon.files.length > 0 || knowledge.prepareHorizon.scopeText.length > 0);

  const containment = checkContainment(knowledge, expected);
  assert.ok(containment.allContained, `out of scope: ${JSON.stringify(containment.missing)}`);
  assert.equal(containment.missing.length, 0);

  // Every expected item that carries an anchor is represented in the contained set.
  const anchoredIds = new Set(expected.items.filter((item) => item.anchors.length > 0).map((item) => item.id));
  const containedIds = new Set(containment.contained.map((entry) => entry.id));
  for (const id of anchoredIds) assert.ok(containedIds.has(id), `expected item ${id} has no contained anchor`);
});
