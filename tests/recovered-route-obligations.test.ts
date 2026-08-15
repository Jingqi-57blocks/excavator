import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readObligations, RECOVERED_ROUTE_DENOMINATOR_ASSURANCE_GENERATION } from "../src/assurance/read-obligations.ts";
import { reconcileReadCoverage } from "../src/assurance/read-coverage.ts";
import type { EvidenceItem, FeatureFactPack } from "../src/core/types.ts";

// THE FOURTH DENOMINATOR SOURCE, judged by replaying a real run rather than by waiting for the next one.
//
// An express registration whose handler is an inline closure resolves to no named function, so the third
// source (cross-repo link → handler) enumerates none of them. Measured on the real target: two v1 files hold
// 16 registrations, 9 decision-bearing, 719 accountable lines that NO source enumerated — and because a file
// with no obligation contributes to no bucket, every window opened there was invisible to BOTH sides of the
// funnel. Run #1 opened 9 windows on those files and its report stated none of the rules in them; nothing in
// the four-bucket ledger could see either half of that.
//
// The fixture is run #1's own frozen evidence plus the registrations re-derived from the same target (its
// artifact predates the field). Replaying it makes the historical loss countable and pins the distribution,
// so this is a regression floor rather than a claim about a future run.

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "recovered-routes", "run1-replay.json");

interface Replay {
  featureKey: string;
  registrations: Array<{ module: string; method: string; path: string; file: string; line: number; endLine: number }>;
  windows: EvidenceItem[];
}

function replay(): Replay {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as Replay;
}

/** Mirrors `recoveredRouteDenominator` in run.ts: the same filter and the same name/route composition. */
function recoveredSource(data: Replay, boundaryFiles: Set<string>) {
  return data.registrations
    .filter((entry) => entry.endLine !== undefined && entry.endLine >= entry.line)
    .filter((entry) => boundaryFiles.has(entry.file) || boundaryFiles.has(`${entry.module}/${entry.file}`))
    .map((entry) => ({
      featureKey: data.featureKey,
      name: `${entry.method} ${entry.path}`,
      path: `${entry.module}/${entry.file}`,
      startLine: entry.line,
      endLine: entry.endLine,
      route: entry.path,
    }));
}

function pack(data: Replay): FeatureFactPack {
  const files = [...new Set(data.registrations.map((entry) => `${entry.module}/${entry.file}`))];
  return {
    version: "factpack-v1", snapshotId: "replay", featureKey: data.featureKey, coverage: [], warnings: [],
    items: files.map((filePath, index) => ({ category: "logic", name: `anchor${index}`, filePath, line: 1, endLine: 1 })),
  } as unknown as FeatureFactPack;
}

test("the generation constant is the next one, so a run frozen under 7 keeps its denominator", () => {
  assert.equal(RECOVERED_ROUTE_DENOMINATOR_ASSURANCE_GENERATION, 8);
});

test("registrations with an inline handler become obligations of their own kind", () => {
  const data = replay();
  const factPack = pack(data);
  const boundary = new Set((factPack.items as Array<{ filePath: string }>).map((item) => item.filePath));
  const artifact = readObligations([factPack], [], null, null, null, recoveredSource(data, boundary));
  const recovered = artifact.obligations.filter((obligation) => obligation.kind === "recovered-route-handler");

  assert.equal(recovered.length, 16, "the two v1 express files' registrations");
  assert.equal(recovered.filter((obligation) => !obligation.excluded).length, 16, "all counted — none is a bare declaration");
  assert.equal(artifact.summary.recoveredRouteSource?.added, 16);
  assert.ok(recovered.every((obligation) => obligation.tier === 2 && obligation.gated === false),
    "advisory like every supplement before it: it widens what is counted, and gates nothing");
  // The route carries the vocabulary a mounted express path loses: locally these are `/`, `/approve`, `/:id`.
  assert.ok(recovered.every((obligation) => obligation.route && obligation.name.endsWith(obligation.route)));
  assert.ok(recovered.some((obligation) => obligation.name === "POST /leaves"), "the v1 leave creation");
});

