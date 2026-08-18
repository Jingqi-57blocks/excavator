import test from "node:test";
import assert from "node:assert/strict";
import { maskJsComments } from "../src/schema/parsers/js-comment-mask.ts";

/**
 * The masker's contract is length-preservation, not prettiness: every offset taken from the masked text
 * must still index the original content, because the Sequelize parsers resolve lines against a LineMap
 * built on the REAL file. A masker that deleted comments would silently shift every line number after
 * the first one.
 */

test("comment characters become spaces, newlines survive, and the result is the same length", () => {
  const source = `const a = 1; // trailing\n/* block\n   lines */\nconst b = 2;`;
  const masked = maskJsComments(source);
  assert.equal(masked.length, source.length);
  assert.deepEqual(masked.split("\n").length, source.split("\n").length);
  assert.equal(masked.includes("trailing"), false);
  assert.equal(masked.includes("block"), false);
  assert.equal(masked.includes("const a = 1;"), true);
  assert.equal(masked.includes("const b = 2;"), true);
  // Every offset still points at the same place in the original.
  assert.equal(masked.indexOf("const b = 2;"), source.indexOf("const b = 2;"));
});

test("comment openers INSIDE string literals are not comments — strings survive verbatim", () => {
  const source = `const u = 'http://example.com'; const s = "/* not a comment */"; const t = \`a // b\`;`;
  assert.equal(maskJsComments(source), source);
});

test("a string opener inside a comment does not swallow the code that follows", () => {
  // The apostrophe in `don't` would open a string for any scanner that read comments as code.
  const source = `// don't stop\nconst x = 'kept';`;
  const masked = maskJsComments(source);
  assert.equal(masked.length, source.length);
  assert.equal(masked.includes("'kept'"), true);
});

test("an unterminated block comment masks to end of input instead of running off it", () => {
  const source = `const a = 1;\n/* never closed`;
  const masked = maskJsComments(source);
  assert.equal(masked.length, source.length);
  assert.equal(masked.includes("never closed"), false);
  assert.equal(masked.includes("const a = 1;"), true);
});
