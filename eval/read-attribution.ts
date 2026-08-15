// READ ATTRIBUTION — does the partitioned reading still point at the code a human said was worth reading?
//
// This is the gate for a MEASUREMENT, so its own criteria were fixed before the measurement existed. The
// golden file carries 225 hand-adjudicated obligations and, in `preRegistered`, the thresholds and the
// baseline they must be judged against — all committed before the signal was written. Nothing here may
// read a number out of the implementation and call it a result.
//
// Why this file exists at all is itself a finding: while the criteria were computed by throwaway scripts,
// a stale set of numbers from an earlier bucketing made it into a shipped advisory string and into the PR
// record, and nobody noticed. A criterion nobody can re-run is a criterion that drifts.
//
// Two checks, in the order they matter:
//   1. DECISION DIFFERENTIAL — rank files by unread lines. The old reading put noise-dominated files at the
//      top, which is how it misdirected; the new strong reading must put none there, and must surface the
//      clusters a human judged to be real misses. This is the only check that shows the instrument's
//      output would change a decision.
//   2. PURITY — the strong partition is mostly real misses, the unclassified partition is mostly noise.
//      Necessary but weak on its own: a signal that labels everything "strong" would score well on the
//      first half and terribly on the second, which is why both halves are required.

import { readFileSync } from "node:fs";
import { anchorHitFor } from "../src/assurance/relevance-annotation.ts";

export interface AttributionGolden {
  version: string;
  feature: string;
  items: Array<{ path: string; name: string; startLine: number; lines: number; kind: string; verdict: "true-miss" | "noise" | "gray" }>;
  preRegistered: {
    thresholds: { strongTrueMissRatio: number; unclassifiedNoiseRatio: number };
    oldReadingTop5: Array<{ path: string; lines: number }>;
    noiseDominatedFiles: string[];
    decisionDifferential: { mustAppearInStrongTop5: string[] };
  };
}

export interface AttributionReport {
  goldenPath: string;
  anchors: string[];
  strong: { total: number; trueMiss: number; ratio: number; threshold: number; pass: boolean };
  unclassified: { total: number; noise: number; ratio: number; threshold: number; pass: boolean };
  /** Real misses the labelling could not place — the reason the unclassified partition stays visible. */
  leakedTrueMisses: number;
  oldTop5: Array<{ path: string; lines: number; noiseDominated: boolean }>;
  strongTop5: Array<{ path: string; lines: number; noiseDominated: boolean }>;
  decisionDifferential: { oldNoiseInTop5: number; strongNoiseInTop5: number; missingRequired: string[]; pass: boolean };
}

export function loadAttributionGolden(path: string): AttributionGolden {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AttributionGolden>;
  if (parsed.version !== "read-attribution-v1") throw new Error(`unsupported golden version: ${String(parsed.version)}`);
  if (!parsed.items?.length) throw new Error("golden has no adjudicated items");
  if (!parsed.preRegistered?.thresholds) throw new Error("golden carries no pre-registered thresholds — the gate would have nothing to hold to");
  return parsed as AttributionGolden;
}

/**
 * `strong` is the partition to steer by: an obligation the prune retained, or one carrying the feature's
 * vocabulary. This mirrors `read-coverage.ts`'s partitioning exactly — retained first, then anchor — so the
 * gate measures the reading that ships, not a reconstruction of it.
 */
function isStrong(item: AttributionGolden["items"][number], anchors: string[]): boolean {
  if (item.kind === "decision-function") return true;
  return Boolean(anchorHitFor({ name: item.name, path: item.path }, anchors));
}

