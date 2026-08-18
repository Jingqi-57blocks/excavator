import { readFileSync } from "node:fs";
import { canonicalJson, sha256 } from "../src/base/util.ts";

export const ALLOCATOR_PREREGISTRATION_VERSION = "allocator-preregistration-v1";
export const ALLOCATOR_METRIC_VERSION = "allocator-metrics-v1";

export interface PreregisteredAnchor {
  readonly id: string;
  readonly name: string;
  readonly relativePath: string;
  readonly startLine: number | null;
  readonly nodeId: string;
  readonly unitId: string;
  readonly language: string;
  readonly partitionKind: "structure" | "residual";
}

export interface PreregisteredCase {
  readonly id: "wcp-leave" | "angels-order" | "angels-rider";
  readonly target: "wcp" | "angels-pizza";
  readonly capability: string;
  readonly languages: readonly string[];
  readonly poolFile: string;
  readonly projectionFile: string;
  readonly poolDigest: string;
  readonly unitsContentDigest: string;
  readonly budget: { readonly maxNodes: 250; readonly expansionDepth: 2; readonly maxGraphQueries: 1000 };
  readonly legacy: {
    readonly selectedNodes: number;
    readonly projectableNodes: number;
    readonly seatedUnitIds: readonly string[];
    readonly seatedUnitIdsDigest: string;
    readonly seatsByLanguage: Readonly<Record<string, number>>;
    readonly seatsByPartitionKind: Readonly<Record<string, number>>;
  };
  readonly anchors: readonly PreregisteredAnchor[];
}

export interface AllocatorPreregistration {
  readonly version: typeof ALLOCATOR_PREREGISTRATION_VERSION;
  readonly metricVersion: typeof ALLOCATOR_METRIC_VERSION;
  readonly measuredBeforeAlgorithmSourceChange: true;
  readonly eligibility: {
    readonly universe: "every-node-in-expanded-pool";
    readonly thresholdAdmissionAllowed: false;
    readonly silentModuleSeatAllowed: false;
  };
  readonly contributionContract: {
    readonly requiredFields: readonly ["sourceChannel", "reason", "anchor", "propagationPath"];
    readonly nullAnchorAllowedOnlyFor: readonly ["fallback"];
  };
  readonly proposedFusion: {
    readonly method: "weighted-reciprocal-rank";
    readonly rankConstant: 60;
    readonly rawScoresMayBeSummedAcrossChannels: false;
    readonly channelOrder: readonly string[];
    readonly weights: Readonly<Record<string, number>>;
    readonly tieBreak: readonly ["relativePath", "name", "nodeId"];
    readonly fallbackRanksEveryEligibleCandidate: true;
    readonly channelSemantics: Readonly<Record<string, {
      readonly source: string;
      readonly localStrength: string;
      readonly reason: string;
      readonly anchor: string;
      readonly propagationPath: string;
    }>>;
  };
  readonly cases: readonly PreregisteredCase[];
  readonly gates: {
    readonly M1: {
      readonly measure: "three-run-mean-feature-context-ms";
      readonly maxRelativeOverhead: 0.2;
      readonly baseline: Readonly<Record<string, { readonly featureContextMs: number; readonly runDir: string }>>;
      readonly failureAction: "block-replacement";
    };
    readonly M2: {
      readonly measure: "sole-source-seats-by-channel-capability-target-language";
      readonly cases: readonly string[];
      readonly failurePredicate: "all-capabilities-have-zero-sole-source-seats";
      readonly failureAction: "remove-non-contributing-channel-or-block-replacement";
    };
    readonly M3: {
      readonly measure: "seat-kind-distribution-and-named-anchor-unit-loss";
      readonly failurePredicate: "any-frozen-anchor-unit-id-is-unseated";
      readonly failureAction: "block-replacement";
    };
    readonly M4: {
      readonly measure: "legacy-v0-unit-id-set-comparison";
      readonly failurePredicate: "new-is-strict-subset-and-adds-no-sole-source-or-obligation-seat";
      readonly failureAction: "block-replacement";
    };
    readonly M5: {
      readonly measure: "document-frequency-and-derived-term-expansion-ablation";
      readonly toggles: readonly ["documentFrequency", "derivedTerms"];
      readonly failurePredicate: "enabling-expansion-removes-any-frozen-anchor-unit-id";
      readonly failureAction: "disable-offending-expansion-or-block-replacement";
    };
    readonly M6: {
      readonly measure: "zero-signal-and-alias-deletion-module-row-preservation";
      readonly fixtures: ReadonlyArray<{
        readonly id: string;
        readonly poolFile: string;
        readonly projectionFile: string;
        readonly poolDigest: string;
        readonly expectedModules: readonly string[];
      }>;
      readonly failurePredicate: "any-expected-module-row-is-absent";
      readonly failureAction: "block-replacement";
    };
    readonly M7: {
      readonly measure: "weight-perturbation-counter-explanation";
      readonly perturbation: { readonly channel: "lexical"; readonly from: 1; readonly to: 1.25 };
      readonly failurePredicate: "seat-set-changes-without-ranked-counter-contribution";
      readonly failureAction: "block-replacement";
    };
  };
}

