import test from "node:test";
import assert from "node:assert/strict";
import { SOUP_PARSERS, isExactVersion } from "../src/soup-parsers.ts";
import type { SoupParser } from "../src/soup-parsers.ts";

function parser(id: string): SoupParser {
  const found = SOUP_PARSERS.find((candidate) => candidate.id === id);
  assert.ok(found, `no parser with id ${id}`);
  return found!;
}

function item(id: string, content: string, name: string) {
  const result = parser(id).parse(content);
  return { result, item: result.items.find((candidate) => candidate.name === name) };
}

test("isExactVersion accepts concrete pins (incl. .NET 4-part, prerelease, Go pseudo) and rejects ranges", () => {
  for (const value of ["1.2.3", "v1.2.3", "2.1.0.18", "9.0.264-pre", "3.1.1", "v3.2.0+incompatible", "v0.0.0-20190718012654-fb15b899a751", "17"]) {
    assert.ok(isExactVersion(value), `${value} should be exact`);
  }
  for (const value of ["^4.0.0", "~1.2.3", ">=1.0.0", "1.2.*", "1.x", "1.2.x", "1.X", "*", "latest", "workspace:*", "[1.0,2.0)"]) {
    assert.ok(!isExactVersion(value), `${value} should NOT be exact`);
  }
});

test("npm-package-json splits exact vs range, marks dev scope, reads scoped and peer/optional deps", () => {
  const content = JSON.stringify({
    dependencies: { hono: "^4.0.0", "left-pad": "1.3.0", "@scope/pkg": "2.0.0" },
    devDependencies: { typescript: "5.4.5" },
    peerDependencies: { react: ">=18" },
    optionalDependencies: { fsevents: "2.3.3" }
  }, null, 2);
  const exact = item("npm-package-json", content, "left-pad").item;
  assert.equal(exact?.version, "1.3.0");
  assert.equal(exact?.versionSpec, undefined);
  const ranged = item("npm-package-json", content, "hono").item;
  assert.equal(ranged?.version, null);
  assert.equal(ranged?.versionSpec, "^4.0.0");
  assert.equal(item("npm-package-json", content, "@scope/pkg").item?.version, "2.0.0");
  assert.equal(item("npm-package-json", content, "typescript").item?.scope, "dev");
  assert.equal(item("npm-package-json", content, "hono").item?.scope, undefined);
  assert.equal(item("npm-package-json", content, "react").item?.versionSpec, ">=18");
  assert.equal(item("npm-package-json", content, "fsevents").item?.version, "2.3.3");
});

test("npm-package-json reports a note on a parse error and on minified single-line input", () => {
  const broken = parser("npm-package-json").parse("{ not json ");
  assert.deepEqual(broken.items, []);
  assert.ok(broken.notes[0].includes("did not parse"));

  const minified = parser("npm-package-json").parse('{"dependencies":{"hono":"1.0.0"}}');
  assert.equal(minified.items[0].line, 1);
  assert.ok(minified.notes.some((note) => note.includes("approximate")));
});

test("npm-package-lock reads the v2/v3 packages map, takes the last node_modules segment, honors dev", () => {
  const content = JSON.stringify({
    name: "x", lockfileVersion: 3,
    packages: {
      "": { name: "x", version: "1.0.0" },
      "node_modules/hono": { version: "4.0.1" },
      "node_modules/@scope/pkg": { version: "2.0.0" },
      "node_modules/a/node_modules/nested": { version: "9.9.9", dev: true }
    }
  }, null, 2);
  assert.equal(item("npm-package-lock", content, "hono").item?.version, "4.0.1");
  assert.equal(item("npm-package-lock", content, "@scope/pkg").item?.version, "2.0.0");
  const nested = item("npm-package-lock", content, "nested").item;
  assert.equal(nested?.version, "9.9.9");
  assert.equal(nested?.scope, "dev");
});

test("npm-package-lock refuses lockfileVersion 1 with a coverage note", () => {
  const v1 = parser("npm-package-lock").parse(JSON.stringify({ lockfileVersion: 1, dependencies: { hono: { version: "4.0.1" } } }));
  assert.deepEqual(v1.items, []);
  assert.ok(v1.notes[0].includes("not parsed"));
});

test("npm-pnpm-lock parses v6 (/name/version) and v9 (name@version) keys, skips snapshots", () => {
  const v6 = `lockfileVersion: '6.0'\npackages:\n  /hono/4.0.1:\n    resolution: {integrity: sha}\n  /@scope/pkg/2.0.0:\n    resolution: {integrity: sha}\n`;
  assert.equal(item("npm-pnpm-lock", v6, "hono").item?.version, "4.0.1");
  assert.equal(item("npm-pnpm-lock", v6, "@scope/pkg").item?.version, "2.0.0");

  const v9 = `lockfileVersion: '9.0'\npackages:\n  hono@4.0.1:\n    resolution: {integrity: sha}\n  '@scope/pkg@2.0.0(react@18.0.0)':\n    resolution: {integrity: sha}\nsnapshots:\n  hono@4.0.1:\n    dependencies: {}\n`;
  assert.equal(item("npm-pnpm-lock", v9, "hono").item?.version, "4.0.1");
  assert.equal(item("npm-pnpm-lock", v9, "@scope/pkg").item?.version, "2.0.0", "peer suffix stripped");
});

