/**
 * One-time 57B-426 v0 baseline capture. This file intentionally calls the OLD production selector and is
 * deleted in the replacement commit. Its output survives as preregistration-v1.json; the first commit proves
 * that the artifact passed while the old selector was still the executable implementation.
 */
import { canonicalJson, sha256 } from "../src/base/util.ts";
import { pruneFeatureGraphWithModuleFloorRecorded } from "../src/attribution/prune-module-floor.ts";
import { loadAllocatorProjectionFixture, type AllocatorProjectionRow } from "./allocator-fixture.ts";
import { loadPrunePool } from "./prune-replay.ts";
import {
  ALLOCATOR_METRIC_VERSION, ALLOCATOR_PREREGISTRATION_VERSION,
  type AllocatorPreregistration, type PreregisteredAnchor, type PreregisteredCase
} from "./allocator-preregistration.ts";

interface AnchorSpec { id: string; name: string; relativePath: string; startLine?: number }

interface CaseSpec {
  id: PreregisteredCase["id"];
  target: PreregisteredCase["target"];
  capability: string;
  languages: string[];
  poolFile: string;
  projectionFile: string;
  anchors: AnchorSpec[];
}

const CASES: readonly CaseSpec[] = [
  {
    id: "wcp-leave", target: "wcp", capability: "leave management", languages: ["go", "javascript"],
    poolFile: "eval/fixtures/wcp-leave/prune-pool.json.gz",
    projectionFile: "eval/fixtures/allocator/wcp-leave-projection.json.gz",
    anchors: [
      { id: "calculation-auto", name: "CalculationAuto", relativePath: "internal/handlers/support/service.go" },
      { id: "sync-leave-completed", name: "syncLvCompleted", relativePath: "internal/third_party/cron/cron.go" },
      { id: "ignore-holiday-leave-type", name: "isIgnoreHolidayLvType", relativePath: "internal/handlers/support/service.go" },
      { id: "leave-export", name: "Export", relativePath: "internal/handlers/leave/service.go", startLine: 1452 },
      { id: "max-available-holiday", name: "maxAvailableHoliday", relativePath: "internal/handlers/leave/brdg_abst.go" },
      { id: "record-taken-leave-hours", name: "recordTakeLeaveHours", relativePath: "wcp-service/services/leaveService.js" },
      { id: "leave-request-precheck", name: "leaveRequestPreCheck", relativePath: "wcp-service/services/leaveService.js" }
    ]
  },
  {
    id: "angels-order", target: "angels-pizza", capability: "order fulfillment", languages: ["javascript"],
    poolFile: "eval/fixtures/allocator/angels-order-pool.json.gz",
    projectionFile: "eval/fixtures/allocator/angels-order-projection.json.gz",
    anchors: [
      { id: "create-checkout", name: "createCheckoutSession", relativePath: "backend/routes/order/addCheckout.js" },
      { id: "validate-checkout", name: "validateCheckoutSchedule", relativePath: "backend/routes/order/addCheckout.js" },
      { id: "refresh-payment", name: "refreshOrderPaymentStatus", relativePath: "backend/routes/order/refreshOrderPaymentStatus.js" },
      { id: "update-fulfillment", name: "updateOrderFulfillment", relativePath: "admin-backend/src/controllers/order/order-controller.js" },
      { id: "update-order-status", name: "updateOrderStatus", relativePath: "admin-backend/src/controllers/order/order-controller.js" },
      { id: "bulk-delivered", name: "bulkMarkOrdersDelivered", relativePath: "admin-backend/src/controllers/order/order-controller.js" },
      { id: "assign-rider", name: "assignOrderRider", relativePath: "admin-backend/src/controllers/order/order-controller.js" },
      { id: "export-orders", name: "exportOrdersCsv", relativePath: "admin-backend/src/controllers/order/order-controller.js" }
    ]
  },
  {
    id: "angels-rider", target: "angels-pizza", capability: "rider delivery", languages: ["javascript", "vue"],
    poolFile: "eval/fixtures/allocator/angels-rider-pool.json.gz",
    projectionFile: "eval/fixtures/allocator/angels-rider-projection.json.gz",
    anchors: [
      { id: "watch-dispatch", name: "watchDispatchStatus", relativePath: "admin-backend/src/controllers/order/dispatch-socket.js" },
      { id: "assign-rider", name: "assignOrderRider", relativePath: "admin-backend/src/controllers/order/order-controller.js" },
      { id: "fetch-riders", name: "fetchAllRiders", relativePath: "admin-backend/src/controllers/rider/rider-controller.js" },
      { id: "create-rider", name: "createNewRider", relativePath: "admin-backend/src/controllers/rider/rider-controller.js" },
      { id: "rider-status", name: "riderUpdateOrderStatus", relativePath: "admin-backend/src/controllers/rider/rider-controller.js" },
      { id: "rider-report", name: "getRiderReport", relativePath: "admin-backend/src/controllers/rider/rider-report.js" },
      { id: "least-delivery-rider", name: "leastDeliveryRider", relativePath: "admin-backend/src/controllers/order/order-controller.js" },
      { id: "delivery-location-ui", name: "requestCurrentLocation", relativePath: "ionic-vue/src/views/DeliveryUserLocationMap.vue" }
    ]
  }
];

