import { readFileSync } from "node:fs";
import { canonicalJson, sha256 } from "../src/base/util.ts";
import type { AllocatorPreregistration } from "./allocator-preregistration.ts";
import { allocatorPreregistrationDigest } from "./allocator-preregistration.ts";

export const ALLOCATOR_REPLACEMENT_MEASUREMENTS_VERSION = "allocator-replacement-measurements-v1";

export interface TimingSample {
  readonly runDir: string;
  readonly featureContextMs: number;
}

export interface PairedTimingSample {
  readonly pair: 1 | 2 | 3;
  readonly order: "old-new" | "new-old";
  readonly baseline: TimingSample;
  readonly replacement: TimingSample;
}

export interface AllocatorReplacementMeasurements {
  readonly version: typeof ALLOCATOR_REPLACEMENT_MEASUREMENTS_VERSION;
  readonly metricVersion: "allocator-metrics-v1";
  readonly preregistrationDigest: string;
  readonly maxRelativeOverhead: 0.2;
  /** Preserved because it first crossed the threshold and triggered the paired diagnostic; it is never erased. */
  readonly sequentialDiagnostic: {
    readonly protocol: string;
    readonly cases: ReadonlyArray<{
      readonly id: string;
      readonly baseline: readonly TimingSample[];
      readonly replacement: readonly TimingSample[];
      readonly baselineMeanMs: number;
      readonly replacementMeanMs: number;
      readonly relativeOverhead: number;
      readonly thresholdPass: boolean;
    }>;
  };
  readonly gateProtocol: string;
  readonly cases: ReadonlyArray<{
    readonly id: string;
    readonly pairs: readonly PairedTimingSample[];
    readonly baselineMeanMs: number;
    readonly replacementMeanMs: number;
    readonly relativeOverhead: number;
    readonly thresholdPass: boolean;
  }>;
  readonly kernel: {
    readonly poolFile: string;
    readonly poolDigest: string;
    readonly warmupIterations: number;
    readonly measuredIterations: number;
    readonly baselineMeanMs: number;
    readonly replacementMeanMs: number;
    readonly relativeOverhead: number;
  };
  readonly moduleCensus: {
    readonly runs: ReadonlyArray<{
      readonly id: "wcp-leave" | "wcp-zero-signal" | "angels-order-no-checkout";
      readonly runDir: string;
      /** SHA-256 of the exact production attribution envelope from which these rows were copied. */
      readonly attributionSha256: string;
      readonly rows: ReadonlyArray<{
        readonly moduleId: string;
        readonly denominatorCells: number;
        readonly poolNodes: number;
        readonly seatedCells: number;
        readonly status: "seated" | "candidates-no-seat" | "zero-signal" | "outside-denominator";
      }>;
    }>;
  };
  readonly allGatesPass: boolean;
}

export function loadAllocatorReplacementMeasurements(path: string): AllocatorReplacementMeasurements {
  return JSON.parse(readFileSync(path, "utf8")) as AllocatorReplacementMeasurements;
}

export function allocatorReplacementMeasurementsDigest(value: AllocatorReplacementMeasurements): string {
  return sha256(canonicalJson(value));
}

function mean(samples: readonly TimingSample[], field: "featureContextMs" = "featureContextMs"): number {
  return samples.reduce((sum, sample) => sum + sample[field], 0) / samples.length;
}

function close(actual: number, expected: number): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) < 1e-12;
}

