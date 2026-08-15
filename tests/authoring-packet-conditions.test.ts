import test from "node:test";
import assert from "node:assert/strict";
import { buildAuthoringPacket } from "../src/assurance/authoring-packet.ts";
import { inventoryConditions } from "../src/assurance/condition-inventory.ts";
import type { DocumentPlan, EvidenceItem, InvestigationPlan, InvestigationWorkItem, TraceCatalog } from "../src/core/types.ts";

// The packet is where a condition can still change the report: measured extraction of literal conditions was
// ~0 while they existed only as an audit residual, so these tests pin that they reach the author BEFORE
// writing — including the windows no work item claims, which is where they were being dropped.

const PATH = "svc/internal/handlers/leave/service.go";

function window(id: string, startLine: number, lines: string[]): EvidenceItem {
  return { id, snapshotId: "s", kind: "source", title: id, path: PATH, startLine, endLine: startLine + lines.length - 1, content: lines.join("\n"), reason: "r", digest: "d" };
}

const THRESHOLDS = window("S-thresholds", 505, [
  `	} else if lv.Hours > 16 {`,
  `	} else if lv.Hours > 40 {`,
]);

function workItem(overrides: Partial<InvestigationWorkItem> = {}): InvestigationWorkItem {
  return {
    id: "feature:k:decision-flow",
    dimension: "decision-flow",
    scope: "feature:k",
    hypothesis: "h",
    status: "found",
    material: true,
    requiredFor: ["feature-k-engineering"],
    evidenceIds: [],
    traceIds: [],
    reportSection: 3,
    origin: "default",
    ...overrides,
  };
}

function document(): DocumentPlan {
  return {
    id: "feature-k-engineering",
    kind: "feature",
    audience: "engineering",
    subject: "Leave",
    templatePath: "/tmp/template.md",
    contextPath: "/tmp/context.md",
    sections: [
      { index: 3, title: "Business rules", file: "/tmp/3.md", claimsFile: "/tmp/3.claims.json", complete: false },
    ],
  };
}

const EMPTY_TRACES: TraceCatalog = { version: 1, runId: "r", traces: [] };

function packet(items: InvestigationWorkItem[], evidence: EvidenceItem[], withConditions: boolean): string {
  const plan: InvestigationPlan = { version: 1, runId: "r", createdAt: "t", items };
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const conditions = withConditions ? inventoryConditions(evidence, []) : undefined;
  return buildAuthoringPacket(document(), plan, byId, EMPTY_TRACES, {}, conditions);
}

test("conditions inside a section's cited window are rendered in that section's block", () => {
  const text = packet([workItem({ evidenceIds: ["S-thresholds"] })], [THRESHOLDS], true);
  assert.match(text, /### Literal conditions inside these windows/);
  assert.match(text, /`lv\.Hours > 16` — svc\/internal\/handlers\/leave\/service\.go:505/);
  assert.match(text, /`lv\.Hours > 40` — svc\/internal\/handlers\/leave\/service\.go:506/);
  assert.doesNotMatch(text, /not linked to a section/, "an assigned window needs no orphan block");
});

// A field compared against several literals is a value SET — the modes/types/states that exist. Rendered
// once per document because a field's values usually span several windows, and reports routinely describe
// one path while leaving the others invisible.
test("a field compared against several values is rendered as a value set, once per document", () => {
  const views = window("S-views", 40, [
    `	if repr.View == "open_positions" {`,
    `	} else if repr.View == "fulfilled_positions" {`,
    `	} else if repr.View == "delayed_positions" {`,
  ]);
  const text = packet([workItem({ evidenceIds: ["S-views"] })], [views], true);
  assert.match(text, /## Value sets compared in these windows \(enum families\)/);
  assert.match(text, /`repr\.View` ∈ \{ `delayed_positions`, `fulfilled_positions`, `open_positions` \}/);
  assert.equal(text.match(/Value sets compared in these windows/g)?.length, 1, "once per document, not per section");
});

test("a single-valued field is not a value set — no enum-family block appears", () => {
  const text = packet([workItem({ evidenceIds: ["S-thresholds"] })], [THRESHOLDS], true);
  assert.doesNotMatch(text, /Value sets compared in these windows/, "two numeric thresholds on one field are not an enum");
});

test("conditions in a window no work item cites are rendered as an unassigned block, never dropped", () => {
  // The real failure this caught: the window was opened during investigation but cited by no work item, so it
  // belonged to no section block and its conditions silently vanished from the packet.
  const text = packet([workItem({ evidenceIds: [] })], [THRESHOLDS], true);
  assert.match(text, /## Literal conditions in opened windows not linked to a section/);
  assert.match(text, /`lv\.Hours > 16`/);
  assert.match(text, /`lv\.Hours > 40`/);
});

test("the packet is byte-identical to before when no inventory is supplied", () => {
  const items = [workItem({ evidenceIds: ["S-thresholds"] })];
  assert.equal(packet(items, [THRESHOLDS], false), packet(items, [THRESHOLDS], false));
  assert.doesNotMatch(packet(items, [THRESHOLDS], false), /Literal conditions/, "the feature is additive: absent inventory changes nothing");
});

test("an empty inventory adds no block at all", () => {
  const plain = window("S-plain", 10, ["	return nil"]);
  const text = packet([workItem({ evidenceIds: ["S-plain"] })], [plain], true);
  assert.doesNotMatch(text, /Literal conditions/);
});
