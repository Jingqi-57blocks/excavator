import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { EvidenceItem, ReportRequest } from "../src/base/types.ts";
import { freezeRun, prepareRun } from "../src/run/run.ts";
import { checkpointUnit } from "../src/report/unit-checkpoint.ts";
import { assembleUnits } from "../src/run/stages/unit-assemble-stage.ts";
import { exists, slugify } from "../src/base/util.ts";
import { copyFixture, createCodeGraphFixture, disposeAllWorkItems, installFixturePlan, manifestOf, tempDir } from "./helpers.ts";
import { planViewOf, unitDraftFor } from "./unit-fixture.ts";

// SKILL.md tells the model which `excavator` commands and flags to run. When it drifts from the real
// CLI the skill breaks silently, so this test pins the two together: every command/subcommand/flag the
// SKILL's concrete examples reference must actually exist in the CLI. It checks the SKILL -> CLI
// direction only (the CLI may expose commands/flags the SKILL does not document, which is fine).

const SKILL_PATH = resolve("skills/excavator/SKILL.md");
const CLI_PATH = resolve("src/cli.ts");

interface Invocation {
  command: string;
  subcommand?: string;
  flags: string[];
  /** The verbatim SKILL example line, used only for failure messages. */
  source: string;
}

/**
 * Pull concrete invocations out of the ```bash fences, where the SKILL commits to exact commands.
 * We deliberately parse only fenced examples (not prose) so ordinary sentences cannot mint fake
 * command tokens. Long flags are collected conservatively: a flag value never begins with `--`, so
 * matching `^--...$` picks up flags and skips their values without needing a shell-accurate tokenizer.
 */
function extractInvocations(skill: string, subcommandCommands: Set<string>): Invocation[] {
  const blocks = [...skill.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);
  assert.ok(blocks.length >= 8, `expected several bash examples in SKILL.md, found ${blocks.length}`);
  const invocations: Invocation[] = [];
  for (const block of blocks) {
    // Join backslash line-continuations so a multi-line command becomes one logical line.
    const joined = block.replace(/\\\n\s*/g, " ");
    for (const raw of joined.split("\n")) {
      const line = raw.trim();
      const tokens = line.split(/\s+/).filter(Boolean);
      // Exactly `excavator` — this skips `excavator-html`, which is a separate binary with its own CLI.
      if (tokens[0] !== "excavator") continue;
      const command = tokens[1];
      if (!command) continue;
      let subcommand: string | undefined;
      if (subcommandCommands.has(command)) subcommand = tokens.slice(2).find((token) => !token.startsWith("-"));
      const flags = tokens.filter((token) => /^--[a-z][a-z-]*$/.test(token));
      invocations.push({ command, subcommand, flags, source: line });
    }
  }
  return invocations;
}

/** Spawn the CLI exactly as a user would and capture its output. */
function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
  return new Promise((done) => child.once("exit", (code) => done({ code, stdout, stderr })));
}

/**
 * The set of flags the CLI itself advertises for one command (or `command subcommand`) key, read from
 * the rendered `--help` page — the per-command help table batch B3 added, as the running CLI exposes
 * it. Asserting the page header equals the exact key proves the key resolves in dispatch: a bogus
 * subcommand would fall back to the bare command's page and could otherwise pass a flag check silently.
 */
async function helpFlags(parts: string[]): Promise<Set<string>> {
  const key = parts.join(" ");
  const { code, stdout } = await cli([...parts, "--help"]);
  assert.equal(code, 0, `\`excavator ${key} --help\` exited ${code}`);
  const lines = stdout.split("\n");
  const header = lines.find((line) => line.trim().length)?.trim();
  assert.equal(header, `Excavator ${key}`, `\`--help\` did not resolve to the \`${key}\` page (got: ${header})`);
  const flags = new Set<string>();
  for (const line of lines) {
    const match = line.trim().match(/^(--[a-z][a-z-]*)/);
    if (match) flags.add(match[1]);
  }
  assert.ok(flags.size >= 1, `parsed no flags from \`${key} --help\``);
  return flags;
}

