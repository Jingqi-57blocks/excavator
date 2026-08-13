import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalystPack } from "../src/framework/catalyst.ts";
import { buildFrameworkModel } from "../src/framework/build.ts";

const APP = `package MyApp;
use Catalyst;
__PACKAGE__->setup;
1;
`;

const ROOT = `package MyApp::Controller::Root;
use base 'Catalyst::Controller';
__PACKAGE__->config->{namespace} = '';
sub auto : Private { }
sub index :Path('/') Args(0) { }
sub list :Local { }
sub show :Chained('/') PathPart('item') Args(1) { }
sub feed :CustomDispatch Args(0) { }
sub helper_method { }
1;
`;

const MODEL = `package MyApp::Model::DB;
use base 'Catalyst::Model::DBIC::Schema';
1;
`;

const VIEW = `package MyApp::View::JSON;
use base 'Catalyst::View::JSON';
1;
`;

const RESULT = `package MyApp::Schema::Result::Widget;
use base 'DBIx::Class::Core';
1;
`;

test("catalystPack detects Catalyst and classifies actions by attribute convention", () => {
  const found = catalystPack.detect([{ file: "lib/MyApp.pm", content: APP }, { file: "lib/MyApp/Controller/Root.pm", content: ROOT }]);
  assert.ok(found);
  assert.equal(found.name, "Catalyst");
  assert.equal(found.confidence, "high");

  const { routes } = catalystPack.extract([{ file: "lib/MyApp/Controller/Root.pm", content: ROOT }]);
  const byAction = (name: string) => routes.find((r) => r.action === name);
  assert.equal(routes.length, 5); // helper_method has no attributes → not an action
  assert.equal(byAction("auto")?.kind, "private");
  assert.equal(byAction("index")?.kind, "path");
  assert.equal(byAction("index")?.pathHint, "/");
  assert.equal(byAction("list")?.kind, "local");
  assert.equal(byAction("show")?.kind, "chained");
  assert.equal(byAction("feed")?.kind, "custom-dispatch"); // app-defined dispatch type, captured not interpreted
  assert.deepEqual(byAction("index")?.attributes, ["Path('/')", "Args(0)"]);
});

test("a bareword function is never resolved to a package (roles come from convention only)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "framework-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "lib", "MyApp", "Controller"), { recursive: true });
  await mkdir(join(dir, "lib", "MyApp", "Model"), { recursive: true });
  await mkdir(join(dir, "lib", "MyApp", "View"), { recursive: true });
  await mkdir(join(dir, "lib", "MyApp", "Schema", "Result"), { recursive: true });
  await writeFile(join(dir, "lib", "MyApp.pm"), APP);
  await writeFile(join(dir, "lib", "MyApp", "Controller", "Root.pm"), ROOT);
  await writeFile(join(dir, "lib", "MyApp", "Model", "DB.pm"), MODEL);
  await writeFile(join(dir, "lib", "MyApp", "View", "JSON.pm"), VIEW);
  await writeFile(join(dir, "lib", "MyApp", "Schema", "Result", "Widget.pm"), RESULT);

  const model = await buildFrameworkModel({ target: dir });
  assert.deepEqual(model.stats.frameworks, ["Catalyst"]);
  assert.equal(model.stats.componentsByRole.controller, 1);
  assert.equal(model.stats.componentsByRole.model, 1);
  assert.equal(model.stats.componentsByRole.view, 1);
  assert.equal(model.stats.componentsByRole.schema, 1);
  assert.equal(model.stats.componentsByRole.application, 1);
  assert.equal(model.stats.actions, 5);
  // namespace override surfaced as a note
  assert.ok(model.warnings.some((w) => w.kind === "namespace-override"));
});

test("buildFrameworkModel is deterministic (byte-identical JSON on rerun)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "framework-det-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "lib", "MyApp", "Controller"), { recursive: true });
  await writeFile(join(dir, "lib", "MyApp.pm"), APP);
  await writeFile(join(dir, "lib", "MyApp", "Controller", "Root.pm"), ROOT);

  const a = await buildFrameworkModel({ target: dir });
  const b = await buildFrameworkModel({ target: dir });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