export function buildAttributionReport(goldenPath: string, anchors: string[]): AttributionReport {
  const golden = loadAttributionGolden(goldenPath);
  const { thresholds, oldReadingTop5, noiseDominatedFiles, decisionDifferential } = golden.preRegistered;
  const noiseDominated = new Set(noiseDominatedFiles);

  let strongTotal = 0, strongTrue = 0, unclTotal = 0, unclNoise = 0, leaked = 0;
  const strongLines: Record<string, number> = {};
  for (const item of golden.items) {
    const strong = isStrong(item, anchors);
    if (strong) {
      strongTotal += 1;
      if (item.verdict === "true-miss") strongTrue += 1;
      strongLines[item.path] = (strongLines[item.path] ?? 0) + item.lines;
    } else {
      unclTotal += 1;
      if (item.verdict === "noise") unclNoise += 1;
      if (item.verdict === "true-miss") leaked += 1;
    }
  }

  const strongTop5 = Object.entries(strongLines)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 5)
    .map(([path, lines]) => ({ path, lines, noiseDominated: noiseDominated.has(path) }));
  const oldTop5 = oldReadingTop5.map((entry) => ({ ...entry, noiseDominated: noiseDominated.has(entry.path) }));
  const missingRequired = decisionDifferential.mustAppearInStrongTop5.filter((path) => !strongTop5.some((entry) => entry.path === path));
  const strongNoiseInTop5 = strongTop5.filter((entry) => entry.noiseDominated).length;
  const oldNoiseInTop5 = oldTop5.filter((entry) => entry.noiseDominated).length;

  const strongRatio = strongTotal ? strongTrue / strongTotal : 0;
  const unclRatio = unclTotal ? unclNoise / unclTotal : 0;
  return {
    goldenPath,
    anchors,
    strong: { total: strongTotal, trueMiss: strongTrue, ratio: strongRatio, threshold: thresholds.strongTrueMissRatio, pass: strongRatio >= thresholds.strongTrueMissRatio },
    unclassified: { total: unclTotal, noise: unclNoise, ratio: unclRatio, threshold: thresholds.unclassifiedNoiseRatio, pass: unclRatio >= thresholds.unclassifiedNoiseRatio },
    leakedTrueMisses: leaked,
    oldTop5,
    strongTop5,
    decisionDifferential: {
      oldNoiseInTop5,
      strongNoiseInTop5,
      missingRequired,
      // The old reading must actually have been misdirecting, or there was nothing to fix.
      pass: oldNoiseInTop5 >= 2 && strongNoiseInTop5 === 0 && missingRequired.length === 0,
    },
  };
}

export function attributionExitCode(report: AttributionReport): number {
  return report.decisionDifferential.pass && report.strong.pass && report.unclassified.pass ? 0 : 1;
}

export function renderAttributionReport(report: AttributionReport): string {
  const lines: string[] = [];
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
  lines.push(`read attribution — ${report.goldenPath}`);
  lines.push(`  anchors: ${report.anchors.join(", ")}`);
  lines.push(`  strong:       ${report.strong.trueMiss}/${report.strong.total}真漏读 ${pct(report.strong.ratio)} (floor ${pct(report.strong.threshold)}) ${report.strong.pass ? "pass" : "FAIL"}`);
  lines.push(`  unclassified: ${report.unclassified.noise}/${report.unclassified.total} noise ${pct(report.unclassified.ratio)} (floor ${pct(report.unclassified.threshold)}) ${report.unclassified.pass ? "pass" : "FAIL"}`);
  lines.push(`  leaked real misses in unclassified: ${report.leakedTrueMisses} — why that partition is reported per file, never dismissed`);
  lines.push(`  decision differential: old top-5 noise-dominated ${report.decisionDifferential.oldNoiseInTop5} → strong top-5 ${report.decisionDifferential.strongNoiseInTop5} ${report.decisionDifferential.pass ? "pass" : "FAIL"}`);
  for (const entry of report.oldTop5) lines.push(`      old    ${String(entry.lines).padStart(5)}  ${entry.path}${entry.noiseDominated ? "   ← noise-dominated" : ""}`);
  for (const entry of report.strongTop5) lines.push(`      strong ${String(entry.lines).padStart(5)}  ${entry.path}${entry.noiseDominated ? "   ← noise-dominated" : ""}`);
  for (const path of report.decisionDifferential.missingRequired) lines.push(`      MISSING from strong top-5: ${path}`);
  return lines.join("\n");
}
