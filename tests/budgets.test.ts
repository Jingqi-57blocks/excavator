import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { deriveDefaultBudgets, plannedDocumentCount } from "../src/core/budgets.ts";
import { createCodeGraphFixture, copyFixture, tempDir } from "./helpers.ts";

async function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/cli.ts", ...args], {
    cwd: resolve("."),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((done) => child.once("exit", done));
  return { code, stdout, stderr };
}

async function fixtureTarget(): Promise<{ target: string; workdir: string; codegraph: string }> {
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  return { target, workdir, codegraph };
}

test("default budgets are derived from the requested document and feature counts", () => {
  assert.deepEqual(deriveDefaultBudgets(0, 0), {
    prepareMs: 180_000,
    authorMs: 2_400_000,
    maxGraphQueries: 60,
    maxSourceWindows: 150,
    maxSourceCharacters: 300_000,
    maxFiles: 100_000,
    maxFeatureNodes: 220,
    maxExpansionDepth: 2
  });

  // One product overview: the cebreo run needed ~320 source windows for exactly this shape.
  const singleOverview = deriveDefaultBudgets(1, 0);
  assert.equal(singleOverview.maxSourceWindows, 300);
  assert.equal(singleOverview.maxSourceCharacters, 1_000_000);
  assert.equal(singleOverview.prepareMs, 180_000);
  assert.equal(singleOverview.maxGraphQueries, 60);

  // The wcp run measured 2000 queries / 4000 windows / 20M characters at F=21, D=23.
  const wcp = deriveDefaultBudgets(23, 21);
  assert.equal(wcp.maxGraphQueries, 1_740);
  assert.equal(wcp.maxSourceWindows, 3_600);
  assert.equal(wcp.maxSourceCharacters, 16_400_000);
  assert.equal(wcp.prepareMs, 2_700_000);

  const twoFeaturesBothAudiences = deriveDefaultBudgets(4, 2);
  assert.equal(twoFeaturesBothAudiences.prepareMs, 420_000);
  assert.equal(twoFeaturesBothAudiences.maxGraphQueries, 220);
  assert.equal(twoFeaturesBothAudiences.maxSourceWindows, 750);
  assert.equal(twoFeaturesBothAudiences.maxSourceCharacters, 3_100_000);
});

test("derived preparation time is capped and never negative", () => {
  assert.equal(deriveDefaultBudgets(60, 30).prepareMs, 3_600_000);
  assert.equal(deriveDefaultBudgets(200, 100).prepareMs, 3_600_000);
  const degenerate = deriveDefaultBudgets(-5, -5);
  assert.equal(degenerate.maxSourceWindows, 150);
  assert.equal(degenerate.maxGraphQueries, 60);
});

test("per-document budget scaling counts one document per requested audience", () => {
  assert.equal(plannedDocumentCount([], []), 0);
  assert.equal(plannedDocumentCount(["product", "engineering"], []), 2);
  assert.equal(plannedDocumentCount(["product"], [
    { subject: "a", aliases: [], audiences: ["product", "engineering"] },
    { subject: "b", aliases: [], audiences: ["product"] }
  ]), 4);
  assert.equal(deriveDefaultBudgets(plannedDocumentCount(["product"], [{ subject: "a", aliases: [], audiences: ["product"] }]), 1).maxSourceWindows, 450);
});

test("a request file budget overrides the derived default while unset fields stay derived", async () => {
  const { target, workdir, codegraph } = await fixtureTarget();
  const requestPath = join(workdir, "request.json");
  await writeFile(requestPath, JSON.stringify({
    target,
    codegraph,
    workdir,
    language: "en-US",
    detailLevel: "standard",
    overviewAudiences: ["product"],
    features: [],
    budgets: { maxSourceWindows: 11 }
  }));

  const result = await cli(["report", "--request", requestPath]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const budgets = JSON.parse(result.stdout).run.request.budgets;
  assert.equal(budgets.maxSourceWindows, 11, "an explicit request budget wins over the derived default");
  assert.equal(budgets.maxSourceCharacters, 1_000_000, "unset budgets stay derived from the request shape");
  assert.equal(budgets.authorMs, 2_400_000);
});

test("a CLI budget flag overrides both the derived default and the request file", async () => {
  const { target, workdir, codegraph } = await fixtureTarget();
  const requestPath = join(workdir, "request.json");
  await writeFile(requestPath, JSON.stringify({
    target,
    codegraph,
    workdir,
    language: "en-US",
    detailLevel: "standard",
    overviewAudiences: ["product"],
    features: [],
    budgets: { maxSourceWindows: 11 }
  }));

  const overridden = await cli(["report", "--request", requestPath, "--max-source-windows", "13"]);
  assert.equal(overridden.code, 0, overridden.stderr || overridden.stdout);
  assert.equal(JSON.parse(overridden.stdout).run.request.budgets.maxSourceWindows, 13);
});

test("the overview command derives budgets from its audience count and honours CLI overrides", async () => {
  const { target, workdir, codegraph } = await fixtureTarget();
  const derived = await cli(["overview", "--target", target, "--workdir", workdir, "--codegraph", codegraph, "--audience", "both", "--detail", "standard"]);
  assert.equal(derived.code, 0, derived.stderr || derived.stdout);
  const derivedBudgets = JSON.parse(derived.stdout).run.request.budgets;
  assert.equal(derivedBudgets.maxSourceWindows, 450, "two audiences are two documents");
  assert.equal(derivedBudgets.maxSourceCharacters, 1_700_000);
  assert.equal(derivedBudgets.maxGraphQueries, 60, "an overview-only request requests no feature scopes");

  const overridden = await cli(["overview", "--target", target, "--workdir", workdir, "--codegraph", codegraph, "--audience", "both", "--detail", "standard", "--max-source-windows", "17", "--max-graph-queries", "19"]);
  assert.equal(overridden.code, 0, overridden.stderr || overridden.stdout);
  const overriddenBudgets = JSON.parse(overridden.stdout).run.request.budgets;
  assert.equal(overriddenBudgets.maxSourceWindows, 17);
  assert.equal(overriddenBudgets.maxGraphQueries, 19);
  assert.equal(overriddenBudgets.maxSourceCharacters, 1_700_000, "unflagged budgets stay derived");
});

test("the feature command derives feature-scaled budgets", async () => {
  const { target, workdir, codegraph } = await fixtureTarget();
  const result = await cli(["feature", "--target", target, "--workdir", workdir, "--codegraph", codegraph, "--subject", "Leave requests", "--audience", "both", "--detail", "standard"]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  const budgets = JSON.parse(result.stdout).run.request.budgets;
  assert.equal(budgets.maxGraphQueries, 140, "one feature raises the graph query budget");
  assert.equal(budgets.prepareMs, 300_000);
  assert.equal(budgets.maxSourceWindows, 450, "one feature for two audiences is two documents");
});
