import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ARTIFACT_REGISTRY } from "../src/base/artifact-registry.ts";
import {
  CORPUS_MEMBERSHIP, FACT_KIND_IDS, FACT_KIND_REGISTRY, FACT_KIND_REGISTRY_VERSION, MEMBERSHIP_KINDS,
  evaluateSeat, factKindById, factKindRegistryDigest, membershipViolations, moduleMembership,
  relationMembership, spanSetMembership, unitMembership, validateFactKindRegistry,
  type FactKindEntry, type FactKindRegistry, type Membership
} from "../src/base/fact-kind-registry.ts";

/**
 * Membership is a closed union with no legal empty set, and `evaluateSeat` is the only judge.
 *
 * The failure this file exists to make impossible is P17 at another granularity: a two-ended fact filed under one
 * of its ends is read as `co-located` and dropped when only the other end was seated. So there is a fixture per
 * union arm, a fixture for the dangling id that would otherwise vanish silently, and a grep-level check that no
 * second seat judgement exists anywhere in `src/`.
 */

const NO_MODULES = (): string | null => null;

test("the production registry loads, and every declared kind id has an entry", () => {
  validateFactKindRegistry(FACT_KIND_REGISTRY);
  assert.equal(FACT_KIND_REGISTRY.version, FACT_KIND_REGISTRY_VERSION);
  assert.deepEqual(FACT_KIND_REGISTRY.kinds.map((kind) => kind.id).sort(), [...FACT_KIND_IDS].sort());
  const producers = new Set(ARTIFACT_REGISTRY.producers.map((producer) => producer.id));
  for (const kind of FACT_KIND_REGISTRY.kinds) {
    assert.ok(kind.title.trim(), `${kind.id} states what it is`);
    assert.ok(producers.has(kind.producer), `${kind.id} names a producer with an envelope slot`);
    assert.ok(MEMBERSHIP_KINDS.includes(kind.membershipKind), `${kind.id} declares a registered membership kind`);
    assert.equal(typeof kind.structuralDeclaration, "boolean", `${kind.id} states explicitly whether it is a structural declaration`);
  }
});

test("the first batch's seat rules are the ones the contract names, kind by kind", () => {
  const expected: Array<[string, string, string, boolean]> = [
    ["indexed-function", "unit", "anchor-cell", true],
    ["recovered-route", "unit", "anchor-cell", true],
    ["frontend-call", "unit", "anchor-cell", false],
    ["http-link", "relation", "any-endpoint", false],
    ["term-df", "corpus", "not-applicable", false]
  ];
  for (const [id, membershipKind, seatRule, structural] of expected) {
    const entry = factKindById(id as (typeof FACT_KIND_IDS)[number]);
    assert.equal(entry.membershipKind, membershipKind, id);
    assert.equal(entry.seatRule, seatRule, id);
    assert.equal(entry.structuralDeclaration, structural, id);
  }
  assert.throws(() => factKindById("nope" as (typeof FACT_KIND_IDS)[number]), /is not registered/);
});

test("an empty collection is not a membership: it would answer the seat question both ways", () => {
  assert.throws(() => spanSetMembership([]), /may not be empty/);
  assert.throws(() => relationMembership([]), /may not be empty/);
  assert.throws(() => unitMembership(" "), /non-empty id/);
  assert.throws(() => moduleMembership(""), /non-empty id/);
  assert.throws(() => spanSetMembership(["a", " "]), /non-empty id/);
});

test("a membership is canonical: sorted, deduplicated, and carrying no direction", () => {
  const relation = relationMembership(["cell:structure:9-20:b/api.go", "cell:structure:0-5:a/app.ts", "cell:structure:0-5:a/app.ts"]);
  assert.equal(relation.kind, "relation");
  if (relation.kind !== "relation") return;
  assert.deepEqual(relation.endpoints, ["cell:structure:0-5:a/app.ts", "cell:structure:9-20:b/api.go"]);
  const spanSet = spanSetMembership(["cell:residual:5-9:a.ts", "cell:structure:0-5:a.ts", "cell:residual:5-9:a.ts"]);
  assert.equal(spanSet.kind, "span-set");
  if (spanSet.kind !== "span-set") return;
  assert.deepEqual(spanSet.unitIds, ["cell:residual:5-9:a.ts", "cell:structure:0-5:a.ts"]);
  assert.deepEqual(CORPUS_MEMBERSHIP, { kind: "corpus" });
});

