import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractKnowledge, type Knowledge, type KnowledgeFact } from "../knowledge.ts";
import { loadExpected, validateExpected } from "../expected.ts";
import { checkContainment, diffKnowledge } from "../diff.ts";

const RUN_MINI = join(import.meta.dirname, "fixtures", "run-mini");
const LEAVE_MINI_EXPECTED = join(import.meta.dirname, "..", "fixtures", "leave-mini", "expected-knowledge.json");

function readExpected(name: string): unknown {
  return JSON.parse(readFileSync(join(RUN_MINI, name), "utf8"));
}

/** Minimal Knowledge builder for focused anchor/pattern unit tests. */
function knowledgeWith(overrides: Partial<Knowledge>): Knowledge {
  return {
    runDir: "(synthetic)",
    facts: [],
    relations: [],
    coverage: [],
    unknowns: [],
    prepareHorizon: { files: [], scopeText: "" },
    ...overrides
  };
}

function fact(over: Partial<KnowledgeFact>): KnowledgeFact {
  return { ref: "d#c", documentId: "d", claimId: "c", statement: "", marker: "fact", windows: [], ...over };
}

function foundIds(knowledge: Knowledge, expectedRaw: unknown): string[] {
  return diffKnowledge(knowledge, validateExpected(expectedRaw)).found.map((entry) => entry.id).sort();
}

test("anchor path forms: root/path exact, endsWith('/'+path), and bare path all match", () => {
  const knowledge = knowledgeWith({
    facts: [fact({ ref: "d#c1", windows: [{ id: "S-1", path: "svc/src/a.ts", startLine: 1, endLine: 10 }] })]
  });
  for (const anchor of [{ root: "svc", path: "src/a.ts" }, { path: "a.ts" }, { path: "svc/src/a.ts" }]) {
    const found = foundIds(knowledge, {
      version: "expected-knowledge-v1",
      target: "t",
      items: [{ id: "x", kind: "fact", mustFind: true, anchors: [anchor] }]
    });
    assert.deepEqual(found, ["x"], `anchor ${JSON.stringify(anchor)} should match`);
  }
});

test("a bare path that is only a substring (not a path segment) does NOT match", () => {
  const knowledge = knowledgeWith({
    facts: [fact({ windows: [{ id: "S-1", path: "svc/src/approval.ts", startLine: 1, endLine: 10 }] })]
  });
  const found = foundIds(knowledge, {
    version: "expected-knowledge-v1",
    target: "t",
    items: [{ id: "x", kind: "fact", mustFind: true, anchors: [{ path: "roval.ts" }] }]
  });
  assert.deepEqual(found, []);
});

test("line overlap gates the match; a non-overlapping window does not satisfy the anchor", () => {
  const knowledge = knowledgeWith({
    facts: [fact({ windows: [{ id: "S-1", path: "svc/a.ts", startLine: 30, endLine: 60 }] })]
  });
  const overlap = foundIds(knowledge, { version: "expected-knowledge-v1", target: "t", items: [{ id: "hit", kind: "fact", mustFind: true, anchors: [{ path: "a.ts", lines: "50-70" }] }] });
  const disjoint = foundIds(knowledge, { version: "expected-knowledge-v1", target: "t", items: [{ id: "miss", kind: "fact", mustFind: true, anchors: [{ path: "a.ts", lines: "1-10" }] }] });
  assert.deepEqual(overlap, ["hit"]);
  assert.deepEqual(disjoint, []);
});

test("statementPatterns are AND: all must match the same claim", () => {
  const knowledge = knowledgeWith({
    facts: [fact({ statement: "两级审批后扣减余额", windows: [{ id: "S-1", path: "a.ts", startLine: 1, endLine: 9 }] })]
  });
  const bothMatch = foundIds(knowledge, { version: "expected-knowledge-v1", target: "t", items: [{ id: "x", kind: "fact", mustFind: true, anchors: [{ path: "a.ts" }], statementPatterns: ["两级审批", "扣减.*余额"] }] });
  const oneFails = foundIds(knowledge, { version: "expected-knowledge-v1", target: "t", items: [{ id: "x", kind: "fact", mustFind: true, anchors: [{ path: "a.ts" }], statementPatterns: ["两级审批", "不存在的短语"] }] });
  assert.deepEqual(bothMatch, ["x"]);
  assert.deepEqual(oneFails, []);
});

