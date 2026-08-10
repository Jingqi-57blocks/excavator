import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DEFAULT_WORKDIR } from "../src/defaults.ts";

test("the default workdir constant is .work", () => {
  assert.equal(DEFAULT_WORKDIR, ".work");
});

test("both CLI request builders default their workdir to the shared DEFAULT_WORKDIR", async () => {
  const source = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  // A single source of truth: the legacy literal must be fully retired.
  assert.doesNotMatch(source, /\.excavator-work/, "no legacy .excavator-work default literal remains in cli.ts");
  // normalizeRequest and baseRequest each fall back to the constant — two references, no more.
  const uses = source.match(/\?\?\s*DEFAULT_WORKDIR/g) ?? [];
  assert.equal(uses.length, 2, "both request builders default to DEFAULT_WORKDIR");
});
