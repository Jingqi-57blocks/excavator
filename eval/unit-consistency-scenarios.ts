// The six scenarios the consistency golden is a reading of, built through the real commands.
//
// IT IS NOT IN THE TEST FILE because the regeneration command has to import it, and a test file cannot be imported
// to regenerate the very golden its top-level read requires. Same split, same reason, as the identity readings.
//
// EVERY SCENARIO GOES THROUGH `checkpointUnit` AND `assemble --units`: what the golden pins is the checker's reading
// of a run that passed every gate a unit already has, which is the premise the whole slice stands on.

import { CONTENTS_ANCHOR } from "../src/report/unit-assembly.ts";
import { checkRunConsistency } from "../src/report/unit-consistency-source.ts";
import {
  SETTLED_OBLIGATION_ID,
  UNANSWERED_OBLIGATION_IDS,
  assembledConsistencyRun,
  repairUnits,
  type ConsistencyRun,
  type UnitDraftOverride
} from "../tests/unit-consistency-fixture.ts";
import {
  projectConsistencyReadings,
  type ConsistencyReadingsProjection,
  type ConsistencyScenarioInput,
  type VolatileRunIdentity
} from "./unit-consistency-readings.ts";

const DOCUMENT = "overview-product";
const APPENDIX = `${DOCUMENT}::appendix::coverage`;
const COVERAGE_LEAF = `${DOCUMENT}::leaf::coverage`;
const OWNER_LEAF = `${DOCUMENT}::leaf::work-item-dimension`;
const ROOT = `${DOCUMENT}::synthesis::document`;

function identityOf(run: ConsistencyRun): VolatileRunIdentity {
  return {
    runId: run.view.runId,
    planCatalogDigest: run.view.planCatalogDigest,
    sourceEvidenceId: run.evidenceId,
    evidenceIds: run.view.frozenEvidenceIds
  };
}

/** One scenario: build the run with the given injections, check it, and hand back the reading plus its volatiles. */
async function scenario(
  name: string,
  injected: string,
  overrides: Readonly<Record<string, UnitDraftOverride>>
): Promise<ConsistencyScenarioInput> {
  const run = await assembledConsistencyRun(overrides);
  return { scenario: name, injected, reading: await checkRunConsistency(run.runDir), volatile: identityOf(run) };
}

const DRIFT: Readonly<Record<string, UnitDraftOverride>> = {
  [APPENDIX]: { terminology: [{ term: "Tenant", meaning: "一个付费客户" }] },
  [COVERAGE_LEAF]: { terminology: [{ term: "tenant", meaning: "一个数据库 schema" }] }
};

/** The whole projection: six scenarios over the one in-repo fixture, in a fixed order. */
export async function consistencyScenarioProjection(): Promise<ConsistencyReadingsProjection> {
  const clean = await scenario("clean", "nothing: the canned draft of every unit", {});

  const overclaim = await scenario("unknown-overclaim", `a fact claim on ${UNANSWERED_OBLIGATION_IDS[0]}, which this run recorded cannot-determine`, {
    [OWNER_LEAF]: {
      extraClaims: [{
        id: "F-overclaim",
        marker: "fact",
        statement: `义务 ${UNANSWERED_OBLIGATION_IDS[0]} 的处理已确认在 24 小时内完成。`,
        workItemIds: [UNANSWERED_OBLIGATION_IDS[0]],
        evidenceIds: []
      }]
    }
  });

  const drift = await scenario("terminology-drift", "two units defining the term Tenant with two meanings", DRIFT);

  const mixed = await scenario(
    "contradiction-references-and-policy",
    `one obligation (${SETTLED_OBLIGATION_ID}) asserted by one unit and disclaimed by another, an unresolvable prose link, a duplicated anchor id, and advice nothing negates`,
    {
      [APPENDIX]: {
        content: "## appendix\n\n见 [下文](#nowhere-at-all)。\n",
        extraClaims: [{ id: "U-settled", marker: "unavailable", statement: "无法判定。", workItemIds: [SETTLED_OBLIGATION_ID], reason: "not determinable here" }]
      },
      [COVERAGE_LEAF]: {
        content: `## coverage\n\n<a id="${CONTENTS_ANCHOR}"></a>\n\n修复建议见附录，请将超时下调。\n`,
        extraClaims: [{ id: "F-settled", marker: "fact", statement: "事实已确认。", workItemIds: [SETTLED_OBLIGATION_ID], evidenceIds: [] }]
      }
    }
  );

  // The fifth scenario is the CONVERGENCE reading: the drift run, repaired through the exact repair set, checked
  // again. A golden that only held defective states could not show that the repair closes.
  const repairedRun = await assembledConsistencyRun(DRIFT);
  const before = await checkRunConsistency(repairedRun.runDir);
  const agreed = { term: "Tenant", meaning: "一个付费客户" };
  await repairUnits(repairedRun, before.repair.targets.map((target) => target.unitId), {
    [APPENDIX]: { terminology: [agreed] },
    [COVERAGE_LEAF]: { terminology: [agreed] }
  });
  const repaired: ConsistencyScenarioInput = {
    scenario: "repaired",
    injected: "the terminology-drift run, re-drafted through exactly the repair set it named",
    reading: await checkRunConsistency(repairedRun.runDir),
    volatile: identityOf(repairedRun)
  };

  // The sixth scenario needs the run's OWN evidence id in prose, which only exists once the run does — so it is
  // drafted clean and then re-drafted through the repair path, exactly the way an operator would fix a unit.
  const leakingRun = await assembledConsistencyRun({});
  await repairUnits(leakingRun, [COVERAGE_LEAF, ROOT], {
    [COVERAGE_LEAF]: { content: `## coverage\n\n证据 ${leakingRun.evidenceId} 记录当前状态。\n` }
  });
  const leaking: ConsistencyScenarioInput = {
    scenario: "identifier-in-prose",
    injected: "the run's own sealed evidence id in the visible prose of a product-manager document",
    reading: await checkRunConsistency(leakingRun.runDir),
    volatile: identityOf(leakingRun)
  };

  return projectConsistencyReadings([clean, overclaim, drift, mixed, repaired, leaking]);
}