test("SKILL.md references only excavator commands, subcommands and flags the CLI implements", async () => {
  const skill = await readFile(SKILL_PATH, "utf8");
  const cliSource = await readFile(CLI_PATH, "utf8");

  // Source of truth #1 — command dispatch: every `case "<name>":` label in main()'s switch.
  const switchCommands = new Set([...cliSource.matchAll(/case "([^"]+)":/g)].map((match) => match[1]));
  // Source of truth #2 — subcommand keys: the quoted `"<command> <subcommand>"` COMMAND_HELP entries.
  const subcommandKeys = new Set([...cliSource.matchAll(/"([a-z]+ [a-z]+)"\s*:\s*\{/g)].map((match) => match[1]));
  const subcommandCommands = new Set([...subcommandKeys].map((key) => key.split(" ")[0]));

  // Guard the source parse itself against silently matching nothing.
  assert.ok(switchCommands.size >= 15, `switch parse found too few commands: ${switchCommands.size}`);
  assert.deepEqual([...subcommandKeys].sort(), ["codegraph build", "codegraph status"]);

  const invocations = extractInvocations(skill, subcommandCommands);
  assert.ok(invocations.length >= 12, `extracted too few invocations: ${invocations.length}`);

  // Anti-vacuity floor: the SKILL commits to the whole authoring workflow. If the extractor silently
  // degrades, or the workflow examples are gutted, this catches it before the per-invocation checks.
  const commandsSeen = new Set(invocations.map((invocation) => invocation.command));
  for (const core of ["prepare", "freeze", "source", "search", "checkpoint", "draft", "collect", "workitem", "trace", "audit", "assemble", "resume", "codegraph"]) {
    assert.ok(commandsSeen.has(core), `SKILL.md no longer shows a \`${core}\` example`);
  }

  // One `--help` spawn per distinct key, cached across the (many) invocations that reuse a command.
  const flagCache = new Map<string, Promise<Set<string>>>();
  const flagsFor = (parts: string[]): Promise<Set<string>> => {
    const key = parts.join(" ");
    if (!flagCache.has(key)) flagCache.set(key, helpFlags(parts));
    return flagCache.get(key)!;
  };

  for (const invocation of invocations) {
    assert.ok(switchCommands.has(invocation.command), `SKILL.md references unknown command \`${invocation.command}\` (${invocation.source})`);
    if (invocation.subcommand) {
      const key = `${invocation.command} ${invocation.subcommand}`;
      assert.ok(subcommandKeys.has(key), `SKILL.md references unknown subcommand \`${key}\` (${invocation.source})`);
    }
    const parts = invocation.subcommand ? [invocation.command, invocation.subcommand] : [invocation.command];
    const flags = await flagsFor(parts);
    for (const flag of invocation.flags) {
      assert.ok(flags.has(flag), `SKILL.md uses \`${flag}\` on \`${parts.join(" ")}\` but its --help advertises no such flag (${invocation.source})`);
    }
  }
});

async function collectBasenames(dir: string): Promise<Set<string>> {
  const names = new Set<string>();
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      names.add(entry.name);
      if (entry.isDirectory()) await walk(join(current, entry.name));
    }
  };
  await walk(dir);
  return names;
}

