import test from "node:test";
import assert from "node:assert/strict";
import { PLAN_BUDGET_TABLE } from "../src/report/plan-budget.ts";
import {
  MATERIALITY_BUCKET_DEFINITIONS,
  PACKET_OVER_BUDGET_MODES,
  PLANNER_PACKET_BYTE_LIMIT,
  PLANNER_PACKET_VERSION,
  plannerPacketDigest,
  renderPlannerPacket
} from "../src/report/planner-packet.ts";
import { REPORT_POLICY_REGISTRY } from "../src/report/report-policy-registry.ts";
import { TOPIC_DISPOSITION_STATES } from "../src/report/topic-disposition.ts";
import { miniRun, type MiniRun } from "./plan-fixture.ts";

// The planner packet is a VIEW, so the view laws apply: it declares its bound, states its size, cites the digests
// of what it projects, and holds no source text. The two failure forms for an overrun are a named refusal at the
// entry and a recorded limitation — never a truncation, which is why the record-limitation packet below is
// compared against the unbounded one line for line.

const SENTINELS = ["SECTIONS", "CLAIMS", "AUTHORING", "REPORTS", "PROMPTS", "HYPOTHESIS", "EVIDENCE"]
  .map((where) => `EXCAVATOR-TOPIC-SENTINEL-${where}`);

let mini: MiniRun | null = null;
async function fixture(): Promise<MiniRun> {
  return (mini ??= await miniRun());
}

async function render(overrides: { byteLimit?: number; overBudget?: "refuse" | "record-limitation" } = {}) {
  const { catalog, requests } = await fixture();
  return renderPlannerPacket({
    catalog,
    requests,
    registry: REPORT_POLICY_REGISTRY,
    budgetTable: PLAN_BUDGET_TABLE,
    byteLimit: overrides.byteLimit ?? PLANNER_PACKET_BYTE_LIMIT,
    overBudget: overrides.overBudget ?? "refuse"
  });
}

test("the packet is deterministic, declares its bound and states its own size", async () => {
  const first = await render();
  const second = await render();
  assert.equal(first.markdown, second.markdown);
  assert.equal(plannerPacketDigest(first), plannerPacketDigest(second));
  assert.equal(first.version, PLANNER_PACKET_VERSION);
  assert.equal(first.byteLimit, PLANNER_PACKET_BYTE_LIMIT);
  assert.equal(first.bytes, Buffer.byteLength(first.markdown, "utf8"));
  assert.deepEqual(first.limitations, []);
  assert.ok(first.bytes < first.byteLimit);
  assert.deepEqual([...PACKET_OVER_BUDGET_MODES], ["record-limitation", "refuse"]);
});

test("the packet cites the exact bytes it projects and the rules a plan is held to", async () => {
  const { catalog } = await fixture();
  const packet = await render();
  assert.ok(packet.markdown.includes(`knowledge epoch: ${catalog.knowledgeEpoch} (digest ${catalog.knowledgeDigest})`));
  assert.ok(packet.markdown.includes("topics catalog digest: "));
  assert.ok(packet.markdown.includes("recorded requests digest: "));
  assert.ok(packet.markdown.includes(`policy registry: ${REPORT_POLICY_REGISTRY.version}`));
  assert.ok(packet.markdown.includes(TOPIC_DISPOSITION_STATES.join(", ")), "the six words a disposition may be");
  assert.ok(packet.markdown.includes("or state its own counts or coverage"), "the packet says the proposal's own counts are ignored");
  // Every request row, with the policy bytes it was resolved against.
  for (const record of (await fixture()).requests.requests) {
    assert.ok(packet.markdown.includes(`### ${record.documentId}`));
    assert.ok(packet.markdown.includes(record.lensPolicy.digest), `${record.documentId} must cite its lens policy digest`);
    assert.ok(packet.markdown.includes(record.intentPolicy.digest));
  }
});

test("the three buckets are rendered with their definitions, and `unobligated` is a missing join, not an unreachable subject", async () => {
  const packet = await render();
  for (const definition of MATERIALITY_BUCKET_DEFINITIONS) {
    assert.ok(packet.markdown.includes(definition), `the bucket definition must be in the packet verbatim: ${definition.slice(0, 40)}`);
  }
  assert.ok(packet.markdown.includes("nobody computes the join between the route ledger and the obligation ledger"));
  assert.ok(packet.markdown.includes("`route-handler` and `recovered-route-handler`"),
    "the obligation ledger's own route-identified kinds are named, so nobody reads `unobligated` as `the ledger cannot see routes`");
  for (const forbidden of ["unreachable subject", "cannot be reached", "out of reach"]) {
    // The one allowed occurrence is the definition's own denial ("a missing join, not an unreachable subject").
    const occurrences = packet.markdown.split(forbidden).length - 1;
    assert.ok(occurrences <= 1, `${forbidden} appears ${occurrences} times; the wording must not claim routes are unreachable`);
  }
});

