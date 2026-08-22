/**
 * `excavator status --run <dir>`: the run-wide read, and the last thing left of `authoring-stage.ts`.
 *
 * WHY IT OUTLIVED THAT FILE. Everything else there wrote sections (`beginDocument`, `checkpointSection`,
 * `assembleRun`, `resumeRun`, `scaffoldClaims`) and went with the section chain in 57B-480. This one only READS,
 * and most of what it reads is not section-shaped at all: the run id and state, the snapshot, the provider
 * registry, the work items, the trace catalog, the timeline length, the metrics — and `sourceText`, which is the
 * reason it could not simply be deleted. Callers, grep-verified when this was written:
 *
 *   $ git grep -n runStatus -- src tests eval
 *   src/cli.ts:368                          the `status` command without `--units`
 *   tests/redaction-mode-end-to-end.test.ts three assertions on `sourceText` (:78, :91, :117)
 *   tests/run-relocation.test.ts:375        the read resolves from `--run`, not from the recorded path
 *
 * `unitStatus` does NOT report `sourceText` (checked: no such field in `unit-status.ts`), so those three
 * assertions have no unit-path home, and an operator deciding whether a run directory may leave the machine
 * would lose the only read that answers them.
 *
 * MOVED WITH ZERO BEHAVIOUR CHANGE, DELIBERATELY — including the part that is now misleading. The `documents`
 * block still counts `sections[].complete`, so on a unit run it reports `complete: 0 / total: N` and a `next`
 * that nothing will ever write. That is NOT fixed here: this slice's contract for a move is byte-identical
 * behaviour, and its callers' assertions were left untouched so that claim stays checkable. What the block
 * should say is a separate, named decision (a behaviour change), reported rather than smuggled in.
 */

import { join, resolve } from "node:path";
import type { InvestigationPlan, RunManifest, TraceCatalog } from "../../base/types.ts";
import { readJson } from "../../base/util.ts";
import { readTimeline } from "../../base/timeline.ts";

export async function runStatus(runDirInput: string): Promise<Record<string, unknown>> {
  const runDir = resolve(runDirInput);
  const manifest = await readJson<RunManifest>(join(runDir, "run.json"));
  return {
    id: manifest.id,
    state: manifest.state,
    snapshot: manifest.snapshot?.id,
    // Stated on every status read, because with redaction defaulting OFF the run directory holds source
    // text verbatim, and an operator deciding whether these artifacts may leave the machine has no other
    // way to tell. A property of the run, so it is reported whether or not anyone thought to ask.
    sourceText: manifest.request.redactSecrets === true ? "redacted" : "verbatim",
    documents: manifest.documents.map((document) => ({
      id: document.id,
      complete: document.sections.filter((section) => section.complete).length,
      total: document.sections.length,
      elapsedMs: document.elapsedMs,
      next: document.sections.find((section) => !section.complete)?.index ?? null,
    })),
    providers: await readJson<unknown>(join(runDir, "provider-status.json")),
    workItems: await readJson<InvestigationPlan>(join(runDir, "workitems.json")),
    traces: await readJson<TraceCatalog>(join(runDir, "traces.json")),
    timelineEvents: (await readTimeline(runDir)).length,
    metrics: manifest.metrics,
  };
}
