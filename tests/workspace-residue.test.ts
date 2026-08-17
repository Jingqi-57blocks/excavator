import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectWorkspace } from "../src/base/util.ts";
import { legacyWorkspaceWarning } from "../src/snapshot/workspace-residue.ts";
import { tempDir } from "./helpers.ts";

test("an old-layout residue that a digested target cannot adopt is surfaced as a warning", async () => {
  const workdir = await tempDir("excavator-residue-");
  const owner = await tempDir("excavator-owner-");
  const stranded = await tempDir("excavator-stranded-");

  // A different target already owns `<workdir>/api`, so `stranded/api` resolves to a digested dir.
  const legacy = join(workdir, "api");
  await mkdir(join(legacy, "runs", "run-old"), { recursive: true });
  await writeFile(join(legacy, ".target"), `${join(owner, "api")}\n`);

  const resolved = await projectWorkspace(workdir, join(stranded, "api"));
  assert.notEqual(resolved, legacy, "the colliding target must not reuse the old-layout directory");

  const warning = await legacyWorkspaceWarning(workdir, join(stranded, "api"), resolved);
  assert.ok(warning, "a residue with runs must produce a warning");
  assert.match(warning!, /Historical runs under the old workdir layout/);
  assert.match(warning!, new RegExp(join(legacy, "runs").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("adopting the plain directory (no residue) produces no warning", async () => {
  const workdir = await tempDir("excavator-residue-");
  const target = await tempDir("excavator-fresh-");

  const resolved = await projectWorkspace(workdir, join(target, "api"));
  assert.equal(resolved, join(workdir, "api"), "a lone target keeps the plain basename directory");
  assert.equal(await legacyWorkspaceWarning(workdir, join(target, "api"), resolved), null);
});

test("a digested workspace with no old runs produces no warning", async () => {
  const workdir = await tempDir("excavator-residue-");
  const owner = await tempDir("excavator-owner-");
  const stranded = await tempDir("excavator-stranded-");

  // Same basename collision, but the old-layout directory holds no `runs/` residue to strand.
  const legacy = join(workdir, "api");
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, ".target"), `${join(owner, "api")}\n`);

  const resolved = await projectWorkspace(workdir, join(stranded, "api"));
  assert.notEqual(resolved, legacy);
  assert.equal(await legacyWorkspaceWarning(workdir, join(stranded, "api"), resolved), null);
});
