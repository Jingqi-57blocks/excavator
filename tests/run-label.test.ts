import test from "node:test";
import assert from "node:assert/strict";
import { runScopeSlug } from "../src/run/run-label.ts";
import type { Audience, FeatureRequest, ReportRequest } from "../src/base/types.ts";

function feature(subject: string): FeatureRequest {
  return { subject, aliases: [], audiences: ["product"] };
}

function scope(overviewAudiences: Audience[], subjects: string[]): Pick<ReportRequest, "overviewAudiences" | "features"> {
  return { overviewAudiences, features: subjects.map(feature) };
}

// The character class the run id segment must stay within: letters, numbers, the `+` part joiner,
// underscore, and the `-` slugify uses inside a slug. No path separators, spaces, or dots.
const SAFE = /^[\p{L}\p{N}+_-]+$/u;

test("an overview-only request slugs to \"overview\"", () => {
  assert.equal(runScopeSlug(scope(["product"], [])), "overview");
  assert.equal(runScopeSlug(scope(["product", "engineering"], [])), "overview");
});

test("a single CJK feature subject is preserved by slugify", () => {
  assert.equal(runScopeSlug(scope([], ["请假"])), "请假");
});

test("overview and a feature join with \"+\"", () => {
  assert.equal(runScopeSlug(scope(["product"], ["Leave Management"])), "overview+leave-management");
});

test("a long feature slug is truncated to 16 code points with any dangling hyphen dropped", () => {
  // slugify -> "aaaaaaaaaaaaaaa-bbb"; the 16th code point is the hyphen, which is stripped after the cut.
  assert.equal(runScopeSlug(scope([], ["aaaaaaaaaaaaaaa bbb"])), "aaaaaaaaaaaaaaa");
});

test("too many parts collapse to a first-part-plus-count summary within 48 code points", () => {
  const subjects = ["Leave Management", "payroll-processing", "notification-center", "audit-log", "请假管理"];
  const slug = runScopeSlug(scope([], subjects));
  assert.equal(slug, "leave-management+4more");
  assert.ok([...slug].length <= 48);
  // With an overview requested it becomes the first part and the feature count folds into the tail.
  assert.equal(runScopeSlug(scope(["product"], subjects)), "overview+5more");
});

test("duplicate feature subjects are collapsed in request order", () => {
  assert.equal(runScopeSlug(scope(["product"], ["Leave Management", "leave management", "LEAVE-MANAGEMENT"])), "overview+leave-management");
});

test("an empty scope falls back to \"docs\"", () => {
  assert.equal(runScopeSlug(scope([], [])), "docs");
});

test("every produced slug is filesystem-safe", () => {
  const cases: Array<Pick<ReportRequest, "overviewAudiences" | "features">> = [
    scope(["product"], []),
    scope([], ["请假管理"]),
    scope(["product"], ["Leave Management"]),
    scope([], ["Leave Management", "payroll-processing", "notification-center", "audit-log", "请假管理"]),
    scope([], ["aaaaaaaaaaaaaaa bbb"]),
    scope([], [])
  ];
  for (const request of cases) {
    const slug = runScopeSlug(request);
    assert.match(slug, SAFE, `unsafe slug: ${slug}`);
  }
});
