import test from "node:test";
import assert from "node:assert/strict";
import { substantiveSegments } from "../src/report/section-audit.ts";

test("a stranded '证据级别：`事实`' segment is non-substantive: it yields no substantive segment", () => {
  // After stripping the marker the residue is 证据级别 (4 semantic chars < 8), so it never becomes a
  // substantive segment and demands no claim — a bare marker line does not break claim accounting.
  const sectionText = "## 证据级别\n\n证据级别：`事实`\n";
  assert.deepEqual(substantiveSegments(sectionText), []);
});