test("SKILL.md run-directory layout matches what the CLI produces", async () => {
  const skill = await readFile(SKILL_PATH, "utf8");

  // The documented tree lives in the ```text block that carries the `<workdir>` path template.
  const tree = [...skill.matchAll(/```text\n([\s\S]*?)```/g)].map((match) => match[1]).find((block) => block.includes("<workdir>"));
  assert.ok(tree, "SKILL.md no longer documents the run-directory tree");
  const documented = new Set<string>();
  for (const line of tree.split("\n")) {
    // Capture the entry after a tree branch glyph, dropping a trailing `/` and any inline `# comment`.
    const match = line.match(/[├└]──\s*([^\s#]+)/);
    if (match) documented.add(match[1].replace(/\/$/, ""));
  }
  assert.ok(documented.size >= 15, `parsed too few layout entries: ${documented.size}`);

  // Drive a minimal but complete lifecycle so every documented path is produced:
  //   prepare -> checkpoint each section -> re-checkpoint one (writes history/) -> assemble (writes reports/companions/).
  const target = await copyFixture();
  const workdir = await tempDir();
  const codegraph = join(workdir, "codegraph.db");
  createCodeGraphFixture(codegraph);
  const request: ReportRequest = {
    target,
    codegraph,
    workdir,
    language: "en-US",
    overviewAudiences: ["product"],
    features: [],
    budgets: { prepareMs: 30_000, authorMs: 30_000, maxGraphQueries: 30, maxSourceWindows: 30, maxSourceCharacters: 80_000, maxFiles: 10_000, maxFeatureNodes: 60, maxExpansionDepth: 2 }
  };
  const { runDir, manifest } = await prepareRun(request);

  // The workdir-layout contract the SKILL documents: `<workdir>/<project>/runs/<run-id>/`, where
  // `<project>` is the slugified target basename. Validate the template without pinning the run-id value.
  const projectDir = join(resolve(workdir), slugify(basename(resolve(target))));
  assert.equal(dirname(dirname(runDir)), projectDir, `run directory is not under <workdir>/<project>: ${runDir}`);
  assert.equal(basename(dirname(runDir)), "runs", `run directory is not under a runs/ segment: ${runDir}`);

  // Dispose the plan and freeze so the run produces knowledge.json, the frozen record the tree documents.
  await disposeAllWorkItems(runDir);
  await freezeRun(runDir);
  // The plan precondition of authoring, derived from this run's own catalog (zero model calls).
  await installFixturePlan(runDir);

  // The UNIT lifecycle on the same run, so the tree this test drives is not only the section one:
  //   plan (already recorded above) -> checkpoint each unit -> re-draft one (writes units/<key>/history/)
  //   -> assemble --units --mode write (writes the unit deliverable and its companions).
  // The two paths write disjoint names under reports/, and `assemble --units` refuses a collision by name
  // rather than overwriting, so driving both on one run is legal rather than lucky.
  const evidence = JSON.parse(await readFile(join(runDir, "evidence.json"), "utf8")) as { evidence: EvidenceItem[] };
  const evidenceId = (evidence.evidence.find((item) => item.kind === "source") ?? evidence.evidence[0]!).id;
  const unitRun = { runDir, workdir, manifest: await manifestOf(runDir), evidenceId, view: await planViewOf(runDir) };
  for (const unitId of unitRun.view.collectionOrder) {
    await checkpointUnit(runDir, await unitDraftFor({ ...unitRun, view: await planViewOf(runDir) }, unitId));
  }
  const redrawn = unitRun.view.collectionOrder[0]!;
  await checkpointUnit(runDir, await unitDraftFor({ ...unitRun, view: await planViewOf(runDir) }, redrawn));
  const assembledUnits = await assembleUnits(runDir, "write");

  // Every documented entry must exist somewhere under the run directory. Matching on basename keeps the
  // check independent of the tree's nesting (e.g. companions/ lives under reports/).
  const present = await collectBasenames(runDir);
  for (const entry of documented) {
    assert.ok(present.has(entry), `SKILL.md documents \`${entry}\` but the run produced no such path`);
  }
  // What ONLY the unit lifecycle produces, so the addition above is not inert and cannot be deleted silently.
  // `plan/` is deliberately not in this list: `installFixturePlan` already created it before any unit command,
  // so asserting it would pass for a reason that has nothing to do with the lifecycle it names.
  assert.ok(present.has("units"), "the unit lifecycle produced no `units/` directory");
  assert.ok(assembledUnits.documents.length > 0, "the unit lifecycle assembled no document");
  for (const document of assembledUnits.documents) {
    assert.ok(await exists(join(runDir, document.path)), `the unit deliverable ${document.path} is not on disk`);
  }
});