export function loadAllocatorPreregistration(path: string): AllocatorPreregistration {
  return JSON.parse(readFileSync(path, "utf8")) as AllocatorPreregistration;
}

export function allocatorPreregistrationDigest(value: AllocatorPreregistration): string {
  return sha256(canonicalJson(value));
}

/** Structural validation deliberately does not execute an allocator. The committed artifact is the frozen v0
 * comparison after the old selector is deleted; git history contains the pre-change executable validation. */
export function validateAllocatorPreregistration(value: AllocatorPreregistration): string[] {
  const errors: string[] = [];
  if (value.version !== ALLOCATOR_PREREGISTRATION_VERSION) errors.push("version");
  if (value.metricVersion !== ALLOCATOR_METRIC_VERSION) errors.push("metricVersion");
  if (!value.measuredBeforeAlgorithmSourceChange) errors.push("measurement-order");
  if (value.eligibility.thresholdAdmissionAllowed) errors.push("threshold-admission");
  if (value.eligibility.silentModuleSeatAllowed) errors.push("silent-module-seat");
  if (canonicalJson(value.contributionContract.requiredFields) !== canonicalJson(["sourceChannel", "reason", "anchor", "propagationPath"])) {
    errors.push("contribution-contract");
  }
  if (value.proposedFusion.rawScoresMayBeSummedAcrossChannels) errors.push("raw-score-sum");
  if (!value.proposedFusion.fallbackRanksEveryEligibleCandidate) errors.push("bounded-fallback");
  if (Object.keys(value.proposedFusion.channelSemantics).sort().join(",") !== "convention,derived,fallback,lexical,relation,seed") errors.push("channel-semantics");
  if (value.cases.length !== 3 || new Set(value.cases.map((row) => row.target)).size !== 2) errors.push("case-matrix");
  for (const row of value.cases) {
    if (row.budget.maxNodes !== 250 || row.budget.expansionDepth !== 2 || row.budget.maxGraphQueries !== 1000) errors.push(`${row.id}:budget`);
    if (row.legacy.seatedUnitIdsDigest !== sha256(canonicalJson(row.legacy.seatedUnitIds))) errors.push(`${row.id}:legacy-digest`);
    if (row.legacy.seatedUnitIds.some((id, index, all) => index > 0 && all[index - 1]! >= id)) errors.push(`${row.id}:legacy-order`);
    const legacy = new Set(row.legacy.seatedUnitIds);
    for (const anchor of row.anchors) if (!legacy.has(anchor.unitId)) errors.push(`${row.id}:anchor:${anchor.id}`);
  }
  if (value.gates.M1.maxRelativeOverhead !== 0.2 || value.gates.M1.measure !== "three-run-mean-feature-context-ms") errors.push("M1");
  if (value.gates.M2.cases.length !== 3) errors.push("M2");
  if (value.gates.M5.toggles.join(",") !== "documentFrequency,derivedTerms") errors.push("M5");
  if (value.gates.M6.fixtures.length !== 2) errors.push("M6");
  if (value.gates.M7.perturbation.channel !== "lexical") errors.push("M7");
  return errors;
}
