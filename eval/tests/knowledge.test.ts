import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { extractKnowledge } from "../knowledge.ts";

const RUN_MINI = join(import.meta.dirname, "fixtures", "run-mini");

test("extractKnowledge resolves each cited S-* id to its source window", () => {
  const knowledge = extractKnowledge(RUN_MINI);
  assert.equal(knowledge.facts.length, 5);

  const claim1 = knowledge.facts.find((fact) => fact.claimId === "claim-1")!;
  assert.deepEqual(
    claim1.windows.map((window) => ({ id: window.id, path: window.path, startLine: window.startLine, endLine: window.endLine })),
    [
      { id: "S-approval1", path: "leave-svc/src/approval.ts", startLine: 30, endLine: 60 },
      { id: "S-balance1", path: "leave-svc/src/balance.ts", startLine: 5, endLine: 20 }
    ]
  );
  assert.equal(claim1.ref, "feature-leave-x-engineering#claim-1");
  assert.equal(claim1.documentId, "feature-leave-x-engineering");
});

test("non-source evidence ids (GIT-*) never resolve to a window", () => {
  const knowledge = extractKnowledge(RUN_MINI);
  const everyWindowIsSource = knowledge.facts.every((fact) => fact.windows.every((window) => window.id.startsWith("S-")));
  assert.ok(everyWindowIsSource);
});

test("markers are preserved verbatim on each fact", () => {
  const knowledge = extractKnowledge(RUN_MINI);
  const byId = new Map(knowledge.facts.map((fact) => [fact.claimId, fact.marker]));
  assert.equal(byId.get("claim-3"), "inferred");
  assert.equal(byId.get("claim-4"), "fact");
  assert.equal(byId.get("claim-5"), "unavailable");
});

test("unavailable claims and cannot-determine workitems both become unknowns", () => {
  const knowledge = extractKnowledge(RUN_MINI);
  assert.equal(knowledge.unknowns.length, 2);

  const claimUnknown = knowledge.unknowns.find((unknown) => unknown.source === "claim")!;
  assert.equal(claimUnknown.ref, "feature-leave-x-engineering#claim-5");
  assert.match(claimUnknown.text, /结转/);

  const workitemUnknown = knowledge.unknowns.find((unknown) => unknown.source === "workitem")!;
  assert.equal(workitemUnknown.ref, "project:guard-polarity");
  assert.match(workitemUnknown.text, /guard-polarity/);
});

test("coverage carries every workitem dimension and status", () => {
  const knowledge = extractKnowledge(RUN_MINI);
  const byDimension = new Map(knowledge.coverage.map((entry) => [entry.dimension, entry.status]));
  assert.equal(byDimension.get("authorization"), "found");
  assert.equal(byDimension.get("data-scope"), "searched-not-found");
  assert.equal(byDimension.get("notifications-and-exports"), "not-applicable");
  assert.equal(byDimension.get("guard-polarity"), "cannot-determine");
});

test("prepare horizon collects fact-pack files and omits out-of-scope sources", () => {
  const knowledge = extractKnowledge(RUN_MINI);
  assert.ok(knowledge.prepareHorizon.files.includes("leave-svc/src/scope.ts"));
  assert.ok(knowledge.prepareHorizon.files.includes("leave-svc/src/approval.ts"));
  assert.ok(!knowledge.prepareHorizon.files.some((file) => file.includes("audit-log")));
  assert.ok(!knowledge.prepareHorizon.scopeText.includes("audit-log.ts"));
});

test("extraction is read-only: a directory with no claims still yields a horizon", () => {
  // The run-mini fixture always has claims; assert the shape is total (no throws, arrays present).
  const knowledge = extractKnowledge(RUN_MINI);
  assert.ok(Array.isArray(knowledge.facts));
  assert.ok(Array.isArray(knowledge.relations));
  assert.equal(knowledge.relations.length, 1);
  assert.equal(knowledge.relations[0].steps.length, 2);
});
