import test from "node:test";
import assert from "node:assert/strict";
import { promoteColocated } from "../src/investigation/colocated-promotion.ts";
import { v2Item } from "./factpack-v2-fixture.ts";

function colocated() {
  return v2Item({
    category: "logic",
    name: "Candidate",
    filePath: "src/candidate.ts",
    line: 7,
    membership: { joined: { factId: "link-1", kind: "http-link", membership: { kind: "relation", endpoints: ["cell-b", "cell-a"] } } },
    relation: { kind: "co-located", basis: "membership-not-seated" }
  });
}

test("L7 accepts a co-located row only through an independently covered membership cell", () => {
  const item = colocated();
  const before = JSON.stringify(item);
  const result = promoteColocated({
    item,
    readSpecs: [
      { readSpecId: "READ-z", coveredUnitIds: ["cell-z"] },
      { readSpecId: "READ-a", coveredUnitIds: ["cell-b", "cell-a"] }
    ],
    judge: "investigator-v1",
    evidenceId: "SOURCE-1"
  });
  assert.deepEqual(result, {
    status: "accepted",
    judgement: {
      item: { category: "logic", name: "Candidate", filePath: "src/candidate.ts", line: 7 },
      readSpecId: "READ-a",
      coveredUnitId: "cell-a",
      judge: "investigator-v1",
      evidenceId: "SOURCE-1"
    }
  });
  assert.equal(JSON.stringify(item), before, "promotion returns a judgement and never mutates the v2 pack");
});

test("L7 rejects rows without an independent read, membership, or co-located relation", () => {
  const base = { judge: "judge", evidenceId: "SOURCE-1" };
  assert.deepEqual(promoteColocated({ ...base, item: colocated(), readSpecs: [] }), { status: "rejected", reason: "no-independent-read-spec" });
  assert.deepEqual(promoteColocated({
    ...base,
    item: v2Item({ category: "logic", name: "scan", membership: { unjoined: { reason: "scan-only" } }, relation: { kind: "co-located", basis: "scan-only" } }),
    readSpecs: [{ readSpecId: "READ-a", coveredUnitIds: ["cell-a"] }]
  }), { status: "rejected", reason: "item-has-no-membership" });
  assert.deepEqual(promoteColocated({ ...base, item: v2Item({ category: "logic", name: "retained" }), readSpecs: [{ readSpecId: "READ-a", coveredUnitIds: ["fixture-cell"] }] }), { status: "rejected", reason: "item-not-co-located" });
});

test("an accepted L7 judgement must name its judge, evidence and ReadSpec", () => {
  const item = colocated();
  assert.throws(() => promoteColocated({ item, readSpecs: [], judge: "", evidenceId: "SOURCE-1" }), /named judge/);
  assert.throws(() => promoteColocated({ item, readSpecs: [], judge: "judge", evidenceId: "" }), /evidence id/);
  assert.throws(() => promoteColocated({ item, readSpecs: [{ readSpecId: "", coveredUnitIds: ["cell-a"] }], judge: "judge", evidenceId: "SOURCE-1" }), /requires an id/);
});
