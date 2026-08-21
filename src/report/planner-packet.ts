/**
 * The planner packet: the bounded, deterministic, model-facing view a planner is allowed to plan from.
 *
 * IT IS A VIEW, SO THE FOUR-LEVEL UPPER BOUND APPLIES. The packet declares its byte bound, states its own size,
 * and cites the digests of everything it projects (the topics catalog, the recorded requests, the policy
 * registry) so a proposal can be checked against the exact bytes it was made from. It contains NO SOURCE TEXT and
 * no evidence excerpt: an obligation appears as a count, never as prose, so the packet cannot become a second
 * unversioned copy of the code.
 *
 * OVER-BUDGET HAS EXACTLY TWO FAILURE FORMS, AND NEITHER IS TRUNCATION. `refuse` throws at the entry with the two
 * byte numbers in the message; `record-limitation` returns the WHOLE packet with the overrun recorded as a
 * limitation, both in `limitations` and in the packet's own header where the reader sees it. Nothing is dropped,
 * no list is capped, no row is shortened — 57B-451 is what the third option costs (a budget that ran out left 43
 * of 83 archived runs permanently unfreezable), and the rule that came out of it is that a budget failure is
 * either named at the entry or recorded as a limitation, never silent and never terminal. The mode is a REQUIRED
 * argument: a default would be the remembered flag this codebase keeps paying for.
 *
 * THE THREE BUCKETS ARE RENDERED WITH THEIR DEFINITIONS, EVERY TIME. `unobligated` means "no obligation in this
 * run's ledger binds to this topic" — it does NOT mean the subject is unreachable, out of scope or uninteresting.
 * The route facet is the measured reason this is spelled out: 1,434 route topics on the wcp baseline are
 * unobligated, and the obligation ledger there DOES carry route-identified rows (the `route-handler` and
 * `recovered-route-handler` kinds name a method and a path). So the honest sentence is "nobody computes the join
 * between the route ledger and the obligation ledger", not "the ledger cannot reach routes" — a reader who takes
 * the second reading concludes the routes are unreachable and stops looking.
 */

import { assertNever } from "../base/artifact-result.ts";
import { canonicalJson, sha256 } from "../base/util.ts";
import { planBudgetFor, type PlanBudgetTable } from "./plan-budget.ts";
import { intentPolicyFor, lensPolicyFor, type ReportPolicyRegistry } from "./report-policy-registry.ts";
import type { ReportRequestsArtifact } from "./report-requests-artifact.ts";
import { TOPIC_DISPOSITION_STATES } from "./topic-disposition.ts";
import { TOPIC_FACETS, type TopicCandidate } from "./topic-candidate.ts";
import type { FacetOutcome, TopicCatalogArtifact } from "./topic-catalog.ts";
import { topicCatalogDigest } from "./topics-artifact.ts";
import { reportRequestsDigest } from "./plan-artifacts.ts";

export const PLANNER_PACKET_VERSION = "planner-packet-v1";

/**
 * The declared byte bound. Measured, not guessed: the wcp R0 baseline's catalog (1,570 topics, the largest of the
 * two baselines by a factor of a hundred) renders to just over 200 KB here, so 512 KiB is the bound with the
 * headroom a bigger corpus needs — and it is a bound the renderer checks rather than a hope.
 */
export const PLANNER_PACKET_BYTE_LIMIT = 524_288;

/** What to do when the rendered packet is over its bound. Required at every call site; there is no default. */
export const PACKET_OVER_BUDGET_MODES = ["record-limitation", "refuse"] as const;
export type PacketOverBudgetMode = (typeof PACKET_OVER_BUDGET_MODES)[number];

export interface PlannerPacketInput {
  readonly catalog: TopicCatalogArtifact;
  readonly requests: ReportRequestsArtifact;
  readonly registry: ReportPolicyRegistry;
  readonly budgetTable: PlanBudgetTable;
  readonly byteLimit: number;
  readonly overBudget: PacketOverBudgetMode;
}