test("npm-yarn-lock parses classic (version \"x\") and berry (name@npm:, version: x) headers", () => {
  const classic = `"@babel/core@^7.0.0", "@babel/core@^7.1.0":\n  version "7.1.2"\n\nlodash@^4.17.15:\n  version "4.17.21"\n`;
  assert.equal(item("npm-yarn-lock", classic, "@babel/core").item?.version, "7.1.2");
  assert.equal(item("npm-yarn-lock", classic, "lodash").item?.version, "4.17.21");

  const berry = `__metadata:\n  version: 6\n\n"@ampproject/remapping@npm:1.0.1":\n  version: 1.0.1\n  resolution: "@ampproject/remapping@npm:1.0.1"\n`;
  const parsed = parser("npm-yarn-lock").parse(berry);
  assert.equal(parsed.items.find((entry) => entry.name === "@ampproject/remapping")?.version, "1.0.1");
  assert.ok(!parsed.items.some((entry) => entry.name === "__metadata"), "the __metadata block is skipped");
});

test("nuget-csproj reads single-line, multi-line <Version> child, and leaves a missing version null", () => {
  const content = `<Project>\n  <ItemGroup>\n    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />\n    <PackageReference Include="Central.Managed" />\n    <PackageReference Include="Xamarin.TestCloud.Agent" Version="0.23.2">\n    </PackageReference>\n    <PackageReference Include="Child.Version">\n      <Version>1.2.3</Version>\n    </PackageReference>\n  </ItemGroup>\n</Project>\n`;
  assert.equal(item("nuget-csproj", content, "Newtonsoft.Json").item?.version, "13.0.3");
  assert.equal(item("nuget-csproj", content, "Xamarin.TestCloud.Agent").item?.version, "0.23.2");
  assert.equal(item("nuget-csproj", content, "Child.Version").item?.version, "1.2.3");
  const central = item("nuget-csproj", content, "Central.Managed").item;
  assert.equal(central?.version, null, "no version attribute -> null (central management resolves it via .props)");
});

test("nuget-props reads central PackageVersion, packages.config reads id/version and dev flag", () => {
  const props = `<Project>\n  <ItemGroup>\n    <PackageVersion Include="Central.Managed" Version="4.5.6" />\n  </ItemGroup>\n</Project>\n`;
  assert.equal(item("nuget-props", props, "Central.Managed").item?.version, "4.5.6");

  const config = `<?xml version="1.0"?>\n<packages>\n  <package id="Newtonsoft.Json" version="13.0.3" />\n  <package id="NUnit" version="3.13.0" developmentDependency="true" />\n</packages>\n`;
  assert.equal(item("nuget-packages-config", config, "Newtonsoft.Json").item?.version, "13.0.3");
  assert.equal(item("nuget-packages-config", config, "NUnit").item?.scope, "dev");
});

test("nuget-sln emits zero components and a recognition note", () => {
  const result = parser("nuget-sln").parse("Microsoft Visual Studio Solution File, Format Version 12.00\n");
  assert.deepEqual(result.items, []);
  assert.equal(result.notes.length, 1);
  assert.ok(result.notes[0].includes("no components"));
});

test("pypi-requirements handles extras, comments, -r/-e, and operator vs exact", () => {
  const content = `# a comment\nrequests[security]==2.28.1\nflask>=2.0\n-r other.txt\n--hash=sha256:abc\n-e git+https://example.com/pkg.git#egg=mypkg\nurllib3\n`;
  assert.equal(item("pypi-requirements", content, "requests").item?.version, "2.28.1");
  assert.equal(item("pypi-requirements", content, "flask").item?.versionSpec, ">=2.0");
  assert.equal(item("pypi-requirements", content, "mypkg").item?.version, null);
  assert.equal(item("pypi-requirements", content, "urllib3").item?.version, null);
  assert.ok(!parser("pypi-requirements").parse(content).items.some((entry) => entry.name === "other"), "-r reference is not a component");
});