// The historical loss, decomposed. Before this source, all of it read as nothing at all.
test("replaying run #1 puts every registration in a bucket, and the distribution is pinned", () => {
  const data = replay();
  const factPack = pack(data);
  const boundary = new Set((factPack.items as Array<{ filePath: string }>).map((item) => item.filePath));
  const artifact = readObligations([factPack], [], null, null, null, recoveredSource(data, boundary));
  const report = reconcileReadCoverage({ obligations: artifact.obligations, evidence: data.windows });

  const items = report.items.filter((item) => item.id.includes(":recovered-route-handler:"));
  assert.equal(items.length, 16, "no fourth state: every registration reconciles");
  const byStatus = (status: string): number => items.filter((item) => item.status === status).length;
  assert.deepEqual(
    { covered: byStatus("covered"), partial: byStatus("partial"), notOpened: byStatus("not-opened"), cannotDetermine: byStatus("cannot-determine") },
    { covered: 7, partial: 3, notOpened: 6, cannotDetermine: 0 },
    "run #1's real distribution over the 16 registrations",
  );
  assert.equal(items.filter((item) => item.openedWindows.length > 0 && item.consumedBy.length === 0).length, 10,
    "opened and cited by nothing — the half of the loss that is NOT a read-miss");
});

// The specific instance that motivated the slice, and the correction it forced: the failure here was not
// "never read". `POST /leaves` at 149-239 holds the v1 creation rules (`hours > 8`, `holiday_type === 2`)
// and run #1 opened it fully — then stated none of them. Calling that a read-miss would have sent the next
// slice after the wrong bucket, which is why the distribution is machine-judged rather than assumed.
test("the v1 creation rules were READ and unstated, while another 208-line handler was never opened", () => {
  const data = replay();
  const factPack = pack(data);
  const boundary = new Set((factPack.items as Array<{ filePath: string }>).map((item) => item.filePath));
  const artifact = readObligations([factPack], [], null, null, null, recoveredSource(data, boundary));
  const report = reconcileReadCoverage({ obligations: artifact.obligations, evidence: data.windows });

  const creation = report.items.find((item) => item.name === "POST /leaves");
  assert.ok(creation, "the v1 leave creation is in the denominator at all — before this source it was not");
  assert.equal(creation.status, "covered");
  assert.equal(creation.consumedBy.length, 0, "read in full, cited by no claim: a consume-miss, now countable");

  const detail = report.items.find((item) => item.name === "GET /leaves/:id");
  assert.equal(detail?.status, "not-opened");
  assert.equal(detail?.uncoveredLines, 208, "and a genuine read-miss of 208 lines, equally invisible before");
});

// A denominator that renamed or re-kinded what it already had would break every frozen run's digest.
test("the fourth source only adds — existing obligations keep their id and kind", () => {
  const data = replay();
  const factPack = pack(data);
  const boundary = new Set((factPack.items as Array<{ filePath: string }>).map((item) => item.filePath));
  const before = readObligations([factPack], [], null, null, null);
  const after = readObligations([factPack], [], null, null, null, recoveredSource(data, boundary));

  const kinds = new Map(before.obligations.map((obligation) => [obligation.id, obligation.kind]));
  for (const [id, kind] of kinds) {
    assert.equal(after.obligations.find((obligation) => obligation.id === id)?.kind, kind, `${id} changed kind`);
  }
  assert.equal(after.obligations.length, before.obligations.length + 16);
  assert.equal(after.summary.counted, before.summary.counted + 16);
});

test("a registration with no end line contributes nothing rather than a span-less obligation", () => {
  const data = replay();
  const factPack = pack(data);
  const boundary = new Set((factPack.items as Array<{ filePath: string }>).map((item) => item.filePath));
  const spanless = recoveredSource(data, boundary).map((entry) => ({ ...entry, endLine: entry.startLine - 1 }));
  const artifact = readObligations([factPack], [], null, null, null, spanless.filter((entry) => entry.endLine >= entry.startLine));
  assert.equal(artifact.obligations.filter((obligation) => obligation.kind === "recovered-route-handler").length, 0,
    "a span that cannot be reconciled would sit in cannot-determine forever");
});