/** The five arms, one fixture each — the acceptance the Linear issue states branch by branch. */
test("evaluateSeat answers all five membership arms, and the corpus arm answers not-applicable", () => {
  const anchor = factKindById("indexed-function");
  const relationKind = factKindById("http-link");
  const corpusKind = factKindById("term-df");
  const seated = new Set(["cell:structure:0-40:src/app.ts"]);

  // {unit} / anchor-cell
  assert.equal(evaluateSeat(anchor, unitMembership("cell:structure:0-40:src/app.ts"), seated, NO_MODULES), "member");
  assert.equal(evaluateSeat(anchor, unitMembership("cell:residual:40-60:src/app.ts"), seated, NO_MODULES), "not-member");

  // {relation} / any-endpoint — the backend end seated, the frontend end not: still a member.
  const link = relationMembership(["cell:structure:0-40:src/app.ts", "cell:structure:0-90:web/page.tsx"]);
  assert.equal(evaluateSeat(relationKind, link, seated, NO_MODULES), "member");
  assert.equal(evaluateSeat(relationKind, relationMembership(["cell:structure:0-90:web/page.tsx", "cell:structure:0-9:web/other.tsx"]), seated, NO_MODULES), "not-member");

  // {corpus} / not-applicable — a written state, and no cell is implicated.
  assert.equal(evaluateSeat(corpusKind, CORPUS_MEMBERSHIP, seated, NO_MODULES), "not-applicable");
  assert.equal(evaluateSeat(corpusKind, CORPUS_MEMBERSHIP, new Set(), NO_MODULES), "not-applicable",
    "the corpus answer does not depend on the seated set at all");

  // {span-set} / all-covered and {module} / any-endpoint have no production kind in v1, so they are exercised
  // with synthetic entries: the rule is contract vocabulary and must be judgeable before a kind needs it.
  const covered = synthetic({ membershipKind: "span-set", seatRule: "all-covered" });
  const both = new Set(["cell:structure:0-40:src/app.ts", "cell:residual:40-60:src/app.ts"]);
  assert.equal(evaluateSeat(covered, spanSetMembership([...both]), both, NO_MODULES), "member");
  assert.equal(evaluateSeat(covered, spanSetMembership([...both]), seated, NO_MODULES), "not-member",
    "all-covered means every cell, so one seated out of two is not a member");

  const byModule = synthetic({ membershipKind: "module", seatRule: "any-endpoint" });
  const moduleOf = (cellId: string): string | null => (cellId.endsWith("src/app.ts") ? "api" : "web");
  assert.equal(evaluateSeat(byModule, moduleMembership("api"), seated, moduleOf), "member");
  assert.equal(evaluateSeat(byModule, moduleMembership("web"), seated, moduleOf), "not-member");
  assert.equal(evaluateSeat(byModule, moduleMembership("api"), new Set(), moduleOf), "not-member");
});

test("a membership whose shape disagrees with its kind is refused, not judged under the wrong rule", () => {
  const anchor = factKindById("indexed-function");
  assert.throws(() => evaluateSeat(anchor, CORPUS_MEMBERSHIP, new Set(), NO_MODULES),
    /declares "unit" membership but was handed "corpus"/);
  assert.throws(() => evaluateSeat(factKindById("http-link"), unitMembership("cell:structure:0-1:a.ts"), new Set(), NO_MODULES),
    /declares "relation" membership but was handed "unit"/);
});

/**
 * The dangling id, which is the silent one.
 *
 * A fact whose membership names a cell that was never minted is simply never seated: every conservation law still
 * balances, the fact vanishes from the working set, and nothing records that it did. The validator is what turns
 * that into a visible row.
 */
