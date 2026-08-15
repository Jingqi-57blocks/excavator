import test from "node:test";
import assert from "node:assert/strict";
import { goImportAliases, parseHandlerTarget, resolveHandler } from "../src/crossrepo/handler-resolve.ts";
import type { GraphNode } from "../src/core/types.ts";

// A handler attributed to the wrong function puts a reading obligation — and later a claim — on code that
// has nothing to do with the route. So every rule here exists to make the answer unique or absent.

function node(kind: string, name: string, filePath: string, startLine: number, endLine: number): GraphNode {
  return { id: `${filePath}:${startLine}`, kind, name, qualifiedName: name, filePath, language: "go", startLine, endLine, docstring: null, signature: null };
}

test("the handler is the last qualified identifier, not the wrapper around it", () => {
  assert.deepEqual(parseHandlerTarget("e.CatchError(leave.Creation)"), { qualifier: "leave", name: "Creation" });
  assert.deepEqual(parseHandlerTarget("leave.Creation"), { qualifier: "leave", name: "Creation" });
  assert.deepEqual(parseHandlerTarget("handleThing"), { qualifier: null, name: "handleThing" });
});

// Measured: 48 express registrations resolved to `res.json`, picked out of the closure body.
test("an inline handler has no named function to point at, and says so", () => {
  assert.equal(parseHandlerTarget("(req, res) => res.json({ ok: true })"), null);
  assert.equal(parseHandlerTarget("async function (req, res) { res.json(x); }"), null);
});

// Both halves of `pkg.Name` are load-bearing, and both were measured on the real target.
test("the package qualifier disambiguates same-named handlers across packages", () => {
  const candidates = [
    node("function", "Creation", "internal/handlers/leave/router.go", 30, 37),
    node("function", "Creation", "internal/handlers/policy/router.go", 13, 19),
  ];
  const resolved = resolveHandler({ qualifier: "leave", name: "Creation" }, candidates);
  assert.equal(resolved?.path, "internal/handlers/leave/router.go");
  assert.equal(resolved?.startLine, 30);
});

test("`pkg.Name` is a package function, never a method of the same name in that package", () => {
  const candidates = [
    node("function", "Demand", "internal/handlers/leave/router.go", 48, 55),
    node("method", "Demand", "internal/handlers/leave/service.go", 136, 274),
  ];
  const resolved = resolveHandler({ qualifier: "leave", name: "Demand" }, candidates);
  assert.equal(resolved?.path, "internal/handlers/leave/router.go", "the larger span is the service method, not the handler");
});

test("an import alias maps the qualifier to the package's directory", () => {
  const source = ['import (', '\t"context"', '\taplyGeneral "wcp/internal/handlers/application/general"', ')'].join("\n");
  const aliases = goImportAliases(source);
  assert.equal(aliases.get("aplyGeneral"), "general");

  const candidates = [node("function", "Pagination", "internal/handlers/application/general/router.go", 111, 118)];
  assert.equal(resolveHandler({ qualifier: "aplyGeneral", name: "Pagination" }, candidates, aliases)?.startLine, 111);
  assert.equal(resolveHandler({ qualifier: "aplyGeneral", name: "Pagination" }, candidates), null, "without the alias map it is honestly unresolved");
});

test("two remaining candidates resolve to nothing rather than to a guess", () => {
  const candidates = [
    node("function", "Pagination", "internal/handlers/leave/router.go", 140, 150),
    node("function", "Pagination", "internal/handlers/leave/other.go", 10, 20),
  ];
  assert.equal(resolveHandler({ qualifier: "leave", name: "Pagination" }, candidates), null);
});

test("a directory name must match a whole segment", () => {
  const candidates = [node("function", "Creation", "internal/handlers/leaveDraft/router.go", 30, 37)];
  assert.equal(resolveHandler({ qualifier: "leave", name: "Creation" }, candidates), null);
});

test("a single-line span is not a resolvable handler body", () => {
  const candidates = [node("function", "Creation", "internal/handlers/leave/router.go", 30, 30)];
  assert.equal(resolveHandler({ qualifier: "leave", name: "Creation" }, candidates), null);
});
