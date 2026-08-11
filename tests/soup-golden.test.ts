import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildSoupInventory } from "../src/soup.ts";
import type { SoupComponent } from "../src/soup.ts";

// Golden tests over real trees, not synthetic fixtures. The self-referential run is CI-permanent: it
// scans this very repository, where the machine-checkable invariant is that Core declares zero npm
// dependencies (its root package.json contributes no npm component). The external targets are the real
// cebreo (.NET/MAUI + Angular yarn.lock + Dockerfiles) and wcp (Go + npm) repositories; they run when
// present on the developer's machine and skip cleanly in CI where they are absent. Every asserted value
// was verified by hand against the source files and carries no credentials.

const CEBREO = "/Users/57block/Documents/excavator-test-repos/cebreo";
const WCP = "/Users/57block/Documents/excavator-test-repos/wcp";

const has = (component: SoupComponent, name: string, version: string): boolean =>
  component.name === name && component.version === version;

test("self-referential: Excavator Core declares zero npm dependencies, and the digest is stable", async () => {
  const target = resolve(".");
  const inventory = await buildSoupInventory(target);
  assert.equal(inventory.version, "soup-v1");
  assert.ok(inventory.components.length > 0, "the scan found components (e.g. the test fixtures)");

  // The Core zero-dependency contract, machine-verified: no npm component may originate from the
  // repository-root package.json. (The hono entries come from eval/ and tests/ fixture targets.)
  for (const component of inventory.components.filter((entry) => entry.ecosystem === "npm")) {
    for (const evidence of component.evidence) {
      assert.notEqual(evidence.path, "package.json", `Core gained an npm dependency: ${component.name}`);
    }
  }

  const again = await buildSoupInventory(target);
  assert.equal(inventory.digest, again.digest, "two scans of the same tree are byte-identical");
});

test("cebreo: known .NET packages, container tags, and a zero-component .sln with a note", { skip: !existsSync(CEBREO) }, async () => {
  const inventory = await buildSoupInventory(CEBREO);

  assert.ok(inventory.components.some((component) => has(component, "Newtonsoft.Json", "13.0.3") && component.ecosystem === "nuget"));
  assert.ok(inventory.components.some((component) => has(component, "Serilog", "3.1.1") && component.ecosystem === "nuget"));

  // A real Dockerfile FROM with an exact tag becomes a container component.
  assert.ok(inventory.components.some((component) => component.ecosystem === "container" && component.name === "eclipse-temurin" && component.version !== null));

  // .sln files are recognized but emit no components, with an honest coverage note.
  const sln = inventory.coverage.find((row) => row.parserId === "nuget-sln");
  assert.ok(sln, "the .sln parser ran");
  assert.equal(sln?.itemCount, 0);
  assert.ok(sln!.filesMatched >= 1 && sln!.notes.length >= 1);

  const again = await buildSoupInventory(CEBREO);
  assert.equal(inventory.digest, again.digest);
});

test("wcp: go.mod/go.sum exact pins and a v1 package-lock reported as unparsed", { skip: !existsSync(WCP) }, async () => {
  const inventory = await buildSoupInventory(WCP);

  assert.ok(inventory.components.some((component) => component.ecosystem === "go" && has(component, "github.com/gin-gonic/gin", "v1.7.4")));

  // wcp-service/package-lock.json is lockfileVersion 1; it must be reported as not parsed, not silently dropped.
  const lock = inventory.coverage.filter((row) => row.parserId === "npm-package-lock");
  assert.ok(lock.some((row) => row.notes.some((note) => note.includes("not parsed"))), "a v1 package-lock is reported as unparsed");

  const again = await buildSoupInventory(WCP);
  assert.equal(inventory.digest, again.digest);
});
