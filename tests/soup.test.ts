import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildSoupInventory, soupEvidence } from "../src/soup.ts";
import { tempDir } from "./helpers.ts";

async function targetWith(files: Record<string, string>): Promise<string> {
  const target = await tempDir();
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(target, relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return target;
}

test("a manifest range plus a lockfile exact pin resolve the same group (no gap)", async () => {
  const target = await targetWith({
    "package.json": JSON.stringify({ dependencies: { hono: "^4.0.0" } }, null, 2),
    "package-lock.json": JSON.stringify({
      name: "x", lockfileVersion: 3,
      packages: { "": { name: "x" }, "node_modules/hono": { version: "4.0.1" } }
    }, null, 2)
  });
  const inventory = await buildSoupInventory(target);
  const hono = inventory.components.filter((component) => component.name === "hono");
  assert.equal(hono.length, 2, "both the manifest range and the lockfile pin are listed");
  assert.ok(hono.some((component) => component.version === "4.0.1"));
  assert.equal(inventory.gaps.filter((gap) => gap.name === "hono").length, 0, "the group has an exact version -> not a gap");
});

test("a manifest range with no lockfile pin is a group-level gap", async () => {
  const target = await targetWith({ "package.json": JSON.stringify({ dependencies: { hono: "^4.0.0" } }, null, 2) });
  const inventory = await buildSoupInventory(target);
  const gap = inventory.gaps.find((entry) => entry.name === "hono");
  assert.ok(gap, "an unpinned dependency is a gap");
  assert.equal(gap?.reason, "no-exact-version");
  assert.ok(gap?.evidence.length && gap.evidence[0].path === "package.json");
});

test("a versionless csproj reference resolved by central .props is not a gap", async () => {
  const target = await targetWith({
    "App.csproj": `<Project>\n  <ItemGroup>\n    <PackageReference Include="Central.Managed" />\n  </ItemGroup>\n</Project>\n`,
    "Directory.Packages.props": `<Project>\n  <ItemGroup>\n    <PackageVersion Include="Central.Managed" Version="4.5.6" />\n  </ItemGroup>\n</Project>\n`
  });
  const inventory = await buildSoupInventory(target);
  assert.equal(inventory.gaps.filter((gap) => gap.name === "Central.Managed").length, 0);
  assert.ok(inventory.components.some((component) => component.name === "Central.Managed" && component.version === "4.5.6"));
});

test("the same dependency declared in two files dedupes into one component with merged evidence", async () => {
  const manifest = JSON.stringify({ dependencies: { hono: "^4.0.0" } }, null, 2);
  const target = await targetWith({ "package.json": manifest, "web/package.json": manifest });
  const inventory = await buildSoupInventory(target);
  const hono = inventory.components.filter((component) => component.name === "hono");
  assert.equal(hono.length, 1, "identical declarations collapse to one component");
  assert.deepEqual(hono[0].evidence.map((entry) => entry.path).sort(), ["package.json", "web/package.json"]);
});

test("exceeding the per-ecosystem cap truncates deterministically and warns, never silently", async () => {
  const target = await targetWith({
    "package.json": JSON.stringify({ dependencies: { aaa: "1.0.0", bbb: "2.0.0", ccc: "3.0.0" } }, null, 2)
  });
  const inventory = await buildSoupInventory(target, { maxItemsPerEcosystem: 2 });
  assert.equal(inventory.components.filter((component) => component.ecosystem === "npm").length, 2);
  assert.ok(inventory.warnings.some((warning) => warning.includes("truncated")));
  assert.ok(inventory.coverage.some((row) => row.ecosystem === "npm" && row.truncated));
});

test("two inventories of the same tree are byte-identical (digest excludes createdAt)", async () => {
  const target = await targetWith({
    "package.json": JSON.stringify({ dependencies: { hono: "4.0.1" } }, null, 2),
    "go.mod": "module x\n\ngo 1.21\n\nrequire github.com/gin-gonic/gin v1.7.4\n",
    "Dockerfile": "FROM nginx:1.25-alpine\n"
  });
  const first = await buildSoupInventory(target);
  const second = await buildSoupInventory(target);
  assert.equal(first.digest, second.digest);
  assert.notEqual(first.createdAt, undefined);
});

test("soupEvidence yields one manifest-kind item per ecosystem, path+line only, with a digest", async () => {
  const target = await targetWith({
    "package.json": JSON.stringify({ dependencies: { hono: "4.0.1" } }, null, 2),
    "go.mod": "module x\n\ngo 1.21\n\nrequire github.com/gin-gonic/gin v1.7.4\n"
  });
  const inventory = await buildSoupInventory(target);
  const evidence = soupEvidence(inventory);
  const ecosystems = evidence.map((entry) => (entry.data as { ecosystem: string }).ecosystem).sort();
  assert.deepEqual(ecosystems, ["go", "npm"]);
  for (const entry of evidence) {
    assert.equal(entry.kind, "manifest");
    assert.match(entry.id, /^SOUP-/);
    assert.ok(entry.digest.length === 64);
    assert.equal(entry.content, undefined, "evidence stores structured data, not file content");
    const data = entry.data as { components: Array<{ evidence: Array<Record<string, unknown>> }> };
    for (const component of data.components) for (const ref of component.evidence) {
      assert.deepEqual(Object.keys(ref).sort(), ["line", "path"], "evidence refs carry only path+line");
    }
  }
});