export interface PlannerPacket {
  readonly version: typeof PLANNER_PACKET_VERSION;
  readonly bytes: number;
  readonly byteLimit: number;
  /** Empty unless something was recorded as a limitation. Never a reason a row is missing. */
  readonly limitations: readonly string[];
  readonly markdown: string;
}

/** The three-bucket definitions, verbatim, as the packet prints them. Asserted in test, so the wording is fixed. */
export const MATERIALITY_BUCKET_DEFINITIONS: readonly string[] = [
  "`material` — at least one obligation bound to this topic is material: the report owes the reader an account of it.",
  "`obligated-non-material` — obligations bind to this topic and none of them is material.",
  "`unobligated` — NO obligation in this run's ledger binds to this topic. It does not mean the subject is out of scope, and it does not mean nothing needs explaining: it is a reading of how far the obligation ledger reaches. For the route facet it means nobody computes the join between the route ledger and the obligation ledger — the obligation ledger does carry route-identified rows (the `route-handler` and `recovered-route-handler` kinds name a method and a path), so a route topic being unobligated is a missing join, not an unreachable subject."
];

/** Render the packet. Deterministic: same catalog, same requests, same registry, same bytes. */
export function renderPlannerPacket(input: PlannerPacketInput): PlannerPacket {
  const body = renderBody(input);
  const withoutLimitation = `${renderHeader(input, body, [])}\n${body}`;
  const bytes = Buffer.byteLength(withoutLimitation, "utf8");
  if (bytes <= input.byteLimit) {
    return { version: PLANNER_PACKET_VERSION, bytes, byteLimit: input.byteLimit, limitations: [], markdown: withoutLimitation };
  }
  const overrun = `The rendered packet is ${bytes} bytes, over the declared bound of ${input.byteLimit}. Nothing has been dropped or shortened: every topic, facet and request below is present. Narrow the request's scope or raise the bound deliberately.`;
  switch (input.overBudget) {
    case "refuse":
      throw new Error(`The planner packet is ${bytes} bytes over a declared bound of ${input.byteLimit} (${bytes - input.byteLimit} bytes over). Refusing at the entry rather than truncating: narrow the request's scope or raise the bound.`);
    case "record-limitation": {
      const markdown = `${renderHeader(input, body, [overrun])}\n${body}`;
      return {
        version: PLANNER_PACKET_VERSION,
        bytes: Buffer.byteLength(markdown, "utf8"),
        byteLimit: input.byteLimit,
        limitations: [overrun],
        markdown
      };
    }
  }
  return assertNever(input.overBudget, "planner packet over-budget mode");
}

