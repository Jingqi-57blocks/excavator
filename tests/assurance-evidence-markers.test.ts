import test from "node:test";
import assert from "node:assert/strict";
import { hasEvidenceMarkers, markersIn } from "../src/report/evidence-markers.ts";

// A substantive section whose only evidence-level words are plain Chinese prose (no backticks). This
// is exactly the shape the old document-level regex accepted while the paragraph-level rule rejected
// it — the divergence this slice removes.
const PLAIN_PROSE = "## 概览\n\n系统在持久化之前会验证每个进入的请求，并记录处理结果。\n\n审批流程也会对结果进行验证。\n";
// The same section, now carrying a real backtick-wrapped marker in its prose.
const MARKED = "## 概览\n\n系统在持久化之前会验证每个进入的请求，并记录处理结果。`验证`\n\n审批流程也会对结果进行验证。\n";

test("document-level and paragraph-level checks agree on identical text (one shared rule)", () => {
  // hasEvidenceMarkers (document-level) and markersIn (paragraph-level) both route through markersIn,
  // so on the same text they reach the same verdict — incidental prose is not a marker for either.
  for (const text of [PLAIN_PROSE, MARKED, "verified handler", "验证"]) {
    assert.equal(hasEvidenceMarkers(text), markersIn(text).size > 0, text);
  }
  // The concrete regression: plain-prose "验证" no longer counts as an annotation, a backtick one does.
  assert.equal(hasEvidenceMarkers(PLAIN_PROSE), false);
  assert.equal(hasEvidenceMarkers(MARKED), true);
});
