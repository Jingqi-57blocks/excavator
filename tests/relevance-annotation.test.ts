import test from "node:test";
import assert from "node:assert/strict";
import { anchorHitFor, anchorVocabulary } from "../src/assurance/relevance-annotation.ts";
import { readObligations } from "../src/assurance/read-obligations.ts";
import type { FeatureFactPack } from "../src/base/types.ts";
import { v2Pack } from "./factpack-v2-fixture.ts";

// This label decides nothing — it groups a reading. The tests below pin that character: the denominator
// never changes, absence of a hit never means "irrelevant", and there is no threshold anywhere to tune.

const ANCHORS = ["请假管理", "leave", "请假", "leaves"];

test("the feature's own name in a symbol is the strongest signal", () => {
  assert.equal(anchorHitFor({ name: "OwnLeavePagination", path: "svc/x/service.go" }, ANCHORS), "name");
  assert.equal(anchorHitFor({ name: "approveLeave", path: "a/b.ts" }, ANCHORS), "name");
});

test("a directory carrying the vocabulary is a weaker signal, and is labelled differently", () => {
  assert.equal(anchorHitFor({ name: "BuildCpntEmail", path: "svc/internal/handlers/leave/notification.go" }, ANCHORS), "path");
  assert.equal(anchorHitFor({ name: "Recipients", path: "svc/internal/handlers/leave/dcrt_recipient.go" }, ANCHORS), "path");
});

// Measured: the top-5 files by unread lines contained three of these, so the funnel would have spent the
// next slice on code that has nothing to do with the feature.
test("a co-located function with no feature vocabulary gets no label", () => {
  assert.equal(anchorHitFor({ name: "OrderSheetMember", path: "svc/internal/handlers/management/utils.go" }, ANCHORS), undefined);
  assert.equal(anchorHitFor({ name: "CreateInterviewPosition", path: "svc/internal/handlers/management/service.go" }, ANCHORS), undefined);
  assert.equal(anchorHitFor({ name: "main", path: "svc/main.go" }, ANCHORS), undefined);
});

// The codebase writes `leave` as `lv`; the abbreviation is derived from the term, not listed by hand,
// because a hand-written synonym table is a knob and a knob can be turned to make numbers look better.
test("a consonant abbreviation of the term counts, and it is derived rather than listed", () => {
  assert.ok(anchorVocabulary(ANCHORS).has("lv"), "the vocabulary derives `lv` from `leave` itself");
  assert.equal(anchorHitFor({ name: "LvHldyTypeC", path: "svc/internal/constant/x.go" }, ANCHORS), "name");
});

test("a CJK anchor matches as a substring, the only honest way to read an undelimited language", () => {
  assert.equal(anchorHitFor({ name: "请假申请校验", path: "a/b.ts" }, ["请假"]), "name");
  assert.equal(anchorHitFor({ name: "工时汇总", path: "a/b.ts" }, ["请假"]), undefined);
});

test("a route carries vocabulary a symbol name may not", () => {
  assert.equal(anchorHitFor({ name: "Creation", path: "svc/handlers/handlers.go", route: "POST /v2/leaves" }, ANCHORS), "name");
  assert.equal(anchorHitFor({ name: "Creation", path: "svc/handlers/handlers.go" }, ANCHORS), undefined, "without the route there is nothing to match");
});

test("only the directory of a path is vocabulary — a bare filename is not", () => {
  assert.equal(anchorHitFor({ name: "x", path: "leave.go" }, ANCHORS), undefined, "a file at the root has no directory to inherit from");
  assert.equal(anchorHitFor({ name: "x", path: "handlers/leave/service.go" }, ANCHORS), "path");
});

// The whole point: this is a label, not a filter.
test("annotating changes no obligation's membership, only adds a label", () => {
  const pack: FeatureFactPack = v2Pack([
      { category: "logic", name: "approveLeave", filePath: "svc/leave/service.go", line: 10, endLine: 40 },
      { category: "logic", name: "OrderSheetMember", filePath: "svc/management/utils.go", line: 10, endLine: 40 },
    ], { snapshotId: "s", featureKey: "k" });
  const plain = readObligations([pack], []);
  const labelled = readObligations([pack], [], null, null, { k: ANCHORS });

  assert.equal(labelled.obligations.length, plain.obligations.length, "no obligation is added or removed");
  assert.equal(labelled.summary.counted, plain.summary.counted);
  assert.deepEqual(labelled.obligations.map((o) => o.id), plain.obligations.map((o) => o.id));
  assert.deepEqual(
    labelled.obligations.map((o) => `${o.name}=${o.anchorHit ?? "none"}`),
    ["approveLeave=name", "OrderSheetMember=none"],
    "the co-located management function carries no label — and is still counted",
  );
  assert.deepEqual(labelled.summary.anchor, { name: 1, path: 0, none: 1 });
});

// Two different things: "annotation was not requested" (byte-identical, which is what keeps frozen runs
// stable) and "annotation ran and matched nothing" (a real, reportable outcome).
test("not requesting annotation is byte-identical; requesting it with nothing to match is not", () => {
  const pack: FeatureFactPack = v2Pack([
    { category: "logic", name: "approveLeave", filePath: "svc/leave/service.go", line: 10, endLine: 40 }
  ], { snapshotId: "s", featureKey: "k" });
  const plain = readObligations([pack], []);
  assert.equal(JSON.stringify(readObligations([pack], [], null, null, null)), JSON.stringify(plain));
  assert.equal(plain.summary.anchor, undefined, "not requested → the block is absent, not empty");
  assert.deepEqual(readObligations([pack], [], null, null, {}).summary.anchor, { name: 0, path: 0, none: 1 },
    "requested but with no terms for this feature → the reading says so rather than staying silent");
});
