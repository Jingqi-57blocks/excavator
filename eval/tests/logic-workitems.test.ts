import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadFactpackFixture, fixtureLogicItems } from "../factpack-fixture.ts";
import { logicWorkItems, LOGIC_WORKITEM_CAP, LOGIC_WORKITEM_DIMENSION } from "../../src/logic-workitems.ts";
import { stableJson } from "../../src/util.ts";
import type { DocumentPlan, FeatureFactPack } from "../../src/types.ts";

// The 57B-375 forcing function, derived from the SAME frozen wcp-leave fact-pack fixture the 57B-372 replay
// uses: `logicWorkItems` promotes every rescued (signal-carrying) logic function into a disposable work item.
// This asserts what the shipped pure function produces over real facts — byte-stable, the three known target
// functions present, the id format (including the dual-location symbol), and the cap-24 truncation + warning.

const LEAVE_FX = join(import.meta.dirname, "..", "fixtures", "wcp-leave", "factpack-fg.json.gz");
const NUL = String.fromCharCode(0);

function leavePack(): FeatureFactPack {
  const fx = loadFactpackFixture(LEAVE_FX);
  // The fixture's logic complement carries the rescued items with their signals and ranks — exactly the
  // production derivation. logicWorkItems only reads category `logic` items with a signal, so this pack is
  // a faithful stand-in for the run's on-disk fact pack.
  return { version: "factpack-v1", snapshotId: "snap", featureKey: fx.featureKey, items: fixtureLogicItems(fx), coverage: [], warnings: [] };
}

function docs(featureKey: string): DocumentPlan[] {
  const make = (audience: "product" | "engineering"): DocumentPlan => ({
    id: `feature-${featureKey}-${audience}`,
    kind: "feature",
    audience,
    templatePath: "/t",
    contextPath: "/c",
    sections: []
  });
  return [make("product"), make("engineering")];
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

test("logicWorkItems promotes exactly the 19 rescued leave logic functions, all material logic-disposition items", () => {
  const pack = leavePack();
  const { items, warnings } = logicWorkItems([pack], docs(pack.featureKey));
  assert.equal(items.length, 19, "leave has 19 rescued (tier-0 signal) logic functions");
  assert.ok(items.length <= LOGIC_WORKITEM_CAP, "the promoted set stays within the cap");
  assert.deepEqual(warnings, [], "19 <= 24, so no truncation warning");
  for (const item of items) {
    assert.equal(item.dimension, LOGIC_WORKITEM_DIMENSION);
    assert.equal(item.material, true);
    assert.equal(item.status, "pending");
    assert.equal(item.origin, "default");
    assert.equal(item.reportSection, undefined, "a behavioral rule is not pinned to a section");
    assert.deepEqual(item.requiredFor, [`feature-${pack.featureKey}-product`, `feature-${pack.featureKey}-engineering`]);
    assert.equal(item.scope, `feature:${pack.featureKey}`);
    assert.deepEqual(item.evidenceIds, []);
    assert.deepEqual(item.traceIds, []);
  }
});

test("the three target decision functions are each promoted, with framework-neutral hypotheses", () => {
  const pack = leavePack();
  const { items } = logicWorkItems([pack], docs(pack.featureKey));
  for (const target of ["isIgnoreHolidayLvType", "CalculationAuto", "syncLvCompleted"]) {
    const hit = items.find((item) => item.id.includes(`:logic:${target}@`));
    assert.ok(hit, `${target} must be promoted to a logic-disposition work item`);
    assert.ok(hit.hypothesis.includes(target), `${target} hypothesis names the symbol`);
    assert.match(hit.hypothesis, /rescued into the feature boundary by structural analysis/);
  }
});

test("the id encodes filePath + line, so a same-named symbol at two locations yields two distinct items", () => {
  const pack = leavePack();
  const { items } = logicWorkItems([pack], docs(pack.featureKey));
  const preview = items.filter((item) => item.id.includes(":logic:PreviewLastWorkingDayPTO@"));
  assert.equal(preview.length, 2, "PreviewLastWorkingDayPTO is rescued at two locations");
  const ids = new Set(preview.map((item) => item.id));
  assert.equal(ids.size, 2, "the two locations produce two distinct ids");
  assert.ok([...ids].every((id) => id.includes("wcp-service-v2/internal/handlers/employee/service.go:")), "each id carries the full file:line");
  const format = new RegExp(`^feature:${escapeRegExp(pack.featureKey)}:logic:[^@]+@.+:\\d+$`);
  for (const item of items) {
    assert.match(item.id, format);
    assert.ok(!item.id.includes(NUL), "no literal NUL byte in the id");
  }
});

test("logicWorkItems is byte-stable and rank-ordered", () => {
  const pack = leavePack();
  const first = logicWorkItems([pack], docs(pack.featureKey));
  const second = logicWorkItems([pack], docs(pack.featureKey));
  assert.equal(stableJson(first), stableJson(second), "same inputs produce byte-identical output");
  assert.ok(first.items[0].id.includes(":logic:LvHldyTypeC@"), "the lowest-rank rescued item is first");
});

test("the cap truncates the lowest-ranked rescued items and warns once per feature", () => {
  const pack = leavePack();
  const { items, warnings } = logicWorkItems([pack], docs(pack.featureKey), { cap: 5 });
  assert.equal(items.length, 5, "only the 5 highest-ranked rescued functions survive a cap of 5");
  assert.equal(warnings.length, 1, "one truncation warning for the feature");
  assert.match(warnings[0], new RegExp(escapeRegExp(pack.featureKey)));
  assert.match(warnings[0], /19 rescued logic functions/);
  assert.match(warnings[0], /14 lower-ranked/);
  const uncapped = logicWorkItems([pack], docs(pack.featureKey)).items.slice(0, 5).map((item) => item.id);
  assert.deepEqual(items.map((item) => item.id), uncapped);
});

test("an overview-only document set derives nothing (no feature document consumes the pack)", () => {
  const pack = leavePack();
  const overview: DocumentPlan[] = [{ id: "overview-product", kind: "overview", audience: "product", templatePath: "/t", contextPath: "/c", sections: [] }];
  assert.deepEqual(logicWorkItems([pack], overview), { items: [], warnings: [] });
});