test("a membership naming a cell this run does not have is reported, per id", () => {
  const known = { cells: new Set(["cell:structure:0-40:src/app.ts"]), modules: new Set(["api"]) };
  assert.deepEqual(membershipViolations(unitMembership("cell:structure:0-40:src/app.ts"), known), []);
  assert.deepEqual(membershipViolations(CORPUS_MEMBERSHIP, known), []);
  assert.deepEqual(membershipViolations(moduleMembership("api"), known), []);
  assert.match(membershipViolations(unitMembership("cell:structure:0-40:src/gone.ts"), known)[0]!, /is not a partition cell of this run/);
  assert.equal(membershipViolations(relationMembership(["cell:structure:0-40:src/gone.ts", "cell:structure:0-1:src/also-gone.ts"]), known).length, 2,
    "each dangling endpoint is its own row; one message for two holes would hide one of them");
  assert.equal(membershipViolations(spanSetMembership(["cell:structure:0-40:src/app.ts", "cell:structure:0-1:src/gone.ts"]), known).length, 1);
  assert.match(membershipViolations(moduleMembership("nope"), known)[0]!, /is not a module of this run/);
});

test("the registry refuses to load a kind whose seat rule cannot be evaluated for its membership shape", () => {
  // The pairing that is genuinely uncomputable from the judge's inputs: every cell of a module is not knowable
  // from the seated set plus a cell -> module resolver, so the registry may not declare it.
  assert.throws(() => validateFactKindRegistry(registryWith({ membershipKind: "module", seatRule: "all-covered" })),
    /legal rules for that shape are any-endpoint/);
  assert.throws(() => validateFactKindRegistry(registryWith({ membershipKind: "corpus", seatRule: "anchor-cell" })),
    /legal rules for that shape are not-applicable/);
  assert.throws(() => validateFactKindRegistry(registryWith({ membershipKind: "relation", seatRule: "all-covered" })),
    /legal rules for that shape are any-endpoint/);
  assert.throws(() => validateFactKindRegistry(registryWith({ producer: "nowhere" })),
    /has no layer-3 envelope slot/);
  assert.throws(() => validateFactKindRegistry(registryWith({ title: " " })), /declares no title/);
  const base = factKindById("http-link");
  assert.throws(() => validateFactKindRegistry({ version: "test", kinds: [base, base] }), /registered twice/);
  // And the reverse hole: an id promised by the union with no entry behind it.
  assert.throws(() => validateFactKindRegistry(registryWith({})), /has no registry entry/);
});

test("the digest moves when a seat rule or a kind changes, and not otherwise", () => {
  const before = factKindRegistryDigest();
  assert.equal(before, factKindRegistryDigest(FACT_KIND_REGISTRY), "two derivations of one table are one value");
  const retargeted: FactKindRegistry = {
    ...FACT_KIND_REGISTRY,
    kinds: FACT_KIND_REGISTRY.kinds.map((kind) => kind.id === "http-link" ? { ...kind, structuralDeclaration: true } : kind)
  };
  assert.notEqual(factKindRegistryDigest(retargeted), before);
});

/**
 * The "one judge" property, as a scan.
 *
 * `evaluateSeat` living in the base is only half the guarantee; the other half is that nobody writes a second
 * one. A consumer switching on a fact kind to pick a rule is the P17 shape, and it reads as ordinary code.
 */
test("no second seat judgement exists in src/: the seat rule vocabulary appears in exactly one file", async () => {
  const files = await sourceFiles();
  const owners: string[] = [];
  for (const path of files) {
    const text = await readFile(path, "utf8");
    if (/"any-endpoint"|"anchor-cell"|"all-covered"/.test(text)) owners.push(path.slice(path.indexOf("/src/") + 1));
  }
  assert.deepEqual(owners, ["src/base/fact-kind-registry.ts"],
    "a second file naming the seat rules is a second semantic table; layer 5 must call evaluateSeat and nothing else");
});

function synthetic(overrides: Partial<FactKindEntry>): FactKindEntry {
  return { ...factKindById("http-link"), ...overrides } as FactKindEntry;
}

function registryWith(overrides: Partial<FactKindEntry>): FactKindRegistry {
  return { version: "test-registry", kinds: [{ ...factKindById("http-link"), ...overrides } as FactKindEntry] };
}

async function sourceFiles(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { join, resolve } = await import("node:path");
  const root = resolve("src");
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".ts")) out.push(path);
    }
  };
  await walk(root);
  return out.sort();
}

/** A compile-time sibling of the runtime switch: a new arm here is a new arm the judge must handle. */
export const ALL_ARMS: Membership[] = [
  unitMembership("cell:structure:0-1:a.ts"),
  spanSetMembership(["cell:structure:0-1:a.ts"]),
  relationMembership(["cell:structure:0-1:a.ts"]),
  moduleMembership("api"),
  CORPUS_MEMBERSHIP
];
