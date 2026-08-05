import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { prepareRun } from "../src/run.ts";
import type { ReportRequest } from "../src/types.ts";
import { copyFixture, createCodeGraphFixture, tempDir } from "./helpers.ts";

const CJK = /[\u3400-\u9fff]/u;

async function filesUnder(root: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) result.push(path);
    }
  };
  await walk(root);
  return result;
}

test("all static Skill and report-contract instructions are written in English", async () => {
  for (const path of await filesUnder("skills/excavator")) {
    const content = await readFile(path, "utf8");
    assert.ok(!CJK.test(content), `${path} contains non-English static prompt text`);
  }
});

test("generated authoring prompts remain English while carrying a non-English output language", async () => {
  const target = await copyFixture();
  const workdir = await tempDir();
  const db = join(workdir, "codegraph.db");
  createCodeGraphFixture(db);
  const request: ReportRequest = {
    target,
    codegraph: db,
    language: "zh-CN",
    detailLevel: "standard",
    workdir,
    overviewAudiences: ["product"],
    features: [{ subject: "Account access", aliases: ["permission", "role"], audiences: ["engineering"] }],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 40, maxSourceWindows: 30, maxSourceCharacters: 100_000, maxFiles: 10_000, maxFeatureNodes: 50, maxExpansionDepth: 2 }
  };
  const { runDir, manifest } = await prepareRun(request);
  for (const document of manifest.documents) {
    const prompt = await readFile(join(runDir, "prompts", `${document.id}.md`), "utf8");
    assert.ok(!CJK.test(prompt), `${document.id} contains non-English prompt instructions`);
    assert.match(prompt, /Write \*\*.+\*\* in \*\*zh-CN\*\*/);
    assert.match(prompt, /Report contract:/);
    assert.match(prompt, /Shared project context: `context\/shared\.md`/);
    assert.doesNotMatch(prompt, /## Prepared context/);
  }
});