test("markers on a fact item restrict which claims can satisfy it", () => {
  const knowledge = knowledgeWith({
    facts: [fact({ marker: "inferred", statement: "s", windows: [{ id: "S-1", path: "a.ts", startLine: 1, endLine: 9 }] })]
  });
  const restrictedOut = foundIds(knowledge, { version: "expected-knowledge-v1", target: "t", items: [{ id: "x", kind: "fact", mustFind: true, anchors: [{ path: "a.ts" }], markers: ["fact", "verified"] }] });
  const allowed = foundIds(knowledge, { version: "expected-knowledge-v1", target: "t", items: [{ id: "x", kind: "fact", mustFind: true, anchors: [{ path: "a.ts" }], markers: ["inferred"] }] });
  assert.deepEqual(restrictedOut, []);
  assert.deepEqual(allowed, ["x"]);
});

test("coverage passes when any workitem of the dimension has an expected status; fails on absent dimension", () => {
  const knowledge = knowledgeWith({ coverage: [{ id: "w1", dimension: "authorization", status: "found" }] });
  const expected = validateExpected({
    version: "expected-knowledge-v1",
    target: "t",
    items: [{ id: "noop", kind: "unknown", mustFind: false, anchors: [], patterns: ["never"] }],
    coverage: [
      { dimension: "authorization", expect: ["found"] },
      { dimension: "data-scope", expect: ["searched-not-found"] }
    ]
  });
  const diff = diffKnowledge(knowledge, expected);
  assert.equal(diff.coverageFailures.length, 1);
  assert.equal(diff.coverageFailures[0].dimension, "data-scope");
  assert.deepEqual(diff.coverageFailures[0].actual, ["<absent>"]);
});

// --- integration against the hand-written run-mini artifacts ---

test("diff against run-mini expected-fail reports the full failure surface", () => {
  const knowledge = extractKnowledge(RUN_MINI);
  const expected = validateExpected(readExpected("expected-fail.json"));
  const diff = diffKnowledge(knowledge, expected);

  assert.deepEqual(diff.found.map((entry) => entry.id).sort(), ["approval", "auth-filename", "authz", "rel-approval", "unknown-carryover"]);
  assert.equal(diff.summary.pass, false);
});

test("miss attribution splits authoring-miss (in scope, uncited) from prepare-miss (out of scope)", () => {
  const knowledge = extractKnowledge(RUN_MINI);
  const diff = diffKnowledge(knowledge, validateExpected(readExpected("expected-fail.json")));
  const byId = new Map(diff.missing.map((entry) => [entry.id, entry.attribution]));
  assert.equal(byId.get("authoring-miss"), "authoring-miss");
  assert.equal(byId.get("prepare-miss"), "prepare-miss");
  assert.equal(diff.summary.authoringMiss, 1);
  assert.equal(diff.summary.prepareMiss, 1);
});

test("forbidden flags a fact-marked hallucination but not the inferred-marked twin", () => {
  const knowledge = extractKnowledge(RUN_MINI);
  const diff = diffKnowledge(knowledge, validateExpected(readExpected("expected-fail.json")));
  assert.equal(diff.forbiddenHits.length, 1);
  assert.equal(diff.forbiddenHits[0].id, "no-email");
  assert.equal(diff.forbiddenHits[0].ref, "feature-leave-x-engineering#claim-4");
  assert.equal(diff.forbiddenHits[0].marker, "fact");
  assert.ok(!diff.forbiddenHits.some((hit) => hit.ref.endsWith("claim-3")));
});

test("coverage honesty: expecting searched-not-found passes when the run honestly searched and did not find", () => {
  const knowledge = extractKnowledge(RUN_MINI);
  const diff = diffKnowledge(knowledge, validateExpected(readExpected("expected-fail.json")));
  const failedDimensions = diff.coverageFailures.map((failure) => failure.dimension);
  assert.ok(!failedDimensions.includes("data-scope"));
  assert.ok(!failedDimensions.includes("authorization"));
  assert.deepEqual(failedDimensions, ["notifications-and-exports"]);
});

