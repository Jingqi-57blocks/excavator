import test from "node:test";
import assert from "node:assert/strict";
import { auditConditionCoverage, inventoryConditions } from "../src/investigation/condition-inventory.ts";
import { buildAuthoringPacket } from "../src/report/authoring-packet.ts";
import type { DocumentPlan, EvidenceItem, InvestigationPlan, TraceCatalog } from "../src/base/types.ts";

// THE ONE FILTER THAT EXISTS BECAUSE OF A MEASURED HARM, not measured noise.
//
// When the condition inventory moved into the authoring packet, the author — told to state every condition
// carrying reportable behaviour — wrote sentences like "whether the action value at submit is `next` decides
// jumping to the next form" purely to drive the residual from 18 to 1. Reading the source settles it:
// `action === 'next'` picks `goNext()` over `refresh()` after an approval; `info.type === 'change'` resets a
// table to page 1. Framework protocol, not leave behaviour.
//
// Marking, never dropping: an excluded site stays in the inventory where it can be challenged. What changes
// is that it is not owed and not put in front of the author.

const PATH = "wcp-ui/src/pages/leave/components/LeaveApprovalActions.tsx";

function window(id: string, path: string, startLine: number, lines: string[]): EvidenceItem {
  return { id, snapshotId: "s", kind: "source", title: id, path, startLine, endLine: startLine + lines.length - 1, content: lines.join("\n"), reason: "r", digest: "d" };
}

const UI_PROTOCOL = window("S-ui", PATH, 50, [
  `      if (action === 'next') {`,
  `        goNext(res);`,
  `      }`,
]);

const DOMAIN_RULE = window("S-domain", "wcp-ui/src/pages/leave/ApplyLeave.tsx", 100, [
  `  if (leaveType === 'bto') {`,
  `    return checkBtoWindow();`,
  `  }`,
]);

test("a UI event-protocol value is excluded, and stays listed while it is", () => {
  const inventory = inventoryConditions([UI_PROTOCOL], []);
  const site = inventory.items.find((item) => item.literal === "next");
  assert.ok(site, "the site is still in the inventory — a filter nobody can see is a filter nobody can challenge");
  assert.equal(site.excluded, "ui-event-protocol");
  assert.equal(inventory.summary.excluded, 1);
  assert.equal(inventory.summary.unaccounted, 0, "listed but never owed");
});

// The exactness that protects the rules: these end in `leaveType` and `name`, not `type`.
test("a domain rule in the same kind of file is untouched", () => {
  const inventory = inventoryConditions([DOMAIN_RULE], []);
  const site = inventory.items.find((item) => item.literal === "bto");
  assert.ok(site);
  assert.equal(site.excluded, undefined, "`leaveType` is not `type`");
  assert.equal(inventory.summary.unaccounted, 1, "and it is still owed");
});

test("the same comparison outside a UI component file is not protocol", () => {
  const backend = window("S-go", "wcp-service-v2/internal/handlers/leave/service.go", 10, [
    `\tif action == "next" {`,
  ]);
  const inventory = inventoryConditions([backend], []);
  const site = inventory.items.find((item) => item.literal === "next");
  assert.ok(site, "a backend comparison on the same words is a candidate rule, not a callback protocol");
  assert.equal(site.excluded, undefined);
});

function documentPlan(): DocumentPlan {
  return {
    id: "feature-k-engineering", kind: "feature", audience: "engineering", subject: "Leave",
    templatePath: "/tmp/t.md", contextPath: "/tmp/c.md",
    sections: [{ index: 3, title: "Rules", file: "/tmp/3.md", claimsFile: "/tmp/3.claims.json", complete: false }],
  } as DocumentPlan;
}

const TRACES = { version: 1, traces: [] } as unknown as TraceCatalog;