function counts(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function resolveAnchor(spec: AnchorSpec, rows: readonly AllocatorProjectionRow[], selected: ReadonlySet<string>): PreregisteredAnchor {
  const matches = rows.filter((row) => row.name === spec.name
    && row.relativePath.endsWith(spec.relativePath)
    && (spec.startLine === undefined || row.startLine === spec.startLine));
  if (matches.length !== 1) throw new Error(`${spec.id}: expected one projection row, got ${matches.length}`);
  const row = matches[0]!;
  if (!selected.has(row.nodeId)) throw new Error(`${spec.id}: old selector did not seat ${row.nodeId}`);
  if (!row.unitId || !row.language || !row.partitionKind) throw new Error(`${spec.id}: anchor is not projectable`);
  return {
    id: spec.id, name: row.name, relativePath: row.relativePath, startLine: row.startLine,
    nodeId: row.nodeId, unitId: row.unitId, language: row.language, partitionKind: row.partitionKind
  };
}

function captureCase(spec: CaseSpec): PreregisteredCase {
  const pool = loadPrunePool(spec.poolFile);
  const projection = loadAllocatorProjectionFixture(spec.projectionFile);
  const selectedNodes = pruneFeatureGraphWithModuleFloorRecorded(pool.nodes, pool.edges, pool.seeds, pool.anchorTerms, 250).nodes;
  const selected = new Set(selectedNodes.map((node) => String(node.id)));
  const projectable = projection.rows.filter((row) => selected.has(row.nodeId) && row.unitId !== null);
  const unitRows = new Map<string, AllocatorProjectionRow>();
  for (const row of projectable) {
    const previous = unitRows.get(row.unitId!);
    if (previous && (previous.language !== row.language || previous.partitionKind !== row.partitionKind)) {
      throw new Error(`${spec.id}: inconsistent projection for ${row.unitId}`);
    }
    unitRows.set(row.unitId!, row);
  }
  const seatedUnitIds = [...unitRows.keys()].sort();
  return {
    id: spec.id, target: spec.target, capability: spec.capability, languages: [...spec.languages].sort(),
    poolFile: spec.poolFile, projectionFile: spec.projectionFile,
    poolDigest: projection.poolDigest, unitsContentDigest: projection.unitsContentDigest,
    budget: { maxNodes: 250, expansionDepth: 2, maxGraphQueries: 1000 },
    legacy: {
      selectedNodes: selectedNodes.length,
      projectableNodes: projectable.length,
      seatedUnitIds,
      seatedUnitIdsDigest: sha256(canonicalJson(seatedUnitIds)),
      seatsByLanguage: counts([...unitRows.values()].map((row) => row.language ?? "unknown")),
      seatsByPartitionKind: counts([...unitRows.values()].map((row) => row.partitionKind ?? "unknown"))
    },
    anchors: spec.anchors.map((anchor) => resolveAnchor(anchor, projection.rows, selected))
  };
}

export function captureAllocatorPreregistration(): AllocatorPreregistration {
  const cases = CASES.map(captureCase);
  return {
    version: ALLOCATOR_PREREGISTRATION_VERSION,
    metricVersion: ALLOCATOR_METRIC_VERSION,
    measuredBeforeAlgorithmSourceChange: true,
    eligibility: { universe: "every-node-in-expanded-pool", thresholdAdmissionAllowed: false, silentModuleSeatAllowed: false },
    contributionContract: {
      requiredFields: ["sourceChannel", "reason", "anchor", "propagationPath"],
      nullAnchorAllowedOnlyFor: ["fallback"]
    },
    proposedFusion: {
      method: "weighted-reciprocal-rank", rankConstant: 60, rawScoresMayBeSummedAcrossChannels: false,
      channelOrder: ["seed", "lexical", "derived", "relation", "convention", "fallback"],
      weights: { seed: 1, lexical: 1, derived: 1, relation: 1, convention: 1, fallback: 0.25 },
      tieBreak: ["relativePath", "name", "nodeId"], fallbackRanksEveryEligibleCandidate: true
    },
    cases,
    gates: {
      M1: {
        measure: "three-run-mean-feature-context-ms", maxRelativeOverhead: 0.2,
        baseline: {
          "wcp-leave": { featureContextMs: 1258, runDir: ".work/57b-426-baseline/wcp/runs/run-2026_08_18_19_33-请假管理-8abb4795-941834f4-74372991" },
          "angels-order": { featureContextMs: 872, runDir: ".work/57b-426-baseline/angels-pizza/runs/run-2026_08_18_19_32-order-fulfillmen-fb61f1a2-4543dedd-6308e734" },
          "angels-rider": { featureContextMs: 830, runDir: ".work/57b-426-baseline/angels-pizza/runs/run-2026_08_18_19_32-rider-delivery-fb61f1a2-2ebafd9d-ffaeca0f" }
        },
        failureAction: "block-replacement"
      },
      M2: {
        measure: "sole-source-seats-by-channel-capability-target-language",
        cases: cases.map((row) => row.id), failurePredicate: "all-capabilities-have-zero-sole-source-seats",
        failureAction: "remove-non-contributing-channel-or-block-replacement"
      },
      M3: { measure: "seat-kind-distribution-and-named-anchor-unit-loss", failurePredicate: "any-frozen-anchor-unit-id-is-unseated", failureAction: "block-replacement" },
      M4: { measure: "legacy-v0-unit-id-set-comparison", failurePredicate: "new-is-strict-subset-and-adds-no-sole-source-or-obligation-seat", failureAction: "block-replacement" },
      M5: {
        measure: "document-frequency-and-derived-term-expansion-ablation", toggles: ["documentFrequency", "derivedTerms"],
        failurePredicate: "enabling-expansion-removes-any-frozen-anchor-unit-id", failureAction: "disable-offending-expansion-or-block-replacement"
      },
      M6: {
        measure: "zero-signal-and-alias-deletion-module-row-preservation",
        fixtures: [
          {
            id: "wcp-zero-signal", poolFile: "eval/fixtures/allocator/wcp-zero-signal-pool.json.gz",
            projectionFile: "eval/fixtures/allocator/wcp-zero-signal-projection.json.gz",
            poolDigest: loadAllocatorProjectionFixture("eval/fixtures/allocator/wcp-zero-signal-projection.json.gz").poolDigest,
            expectedModules: ["wcp-auth", "wcp-service", "wcp-service-v2", "wcp-ui", "wcp_review_service"]
          },
          {
            id: "angels-order-no-checkout", poolFile: "eval/fixtures/allocator/angels-order-no-checkout-pool.json.gz",
            projectionFile: "eval/fixtures/allocator/angels-order-no-checkout-projection.json.gz",
            poolDigest: loadAllocatorProjectionFixture("eval/fixtures/allocator/angels-order-no-checkout-projection.json.gz").poolDigest,
            expectedModules: ["admin-backend", "backend", "ionic-vue", "web-vue"]
          }
        ],
        failurePredicate: "any-expected-module-row-is-absent", failureAction: "block-replacement"
      },
      M7: {
        measure: "weight-perturbation-counter-explanation", perturbation: { channel: "lexical", from: 1, to: 1.25 },
        failurePredicate: "seat-set-changes-without-ranked-counter-contribution", failureAction: "block-replacement"
      }
    }
  };
}