function renderHeader(input: PlannerPacketInput, body: string, limitations: readonly string[]): string {
  const { catalog, requests, registry } = input;
  const lines = [
    `# Planner packet (${PLANNER_PACKET_VERSION})`,
    "",
    "This is a VIEW of artifacts already on disk. Every id below is addressable in `plan/topics.json`; nothing here",
    "is a fact this packet invented, and nothing here is source text. Obligation bindings stay in the topics",
    "catalog at obligation granularity — this packet carries their COUNTS, and a plan references topics by id.",
    "",
    `- run: ${catalog.runId}`,
    `- knowledge epoch: ${catalog.knowledgeEpoch} (digest ${catalog.knowledgeDigest})`,
    `- topics catalog digest: ${topicCatalogDigest(catalog)}`,
    `- recorded requests digest: ${reportRequestsDigest(requests)}`,
    `- policy registry: ${registry.version}`,
    `- byte bound: ${input.byteLimit}; body bytes: ${Buffer.byteLength(body, "utf8")}`,
    "",
    "## What a plan may and may not say",
    "",
    "A plan groups topics into authoring units, orders them, and assigns each MATERIAL topic exactly one of these",
    `dispositions: ${TOPIC_DISPOSITION_STATES.join(", ")}. It may not invent a topic id, move a materiality, a`,
    "confidence or a completeness reading, omit a material topic without a disposition, render an unknown as",
    "not-applicable, or state its own counts or coverage — every denominator is computed from the catalog, and any",
    "count a proposal carries is ignored.",
    "",
    "Unit kinds: `leaf` writes from the topics it names; `synthesis` writes from its child units' summaries and",
    "names no topic at all; `bridge` explains a relation between two or more topics; `appendix` is the",
    "deterministic tail (coverage, unknowns, glossary) and is the one kind that may name no topic."
  ];
  if (limitations.length > 0) {
    lines.push("", "## Recorded limitations", "");
    for (const limitation of limitations) lines.push(`- ${limitation}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderBody(input: PlannerPacketInput): string {
  return [renderRequests(input), renderCensus(input.catalog), renderTopics(input.catalog)].join("\n");
}

function renderRequests(input: PlannerPacketInput): string {
  const budget = planBudgetFor(input.requests, input.budgetTable);
  const budgetByDocument = new Map(budget.documents.map((row) => [row.documentId, row]));
  const lines = ["## Requests", ""];
  for (const record of input.requests.requests) {
    const lens = lensPolicyFor(record.request.audience, input.registry);
    const intent = intentPolicyFor(record.request.intent, input.registry);
    const row = budgetByDocument.get(record.documentId)!;
    lines.push(
      `### ${record.documentId}`,
      "",
      `- scope: ${record.request.scope}${record.request.scopeIds.length ? ` (${record.request.scopeIds.join(", ")})` : ""}`,
      `- audience: ${record.request.audience} — lens ${lens.id}@${lens.version} (digest ${lens.digest})`,
      `- intent: ${record.request.intent} — intent policy ${intent.id}@${intent.version} (digest ${intent.digest})`,
      `- detail budget: ${record.request.detailBudget}; per-unit input ${row.perUnitInputBytes} bytes, document total ${row.totalInputBytes} bytes`,
      `- language: ${record.request.language}`,
      `- reader concerns: ${lens.content.concerns.join("; ")}`,
      `- terminology depth: ${lens.content.terminologyDepth}; identifiers: ${lens.content.identifiers}`,
      `- document task: ${intent.content.task}`,
      `- reading mode: ${intent.content.reading}; acceptance checklist: ${intent.content.acceptanceChecklist}`,
      ""
    );
  }
  return lines.join("\n");
}

/**
 * The facet census, with the bucket definitions above it and every facet's own row below it — populated or
 * named-empty, with the ledger's own reason. A facet that is empty because its producer was unavailable and a
 * facet that is empty because its ledger holds no row are two different sentences here, on purpose.
 */
function renderCensus(catalog: TopicCatalogArtifact): string {
  const lines = ["## Facet census", "", "The three materiality buckets, defined:", ""];
  for (const definition of MATERIALITY_BUCKET_DEFINITIONS) lines.push(`- ${definition}`);
  lines.push("", "| facet | state | topics | material | obligated-non-material | unobligated |", "| --- | --- | --- | --- | --- | --- |");
  for (const facet of TOPIC_FACETS) {
    const row = catalog.facets.find((entry) => entry.facet === facet)!;
    lines.push(`| ${facet} | ${row.outcome.state} | ${outcomeTopics(row.outcome)} | ${row.materiality.material} | ${row.materiality.obligatedNonMaterial} | ${row.materiality.unobligated} |`);
  }
  lines.push("", "Every facet with no topic says which ledger was not there:", "");
  const empty = catalog.facets.filter((row) => row.outcome.state !== "populated");
  if (empty.length === 0) lines.push("- (every facet is populated)");
  for (const row of empty) lines.push(`- ${row.facet} — ${row.outcome.state}: ${outcomeReason(row.outcome)}`);
  lines.push(
    "",
    `Obligation ledger: ${catalog.obligationAccounting.total} work item(s), ${catalog.obligationAccounting.assigned} bound by a topic, ${catalog.obligationAccounting.unassigned} bound by none.`,
    `Producer facts: ${catalog.factRouting.mapped} became topics; ${catalog.factRouting.unmapped.reduce((total, row) => total + row.facts, 0)} did not (${catalog.factRouting.unmapped.map((row) => `${row.producer}/${row.kind}=${row.facts}`).join(", ") || "none"}).`,
    ""
  );
  return lines.join("\n");
}