test("pypi-pyproject reads the PEP 621 array and poetry main/dev groups, skipping python", () => {
  const content = `[project]\ndependencies = [\n  "requests>=2.28",\n  "click==8.1.3",\n]\n\n[tool.poetry.dependencies]\npython = "^3.9"\nhttpx = "0.27.0"\nrich = "^13.0"\n\n[tool.poetry.group.dev.dependencies]\npytest = "8.0.0"\n`;
  assert.equal(item("pypi-pyproject", content, "click").item?.version, "8.1.3");
  assert.equal(item("pypi-pyproject", content, "requests").item?.versionSpec, ">=2.28");
  assert.equal(item("pypi-pyproject", content, "httpx").item?.version, "0.27.0");
  assert.equal(item("pypi-pyproject", content, "rich").item?.versionSpec, "^13.0");
  assert.equal(item("pypi-pyproject", content, "pytest").item?.scope, "dev");
  assert.ok(!parser("pypi-pyproject").parse(content).items.some((entry) => entry.name === "python"), "python constraint is not a component");
});

test("pypi-poetry-lock reads [[package]] name/version blocks", () => {
  const content = `[[package]]\nname = "requests"\nversion = "2.28.1"\n\n[[package]]\nname = "click"\nversion = "8.1.3"\n\n[metadata]\nlock-version = "2.0"\n`;
  assert.equal(item("pypi-poetry-lock", content, "requests").item?.version, "2.28.1");
  assert.equal(item("pypi-poetry-lock", content, "click").item?.version, "8.1.3");
  assert.equal(parser("pypi-poetry-lock").parse(content).items.length, 2);
});

test("go-mod reads single-line and block require, keeps indirect, notes replace", () => {
  const content = `module example.com/x\n\ngo 1.21\n\nrequire github.com/gin-gonic/gin v1.7.4\n\nrequire (\n\tgithub.com/lib/pq v1.9.0 // indirect\n\tgithub.com/spf13/viper v1.8.0\n)\n\nreplace github.com/foo => ../foo\n`;
  assert.equal(item("go-mod", content, "github.com/gin-gonic/gin").item?.version, "v1.7.4");
  assert.equal(item("go-mod", content, "github.com/lib/pq").item?.version, "v1.9.0", "indirect is still collected");
  assert.equal(item("go-mod", content, "github.com/spf13/viper").item?.version, "v1.8.0");
  assert.ok(parser("go-mod").parse(content).notes.some((note) => note.includes("replace")));
});

test("go-sum dedupes the module and its /go.mod line into one exact entry", () => {
  const content = `github.com/gin-gonic/gin v1.7.4/go.mod h1:aaa=\ngithub.com/gin-gonic/gin v1.7.4 h1:bbb=\ngithub.com/lib/pq v1.9.0 h1:ccc=\n`;
  const gin = parser("go-sum").parse(content).items.filter((entry) => entry.name === "github.com/gin-gonic/gin");
  assert.equal(gin.length, 1, "the module line and its /go.mod line collapse to one");
  assert.equal(gin[0].version, "v1.7.4");
});

test("container-dockerfile parses --platform, tags, digests, stage aliases and latest->null", () => {
  const content = `FROM --platform=$BUILDPLATFORM eclipse-temurin:17-jdk AS builder\nFROM builder\nFROM node@sha256:deadbeef AS pinned\nFROM redis\nFROM nginx:1.25-alpine AS runtime\n`;
  const result = parser("container-dockerfile").parse(content);
  const byName = (name: string) => result.items.filter((entry) => entry.name === name);
  assert.equal(byName("eclipse-temurin")[0].version, "17-jdk");
  assert.equal(byName("node")[0].version, "sha256:deadbeef", "digest pin becomes the version");
  assert.equal(byName("nginx")[0].version, "1.25-alpine");
  assert.equal(byName("redis")[0].version, null, "no tag -> null (gap)");
  assert.ok(!result.items.some((entry) => entry.name === "builder"), "a FROM referring to a stage alias is not a component");
});

test("container-compose reads image: values and notes a variable reference", () => {
  const content = `services:\n  web:\n    image: nginx:1.25-alpine\n  db:\n    image: postgres\n  app:\n    image: \${REGISTRY}/app:1.0\n`;
  const result = parser("container-compose").parse(content);
  assert.equal(result.items.find((entry) => entry.name === "nginx")?.version, "1.25-alpine");
  assert.equal(result.items.find((entry) => entry.name === "postgres")?.version, null);
  assert.ok(result.notes.some((note) => note.includes("variable")));
  assert.ok(!result.items.some((entry) => entry.name.includes("REGISTRY")), "a variable image ref is skipped, not emitted");
});

test("every parser is registered once with a distinct id and declares an ecosystem/source", () => {
  assert.equal(SOUP_PARSERS.length, 15);
  const ids = new Set(SOUP_PARSERS.map((candidate) => candidate.id));
  assert.equal(ids.size, 15, "parser ids are unique");
  for (const candidate of SOUP_PARSERS) {
    assert.ok(["npm", "nuget", "pypi", "go", "container"].includes(candidate.ecosystem));
    assert.ok(["manifest", "lockfile", "container"].includes(candidate.source));
  }
});