test("leave-mini forbidden pin: honest negation is exempt, single-facet 'sends email' is caught", () => {
  const expected = loadExpected(LEAVE_MINI_EXPECTED);
  const knowledge = knowledgeWith({
    facts: [
      fact({ ref: "d#honest", marker: "fact", statement: "系统不发送任何邮件/短信/推送通知，审批结果只落库并出现在列表里" }),
      fact({ ref: "d#halluc", marker: "fact", statement: "二级审批通过后系统会向申请人发送电子邮件并抄送经理" })
    ]
  });
  const hits = diffKnowledge(knowledge, expected).forbiddenHits;
  assert.equal(hits.length, 1, `expected exactly one hit, got ${JSON.stringify(hits)}`);
  assert.equal(hits[0].id, "no-notification-send");
  assert.equal(hits[0].ref, "d#halluc");
  assert.ok(!hits.some((hit) => hit.ref === "d#honest"), "the honest negation must not be flagged");
});

test("leave-mini forbidden pin exempts implement/exist negations (real authored claims) but not a positive send", () => {
  const expected = loadExpected(LEAVE_MINI_EXPECTED);
  const knowledge = knowledgeWith({
    facts: [
      // Two real fact-marked claims from an authored run that the pin previously false-flagged.
      fact({ ref: "d#c12", marker: "fact", statement: "邮件、短信与推送通知，README 声明刻意不实现" }),
      fact({ ref: "d#c14", marker: "fact", statement: "README 明确声明本服务刻意不实现任何邮件、短信或推送通知，审批结果只落库并出现在列表接口里" }),
      fact({ ref: "d#provide", marker: "fact", statement: "本服务不提供任何邮件或短信通知功能" }),
      // Positive control: a real hallucination with no negation must STILL be caught.
      fact({ ref: "d#halluc", marker: "fact", statement: "系统会向申请人发送电子邮件通知" })
    ]
  });
  const hits = diffKnowledge(knowledge, expected).forbiddenHits;
  assert.deepEqual(hits.map((hit) => hit.ref), ["d#halluc"], `only the positive send should flag, got ${JSON.stringify(hits)}`);
});

test("anchorInHorizon is path-boundary-safe: src/auth.ts is not satisfied by src/auth.tsx in scope text", () => {
  const expected = validateExpected({
    version: "expected-knowledge-v1",
    target: "t",
    items: [{ id: "x", kind: "fact", mustFind: true, anchors: [{ path: "src/auth.ts" }] }]
  });
  const prefixOnly = knowledgeWith({ prepareHorizon: { files: [], scopeText: "see `svc/src/auth.tsx` for details" } });
  const wholeToken = knowledgeWith({ prepareHorizon: { files: [], scopeText: "see `svc/src/auth.ts` for details" } });
  assert.deepEqual(checkContainment(prefixOnly, expected).missing.map((entry) => entry.id), ["x"]);
  assert.equal(checkContainment(wholeToken, expected).allContained, true);
});

test("validateExpected rejects malformed specs (version, kind, anchors, regex)", () => {
  const base = { version: "expected-knowledge-v1", target: "t", items: [{ id: "x", kind: "fact", mustFind: true, anchors: [{ path: "a.ts" }] }] };
  assert.throws(() => validateExpected({ ...base, version: "v2" }), /version/);
  assert.throws(() => validateExpected({ ...base, items: [{ id: "x", kind: "banana", mustFind: true, anchors: [{ path: "a.ts" }] }] }), /kind/);
  assert.throws(() => validateExpected({ ...base, items: [{ id: "x", kind: "fact", mustFind: true, anchors: [] }] }), /anchor/);
  assert.throws(() => validateExpected({ ...base, items: [{ id: "x", kind: "fact", mustFind: true, anchors: [{ path: "a.ts" }], statementPatterns: ["("] }] }), /not a valid regex/);
  assert.throws(() => validateExpected({ ...base, items: [{ id: "x", kind: "unknown", mustFind: false, anchors: [] }] }), /patterns.*required/);
  assert.throws(() => validateExpected({ ...base, items: [base.items[0], base.items[0]] }), /duplicate item id/);
});

test("run-mini expected-pass is a clean pass", () => {
  const knowledge = extractKnowledge(RUN_MINI);
  const diff = diffKnowledge(knowledge, validateExpected(readExpected("expected-pass.json")));
  assert.equal(diff.summary.pass, true);
  assert.equal(diff.missing.length, 0);
  assert.equal(diff.forbiddenHits.length, 0);
  assert.equal(diff.coverageFailures.length, 0);
});
