import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { BOUNDARY_FUNCTION_KINDS, enumerateBoundaryFunctions } from "../src/context/boundary-functions.ts";
import type { GraphReader } from "../src/codegraph/codegraph.ts";

// This enumeration widens the read-obligation denominator, so its own boundaries have to be visible: which
// files it considered, which of them the graph knew nothing about, and what verdict each candidate got.
// A candidate that is dropped silently would recreate the exact blindness the slice exists to remove.

const GO_FILE = [
  "package leave",                                        // 1
  "",                                                     // 2
  "func (s *svc) Creation(r *Req) error {",               // 3
  "	if r.Days > 3 && r.Attachment == \"\" {",             // 4
  "		return errAttachment",                              // 5
  "	}",                                                   // 6
  "	return nil",                                          // 7
  "}",                                                    // 8
  "",                                                     // 9
  "func (s *svc) Name() string {",                        // 10
  "	return s.name",                                       // 11
  "}",                                                    // 12
].join("\n");

async function workspace(): Promise<{ root: string; absolutePathFor: (path: string) => string | undefined }> {
  const root = await mkdtemp(join(tmpdir(), "excavator-boundary-"));
  const write = async (relative: string, content: string): Promise<void> => {
    await mkdir(dirname(join(root, relative)), { recursive: true });
    await writeFile(join(root, relative), content);
  };
  await write("svc/leave.go", GO_FILE);
  await write("lib/ZMS/Leave.pm", "sub check {\n  if ($lv->{hours} > 16) { return 1; }\n  return 0;\n}\n");
  return { root, absolutePathFor: (path) => join(root, path) };
}

function graphOf(nodes: Array<Record<string, unknown>>): GraphReader {
  return {
    nodesByKindInFiles: (kinds: string[], filePaths: string[]) =>
      nodes.filter((node) => kinds.includes(String(node.kind)) && filePaths.includes(String(node.filePath))) as never,
  } as unknown as GraphReader;
}

test("a branching function is kept and a straight-line one is recorded as decision-free, not dropped", async () => {
  const { absolutePathFor } = await workspace();
  const graph = graphOf([
    { kind: "method", name: "Creation", filePath: "svc/leave.go", startLine: 3, endLine: 8 },
    { kind: "method", name: "Name", filePath: "svc/leave.go", startLine: 10, endLine: 12 },
  ]);
  const warnings: string[] = [];
  const result = await enumerateBoundaryFunctions(graph, { featureKey: "k", files: ["svc/leave.go"], absolutePathFor }, warnings);
  assert.deepEqual(result.functions.map((fn) => [fn.name, fn.probe]), [["Creation", "decision"], ["Name", "no-decision"]]);
  assert.deepEqual(warnings, []);
});

test("a single-line declaration is not a candidate at all", async () => {
  const { absolutePathFor } = await workspace();
  const graph = graphOf([{ kind: "method", name: "Creation", filePath: "svc/leave.go", startLine: 3, endLine: 3 }]);
  const result = await enumerateBoundaryFunctions(graph, { featureKey: "k", files: ["svc/leave.go"], absolutePathFor }, []);
  assert.deepEqual(result.functions, []);
});

test("a language with no grammar yields `unavailable`, and the candidate still appears", async () => {
  const { absolutePathFor } = await workspace();
  const graph = graphOf([{ kind: "function", name: "check", filePath: "lib/ZMS/Leave.pm", startLine: 1, endLine: 4 }]);
  const result = await enumerateBoundaryFunctions(graph, { featureKey: "k", files: ["lib/ZMS/Leave.pm"], absolutePathFor }, []);
  assert.deepEqual(result.functions.map((fn) => [fn.name, fn.probe]), [["check", "unavailable"]]);
});

test("boundary files the graph knows nothing about are named, not silently absent", async () => {
  const { absolutePathFor } = await workspace();
  const graph = graphOf([{ kind: "method", name: "Creation", filePath: "svc/leave.go", startLine: 3, endLine: 8 }]);
  const result = await enumerateBoundaryFunctions(graph, { featureKey: "k", files: ["svc/leave.go", "lib/ZMS/Leave.pm"], absolutePathFor }, []);
  assert.equal(result.files, 2);
  assert.deepEqual(result.filesWithoutCandidates, ["lib/ZMS/Leave.pm"]);
});

test("no graph means no second source, and the absence is a plain empty result rather than a crash", async () => {
  const { absolutePathFor } = await workspace();
  const result = await enumerateBoundaryFunctions(null, { featureKey: "k", files: ["svc/leave.go"], absolutePathFor }, []);
  assert.deepEqual(result.functions, []);
  assert.equal(result.files, 1);
});

test("an unreadable file degrades to a warning and an `unavailable` verdict, never a thrown run", async () => {
  const graph = graphOf([{ kind: "method", name: "Creation", filePath: "svc/leave.go", startLine: 3, endLine: 8 }]);
  const warnings: string[] = [];
  const result = await enumerateBoundaryFunctions(graph, { featureKey: "k", files: ["svc/leave.go"], absolutePathFor: () => undefined }, warnings);
  assert.deepEqual(result.functions.map((fn) => fn.probe), ["unavailable"]);
  assert.match(warnings[0], /not in the snapshot manifest/);
});

test("a failing graph query is a warning, not an exception", async () => {
  const graph = { nodesByKindInFiles: () => { throw new Error("budget exhausted"); } } as unknown as GraphReader;
  const warnings: string[] = [];
  const result = await enumerateBoundaryFunctions(graph, { featureKey: "k", files: ["svc/leave.go"], absolutePathFor: (p) => p }, warnings);
  assert.deepEqual(result.functions, []);
  assert.match(warnings[0], /budget exhausted/);
});

test("output ordering is byte-stable regardless of the order the graph returns candidates", async () => {
  const { absolutePathFor } = await workspace();
  const nodes = [
    { kind: "method", name: "Name", filePath: "svc/leave.go", startLine: 10, endLine: 12 },
    { kind: "method", name: "Creation", filePath: "svc/leave.go", startLine: 3, endLine: 8 },
  ];
  const forward = await enumerateBoundaryFunctions(graphOf(nodes), { featureKey: "k", files: ["svc/leave.go"], absolutePathFor }, []);
  const reversed = await enumerateBoundaryFunctions(graphOf([...nodes].reverse()), { featureKey: "k", files: ["svc/leave.go"], absolutePathFor }, []);
  assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
});

test("container kinds are not enumerated — a class span would swallow its own methods", () => {
  for (const kind of ["class", "struct", "interface", "file", "module"]) {
    assert.ok(!BOUNDARY_FUNCTION_KINDS.includes(kind), `${kind} must stay out of the allowlist`);
  }
  assert.ok(BOUNDARY_FUNCTION_KINDS.includes("component"), "a frontend component carries form rules and conditional rendering");
});