// The packet renders conditions through TWO paths — inside a section block, and once at the end for windows
// no work item cites. Both must skip an excluded site, and an earlier version of this test only exercised
// the second: a mutation that removed the section-block guard stayed green.
test("an excluded site never reaches the author's packet, by either rendering path", () => {
  const inventory = inventoryConditions([UI_PROTOCOL, DOMAIN_RULE], []);

  const unassigned = buildAuthoringPacket(documentPlan(), { version: 1, runId: "r", items: [] } as unknown as InvestigationPlan, new Map(), TRACES, {}, inventory);
  assert.doesNotMatch(unassigned, /action.*next/, "unassigned path: the sentence-for-a-counter is never asked for");
  assert.match(unassigned, /leaveType/, "while the domain rule still is");

  // Now with work items citing both windows, so the conditions render inside the section block instead.
  const cited = {
    version: 1, runId: "r",
    items: [{
      id: "feature:k:decision-flow", dimension: "decision-flow", scope: "feature:k", hypothesis: "h",
      status: "found", material: true, requiredFor: ["feature-k-engineering"],
      evidenceIds: [UI_PROTOCOL.id, DOMAIN_RULE.id], traceIds: [], reportSection: 3, origin: "default",
    }],
  } as unknown as InvestigationPlan;
  const evidence = new Map([[UI_PROTOCOL.id, UI_PROTOCOL], [DOMAIN_RULE.id, DOMAIN_RULE]]);
  const inSection = buildAuthoringPacket(documentPlan(), cited, evidence, TRACES, {}, inventory);

  assert.match(inSection, /### Literal conditions inside these windows/, "the section-block path is the one being exercised");
  assert.match(inSection, /leaveType/, "the domain rule is listed there");
  assert.doesNotMatch(inSection, /`action === "next"`/, "and the protocol value is not");
});

// Review's counterexamples: the field name alone cannot tell a callback from a domain state, so the VALUE
// must be a protocol word too. Without that fourth condition all four of these were wrongly excluded.
test("a domain state compared on a protocol-shaped field is still owed", () => {
  for (const [expression, literal] of [
    [`if (user.type === 'admin') {`, "admin"],
    [`if (notification.type === 'leave_request') {`, "leave_request"],
    [`if (item?.leave?.status === 'pending') {`, "pending"],
    [`if (leave.status === 'approved') {`, "approved"],
  ]) {
    const inventory = inventoryConditions([window("S-x", PATH, 10, [expression])], []);
    const site = inventory.items.find((item) => item.literal === literal);
    assert.ok(site, expression);
    assert.equal(site.excluded, undefined, `${expression} is a domain rule, not a callback protocol`);
  }
});

test("the protocol values measured on real runs are still excluded", () => {
  for (const [expression, literal] of [
    [`if (action === 'next') {`, "next"],
    [`if (info.type === 'change') {`, "change"],
    [`if (file.status === 'error') {`, "error"],
  ]) {
    const inventory = inventoryConditions([window("S-x", PATH, 10, [expression])], []);
    assert.equal(inventory.items.find((item) => item.literal === literal)?.excluded, "ui-event-protocol", expression);
  }
});

// A mark nobody can reach is a drop with extra steps. When the residual reaches zero the audit's only
// pointer to this artifact would vanish with it, taking the exclusions' visibility along.
test("the exclusions are reported even when nothing is owed", () => {
  const inventory = inventoryConditions([UI_PROTOCOL], []);
  assert.equal(inventory.summary.unaccounted, 0, "nothing owed — the state where visibility is at risk");
  const findings = auditConditionCoverage(inventory);
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /1 comparison\(s\) were classified as UI event-protocol/);
  assert.match(findings[0].message, /can be checked and disputed/);
});

test("an excluded site is never named in the audit residual", () => {
  const inventory = inventoryConditions([UI_PROTOCOL, DOMAIN_RULE], []);
  const findings = auditConditionCoverage(inventory);
  const residual = findings.filter((finding) => /condition residual/.test(finding.message));
  const text = residual.map((finding) => finding.message).join("\n");
  assert.doesNotMatch(text, /next/);
  assert.match(text, /bto/, "the residual still reports what is genuinely unstated");
});

// A family is "which values this field accepts". Protocol values are not the product's vocabulary, so
// letting them form a family would put a framework's enum in front of the author as a domain question.
test("excluded sites form no enum family", () => {
  const second = window("S-ui2", PATH, 70, [`      if (action === 'prev') {`]);
  const inventory = inventoryConditions([UI_PROTOCOL, second], []);
  assert.deepEqual(inventory.families, [], "two protocol values are not an enum family");
  assert.equal(inventory.summary.excluded, 2);
});