test("every facet has a census row, and an empty one quotes the ledger's own cause", async () => {
  const { catalog } = await fixture();
  const packet = await render();
  for (const row of catalog.facets) {
    assert.ok(packet.markdown.includes(`| ${row.facet} | ${row.outcome.state} |`), `${row.facet} must have a census row`);
    if (row.outcome.state === "populated") continue;
    assert.ok(packet.markdown.includes(row.outcome.reason), `${row.facet} must quote its own reason`);
  }
  // The `policy: not-run-scoped` wording is the MINI FIXTURE's frozen bytes, not a sentence the producer still
  // emits — since 57B-483 a run records Built, NotApplicable{not-detected} or a named Unavailable. What is
  // asserted here is verbatim propagation: whatever cause the envelope carries reaches the packet unedited.
  assert.ok(packet.markdown.includes("facts/producers/db-schema.json records status unavailable: policy: not-run-scoped"),
    "the entity facet's ledger-absent reason is visible verbatim");
  assert.ok(packet.markdown.includes("ledger-absent"));

  // `ledger-absent` and `ledger-empty` must stay two different sentences. This fixture only has the first, so the
  // second is rendered from a catalog whose entity facet is empty for the other reason, and the two are compared.
  const asEmpty = renderPlannerPacket({
    catalog: {
      ...catalog,
      facets: catalog.facets.map((row) => row.facet === "entity"
        ? { ...row, outcome: { state: "ledger-empty" as const, reason: "facts/producers/db-schema.json was built and holds no fact" } }
        : row)
    },
    requests: (await fixture()).requests,
    registry: REPORT_POLICY_REGISTRY,
    budgetTable: PLAN_BUDGET_TABLE,
    byteLimit: PLANNER_PACKET_BYTE_LIMIT,
    overBudget: "refuse"
  });
  assert.ok(asEmpty.markdown.includes("entity — ledger-empty: facts/producers/db-schema.json was built and holds no fact"));
  assert.ok(packet.markdown.includes("entity — ledger-absent: facts/producers/db-schema.json records status unavailable"));
  assert.notEqual(asEmpty.markdown, packet.markdown, "the two empty reasons are not the same packet");
});

test("every topic gets exactly one row, and no source text, excerpt or evidence id reaches the packet", async () => {
  const { catalog } = await fixture();
  const packet = await render();
  for (const topic of catalog.topics) {
    const occurrences = packet.markdown.split(topic.topicId).length - 1;
    assert.equal(occurrences, 1, `${topic.topicId} appears ${occurrences} times; every topic gets exactly one row`);
  }
  for (const sentinel of SENTINELS) assert.ok(!packet.markdown.includes(sentinel), `${sentinel} reached the packet`);
  const evidenceIds = new Set(catalog.topics.flatMap((topic) => topic.bindings.flatMap((binding) => binding.evidenceIds)));
  assert.equal(evidenceIds.size, 5);
  for (const id of evidenceIds) assert.ok(!packet.markdown.includes(id), `evidence id ${id} reached the packet; the packet carries counts`);
  // The counts are there instead, per topic.
  const material = catalog.topics.find((topic) => topic.materiality === "material" && topic.bindings.length > 0)!;
  const evidence = material.bindings.reduce((total, binding) => total + binding.evidenceIds.length, 0);
  assert.ok(packet.markdown.includes(`evidenceIds=${evidence} traceIds=`));
});

test("over the bound, `refuse` names both byte numbers and nothing is rendered", async () => {
  await assert.rejects(async () => render({ byteLimit: 1_000, overBudget: "refuse" }),
    /The planner packet is \d+ bytes over a declared bound of 1000 \(\d+ bytes over\)\. Refusing at the entry rather than truncating/);
});

test("over the bound, `record-limitation` keeps the whole packet and records the overrun", async () => {
  const unbounded = await render();
  const limited = await render({ byteLimit: 1_000, overBudget: "record-limitation" });
  assert.equal(limited.limitations.length, 1);
  assert.match(limited.limitations[0]!, /^The rendered packet is \d+ bytes, over the declared bound of 1000\. Nothing has been dropped or shortened/);
  assert.ok(limited.markdown.includes("## Recorded limitations"), "the reader of the packet sees the limitation too");
  assert.ok(limited.bytes > limited.byteLimit, "the size is reported honestly, not clamped");

  // Nothing was truncated: the body after the header is identical to the unbounded render's body.
  const body = (markdown: string): string => markdown.slice(markdown.indexOf("## Requests"));
  assert.equal(body(limited.markdown), body(unbounded.markdown));
  const { catalog } = await fixture();
  for (const topic of catalog.topics) assert.ok(limited.markdown.includes(topic.topicId), `${topic.topicId} must survive an over-budget render`);
});
