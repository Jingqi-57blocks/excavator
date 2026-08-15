import test from "node:test";
import assert from "node:assert/strict";
import { DECISION_NODE_KINDS, probeDecision } from "../src/assurance/decision-probe.ts";

// This probe decides which boundary functions become read obligations, so its two failure directions cost
// different things: a false "decision" inflates the denominator with spans nobody needs to read, a false
// "no-decision" drops a real rule silently. The third answer, `unavailable`, exists so neither guess is
// forced on a language we cannot parse.

test("a branch is found in Go and in TypeScript", () => {
  assert.equal(probeDecision("func f(h int) int {\n\tif h > 16 { return 1 }\n\treturn 0\n}", "svc/leave.go"), "decision");
  assert.equal(probeDecision("function f(h: number) {\n  return h > 16 ? 1 : 0;\n}", "web/leave.ts"), "decision");
});

test("switch dispatch counts as a branch under either grammar's node names", () => {
  assert.equal(probeDecision('switch state {\ncase "open":\n\treturn 1\n}', "svc/leave.go"), "decision");
  assert.equal(probeDecision('switch (state) {\n  case "open": return 1;\n}', "web/leave.ts"), "decision");
});

test("a loop is a branch — an iteration boundary is a path a reader must follow", () => {
  assert.equal(probeDecision("func f(xs []int) {\n\tfor _, x := range xs { use(x) }\n}", "svc/leave.go"), "decision");
});

test("a straight-line function has no decision", () => {
  assert.equal(probeDecision("func (s *svc) Name() string {\n\treturn s.name\n}", "svc/leave.go"), "no-decision");
  assert.equal(probeDecision("export function total(a: number, b: number) {\n  return a + b;\n}", "web/util.ts"), "no-decision");
});

// The reason this is an AST probe and not a keyword scan: both of these mention `if`/`switch` textually.
test("a branch written inside a comment or a string is not a branch", () => {
  assert.equal(probeDecision("func f() string {\n\t// if h > 16 { return \"x\" }\n\treturn \"y\"\n}", "svc/leave.go"), "no-decision");
  assert.equal(probeDecision('func f() string {\n\treturn "switch state { case open: }"\n}', "svc/leave.go"), "no-decision");
});

test("a language with no grammar answers `unavailable`, never a guess", () => {
  assert.equal(probeDecision("if ($lv->{hours} > 16) { return 1; }", "lib/ZMS/Leave.pm"), "unavailable");
  assert.equal(probeDecision("if x > 16:\n    return 1", "svc/leave.py"), "unavailable");
});

test("unparsable text answers `unavailable` rather than crashing", () => {
  assert.equal(probeDecision("", "svc/leave.go"), "no-decision", "empty is parsable and simply has no branch");
  assert.equal(probeDecision("func f( {{{", "svc/leave.go"), "no-decision", "tree-sitter is error tolerant; a partial parse with no branch is honest");
});

test("the probed node kinds are an enumerable fact, and cover both grammar naming conventions", () => {
  assert.ok(DECISION_NODE_KINDS.includes("if_statement"));
  assert.ok(DECISION_NODE_KINDS.includes("expression_switch_statement"), "Go's switch");
  assert.ok(DECISION_NODE_KINDS.includes("switch_statement"), "TypeScript's switch");
  assert.deepEqual([...DECISION_NODE_KINDS].sort(), [...DECISION_NODE_KINDS], "sorted, so the list stays reviewable");
});
