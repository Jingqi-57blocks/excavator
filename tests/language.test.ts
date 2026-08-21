import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { prepareRun } from "../src/run/run.ts";
import type { ReportRequest } from "../src/base/types.ts";
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