/** Machine gate for the recorded measurements; paths are provenance and are deliberately not required on CI. */
export function validateAllocatorReplacementMeasurements(
  value: AllocatorReplacementMeasurements,
  preregistration: AllocatorPreregistration
): string[] {
  const errors: string[] = [];
  if (value.version !== ALLOCATOR_REPLACEMENT_MEASUREMENTS_VERSION) errors.push("version");
  if (value.metricVersion !== preregistration.metricVersion) errors.push("metricVersion");
  if (value.preregistrationDigest !== allocatorPreregistrationDigest(preregistration)) errors.push("preregistrationDigest");
  if (value.maxRelativeOverhead !== preregistration.gates.M1.maxRelativeOverhead) errors.push("threshold");
  const expectedCases = [...preregistration.gates.M2.cases].sort();
  if (value.cases.map((row) => row.id).sort().join(",") !== expectedCases.join(",")) errors.push("cases");
  if (value.sequentialDiagnostic.cases.map((row) => row.id).sort().join(",") !== expectedCases.join(",")) errors.push("diagnostic-cases");
  for (const row of value.sequentialDiagnostic.cases) {
    if (row.baseline.length !== 3 || row.replacement.length !== 3) errors.push(`${row.id}:diagnostic-samples`);
    const baselineMean = mean(row.baseline);
    const replacementMean = mean(row.replacement);
    const overhead = (replacementMean - baselineMean) / baselineMean;
    if (!close(row.baselineMeanMs, baselineMean)) errors.push(`${row.id}:diagnosticBaselineMean`);
    if (!close(row.replacementMeanMs, replacementMean)) errors.push(`${row.id}:diagnosticReplacementMean`);
    if (!close(row.relativeOverhead, overhead)) errors.push(`${row.id}:diagnosticOverhead`);
    if (row.thresholdPass !== (overhead <= value.maxRelativeOverhead)) errors.push(`${row.id}:diagnosticPass`);
  }
  for (const row of value.cases) {
    if (row.pairs.length !== 3 || row.pairs.map((pair) => pair.pair).join(",") !== "1,2,3") errors.push(`${row.id}:pairs`);
    if (row.pairs.map((pair) => pair.order).join(",") !== "old-new,new-old,old-new") errors.push(`${row.id}:order`);
    const baseline = row.pairs.map((pair) => pair.baseline);
    const replacement = row.pairs.map((pair) => pair.replacement);
    const baselineMean = mean(baseline);
    const replacementMean = mean(replacement);
    const overhead = (replacementMean - baselineMean) / baselineMean;
    if (!close(row.baselineMeanMs, baselineMean)) errors.push(`${row.id}:baselineMean`);
    if (!close(row.replacementMeanMs, replacementMean)) errors.push(`${row.id}:replacementMean`);
    if (!close(row.relativeOverhead, overhead)) errors.push(`${row.id}:overhead`);
    if (row.thresholdPass !== (overhead <= value.maxRelativeOverhead)) errors.push(`${row.id}:pass`);
  }
  const diagnosticWcp = value.sequentialDiagnostic.cases.find((row) => row.id === "wcp-leave");
  if (!diagnosticWcp || diagnosticWcp.thresholdPass || diagnosticWcp.relativeOverhead <= value.maxRelativeOverhead) {
    errors.push("sequential-drift-preservation");
  }
  const wcp = preregistration.cases.find((row) => row.id === "wcp-leave")!;
  if (value.kernel.poolFile !== wcp.poolFile || value.kernel.poolDigest !== wcp.poolDigest) errors.push("kernel-input");
  if (value.kernel.measuredIterations !== 100 || value.kernel.warmupIterations !== 5) errors.push("kernel-iterations");
  const expectedCensusRuns = ["wcp-leave", ...preregistration.gates.M6.fixtures.map((row) => row.id)].sort();
  if (value.moduleCensus.runs.map((row) => row.id).sort().join(",") !== expectedCensusRuns.join(",")) errors.push("module-census-runs");
  const wcpModules = preregistration.gates.M6.fixtures.find((row) => row.id === "wcp-zero-signal")!.expectedModules;
  for (const run of value.moduleCensus.runs) {
    if (!/^[0-9a-f]{64}$/.test(run.attributionSha256)) errors.push(`module-census-digest:${run.id}`);
    const expectedModules = run.id === "angels-order-no-checkout"
      ? preregistration.gates.M6.fixtures.find((row) => row.id === run.id)!.expectedModules
      : wcpModules;
    const actualModules = run.rows.map((row) => row.moduleId);
    if (new Set(actualModules).size !== actualModules.length) errors.push(`module-census-duplicates:${run.id}`);
    if (actualModules.sort().join(",") !== [...expectedModules].sort().join(",")) errors.push(`module-census:${run.id}`);
    for (const row of run.rows) {
      if (!Number.isInteger(row.denominatorCells) || row.denominatorCells <= 0) errors.push(`module-denominator:${run.id}:${row.moduleId}`);
      if (!Number.isInteger(row.poolNodes) || row.poolNodes < 0) errors.push(`module-pool:${run.id}:${row.moduleId}`);
      if (!Number.isInteger(row.seatedCells) || row.seatedCells < 0) errors.push(`module-seats:${run.id}:${row.moduleId}`);
      if (row.poolNodes === 0 && row.seatedCells !== 0) errors.push(`forced-seat:${run.id}:${row.moduleId}`);
      if (run.id === "wcp-zero-signal" && (row.poolNodes !== 0 || row.seatedCells !== 0 || row.status !== "zero-signal")) {
        errors.push(`zero-signal:${row.moduleId}`);
      }
    }
  }
  if (value.allGatesPass !== value.cases.every((row) => row.thresholdPass)) errors.push("allGatesPass");
  return errors;
}