/** Exhaustive over the facet outcome states — a new state has to be given a column here before this compiles. */
function outcomeTopics(outcome: FacetOutcome): string {
  switch (outcome.state) {
    case "populated":
      return String(outcome.topics);
    case "ledger-absent":
    case "ledger-empty":
      return "0";
  }
  return assertNever(outcome, "topic facet outcome");
}

function outcomeReason(outcome: FacetOutcome): string {
  switch (outcome.state) {
    case "populated":
      return `holds ${outcome.topics} topic(s)`;
    case "ledger-absent":
    case "ledger-empty":
      return outcome.reason;
  }
  return assertNever(outcome, "topic facet outcome");
}

/**
 * Every topic, one row, grouped by facet — the material ones first inside each facet, because those are the rows
 * that owe a disposition. No row is omitted and no list is capped: the packet's bound is checked against the
 * whole thing, and an overrun is refused or recorded rather than paid for by dropping a topic.
 */
function renderTopics(catalog: TopicCatalogArtifact): string {
  const lines = [
    "## Topics",
    "",
    "One row per topic: `topicId | kind | materiality/confidence | obligations (total, material) | evidence, trace",
    "id counts | digest | title`. `unknown=yes` marks a topic something about which is undetermined — a plan may",
    "never render one as not-applicable. Evidence and trace ids themselves stay in `plan/topics.json`, attached to",
    "the individual obligation they ground.",
    ""
  ];
  for (const facet of TOPIC_FACETS) {
    const topics = catalog.topics.filter((topic) => topic.facet === facet);
    lines.push(`### ${facet} (${topics.length} topic(s))`, "");
    if (topics.length === 0) {
      const row = catalog.facets.find((entry) => entry.facet === facet)!;
      lines.push(`- (no topic) ${row.outcome.state}: ${outcomeReason(row.outcome)}`, "");
      continue;
    }
    const ordered = [...topics].sort((a, b) => rank(a) - rank(b) || a.topicId.localeCompare(b.topicId));
    for (const topic of ordered) lines.push(`- ${topicRow(topic)}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Material topics first: they are the ones that owe a disposition, so they are the ones read first. */
function rank(topic: TopicCandidate): number {
  switch (topic.materiality) {
    case "material":
      return 0;
    case "obligated-non-material":
      return 1;
    case "unobligated":
      return 2;
  }
  return assertNever(topic.materiality, "topic materiality");
}

function topicRow(topic: TopicCandidate): string {
  const material = topic.bindings.filter((binding) => binding.material).length;
  const evidence = topic.bindings.reduce((total, binding) => total + binding.evidenceIds.length, 0);
  const traces = topic.bindings.reduce((total, binding) => total + binding.traceIds.length, 0);
  return [
    topic.topicId,
    topic.kind,
    `${topic.materiality}/${topic.confidence}`,
    `obligations=${topic.bindings.length} material=${material}`,
    `evidenceIds=${evidence} traceIds=${traces}`,
    `residualRows=${topic.completeness.residualRows} uncoveredLines=${topic.completeness.uncoveredLines}`,
    topic.unknown ? "unknown=yes" : "unknown=no",
    `digest=${topic.digest.slice(0, 16)}`,
    topic.title
  ].join(" | ");
}

/** The packet's own content identity, for a caller that records which bytes a proposal was made from. */
export function plannerPacketDigest(packet: PlannerPacket): string {
  return sha256(canonicalJson({ version: packet.version, byteLimit: packet.byteLimit, limitations: packet.limitations, markdown: packet.markdown }));
}
