import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPerlFile } from "../src/nativegraph/perl.ts";
import { buildNativeGraph } from "../src/nativegraph/build.ts";

const FOO = `package App::Foo;
use strict;
sub new { my $class = shift; return bless {}, $class; }
sub greet {
    my $self = shift;
    App::Bar->help();
    $self->render();
    my $x = compute(1);
    $obj->dynamic_call();
    return;
}
sub render { my $self = shift; $self->SUPER::render(); }
`;

const BAR = `package App::Bar;
sub help { return 42; }
`;

const TEMPLATE = `<html><body tal:content="here/greet">x</body>
<span tal:replace="here/title"/></html>
`;

test("extractPerlFile recovers packages, subs, and classifies call kinds", () => {
  const ext = extractPerlFile(FOO, "lib/App/Foo.pm");
  assert.ok(ext.ok);
  assert.deepEqual(ext.packages.map((p) => p.name), ["App::Foo"]);
  assert.deepEqual(ext.subs.map((s) => s.name).sort(), ["greet", "new", "render"]);
  // every sub is attributed to its enclosing package
  assert.ok(ext.subs.every((s) => s.package === "App::Foo"));

  const byCallee = (callee: string) => ext.calls.find((c) => c.callee === callee);
  assert.equal(byCallee("help")?.kind, "package-method");
  assert.equal(byCallee("help")?.resolvedPackage, "App::Bar");
  assert.equal(byCallee("help")?.fromSub, "greet");
  assert.equal(byCallee("render")?.kind, "self");
  assert.equal(byCallee("dynamic_call")?.kind, "dynamic");
  assert.ok(ext.calls.some((c) => c.kind === "super"));
  assert.equal(byCallee("compute")?.kind, "function");
});

test("extractPerlFile never resolves a dynamic receiver to a package", () => {
  const ext = extractPerlFile(FOO, "x.pm");
  const dyn = ext.calls.find((c) => c.callee === "dynamic_call");
  assert.equal(dyn?.kind, "dynamic");
  assert.equal(dyn?.resolvedPackage, undefined);
});

test("buildNativeGraph resolves internal package edges and inventories templates", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nativegraph-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "lib", "App"), { recursive: true });
  await mkdir(join(dir, "root"), { recursive: true });
  await writeFile(join(dir, "lib", "App", "Foo.pm"), FOO);
  await writeFile(join(dir, "lib", "App", "Bar.pm"), BAR);
  await writeFile(join(dir, "root", "index.zpt"), TEMPLATE);

  const graph = await buildNativeGraph({ target: dir, ctags: false });

  assert.deepEqual(graph.packages.map((p) => p.name).sort(), ["App::Bar", "App::Foo"]);
  assert.equal(graph.stats.subs, 4);
  // internal App::Foo -> App::Bar (via App::Bar->help) is resolved; dynamic/self are not internal edges
  assert.deepEqual(
    graph.packageEdges.map((e) => `${e.from}->${e.to}`),
    ["App::Foo->App::Bar"],
  );
  assert.ok(graph.stats.dynamicEdges >= 1);
  assert.equal(graph.templates.zptFiles, 1);
  const names = graph.templates.refs.map((r) => r.name);
  assert.ok(names.includes("greet"));
  assert.ok(names.includes("title"));
  assert.equal(graph.ctags.available, false);
});

test("buildNativeGraph is deterministic (byte-identical JSON on rerun)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nativegraph-det-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "lib", "App"), { recursive: true });
  await writeFile(join(dir, "lib", "App", "Foo.pm"), FOO);
  await writeFile(join(dir, "lib", "App", "Bar.pm"), BAR);

  const a = await buildNativeGraph({ target: dir, ctags: false });
  const b = await buildNativeGraph({ target: dir, ctags: false });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
