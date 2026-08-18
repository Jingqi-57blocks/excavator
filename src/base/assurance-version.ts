import type { RunManifest } from "./types.ts";
import { REDACTION_VERSION } from "./util.ts";

/**
 * The assurance-generation gate: which contract generation a run was prepared under, and what may therefore be
 * believed about the bytes it recorded.
 *
 * It sits beneath the layers, not in layer 8, because its consumers straddle the whole order: the evidence
 * re-derivation check (knowledge side), freeze and the contract-instance audit (layer 8), the report-side
 * authoring gate and the orchestrator all ask the same question. Owned by any one of them, the others would be
 * importing upward — which is exactly the edge this file was carved out to remove. It is also the right shape
 * for what it is: a version constant derived from another base version constant (`REDACTION_VERSION`).
 */

/**
 * Version of the strict-assurance contract a run is audited against. It combines a strict-check
 * generation (`v4`) with the redaction marker, so it changes whenever redaction changes or a future
 * batch tightens the strict checks — bump the `v<n>` prefix when adding new strict checks. `v2` added
 * the substantive-section evidence-marker check (C3) on top of `v1`'s source re-derivation gate; `v3`
 * makes freeze a hard precondition of authoring (`begin` refuses an unfrozen run, and audit fails a run
 * that was authored without — or before — an `investigation.frozen` event); `v4` promotes each rescued
 * `logic` fact-pack function into a disposable work item (the plan, freeze expected-plan and audit
 * expected-plan/checklist all expand from that one derivation), so an undisposed material decision
 * function blocks freeze and audit; `v5` adds READING accountability — a frozen read-obligation
 * denominator (every in-boundary decision function with its span), reconciliation against the windows
 * actually opened, a hard gate rejecting a `found` disposition whose citations never touch the function
 * it reports, and an advisory residual for what was left unread; `v6` gives that denominator a SECOND
 * source — every decision-bearing function in the boundary's own files, not just the ones the prune
 * retained — because the first source inherits the boundary's recall ceiling (measured: a file inside the
 * boundary with obligations above and below a gap, and the rule-bearing functions sitting in the gap).
 * The second source is advisory: it widens what is counted and reported, and gates nothing. `v7` adds a
 * THIRD source: the backend handlers that resolved cross-repo HTTP links point at. A handler normally
 * lives in another repository and can never enter a feature's boundary on its own, so before this it was
 * unreachable by any denominator — the frontend called it and nothing accounted for reading it. Also
 * advisory. `v8` adds a FOURTH source: recovered route REGISTRATIONS whose handler is written inline. The
 * third source needs a named handler to resolve to, so an inline closure resolves to nothing and every
 * earlier source is silent on it — measured on the real target, two v1 express files held 16 registrations,
 * 9 decision-bearing, 719 accountable lines that no denominator enumerated, and because a file with no
 * obligation contributes to no bucket, windows opened there were invisible to BOTH sides of the funnel.
 * Also advisory: it widens what is counted and reported, and gates nothing.
 * A run stamps this at prepare (`manifest.assuranceVersion`); audit uses it to gate those strict
 * checks: only runs prepared under the current version are held to them, while older or field-less
 * runs are grandfathered so a later redaction/check bump never retroactively fails them.
 */
// v9 marks the generation where a run STATES its redaction mode. Runs prepared under v8 do not carry the
// field, and re-deriving their windows as plain would report every one of them stale — so the boundary is
// drawn in the version rather than papered over by a default. See `recordedUnderRedaction`.
/**
 * Whether this run's recorded source text is redacted, as the run itself reports it.
 *
 * An ABSENT field is not "off": before the mode existed, every run redacted unconditionally, so absence is
 * a fact about the old format rather than a default to guess at. Reading it as off made a whole generation
 * of archived runs fail re-derivation at once.
 */
export function recordedUnderRedaction(manifest: RunManifest): boolean {
  // Before v9 the field carries no meaning: redaction was unconditional, and a run whose request happened
  // to hold `redactSecrets: false` — a library caller's field surviving the request spread — was redacted
  // all the same. Honouring it there would re-derive a redacted archive as plain and report every window
  // stale. The generation decides whether the field is evidence; the field only speaks from v9 on.
  if (!assuranceGenerationAtLeast(manifest, REDACTION_MODE_ASSURANCE_GENERATION)) return true;
  return manifest.request.redactSecrets ?? true;
}

/** The generation from which a run STATES its redaction mode, so the field may be believed. */
export const REDACTION_MODE_ASSURANCE_GENERATION = 9;

/**
 * The generation from which a run materializes a `contract/` directory before any producer runs, and can
 * therefore be verified against the contract it recorded. An older archived run has no contract on disk; it is
 * grandfathered and keeps being verified by the generation gate alone, with no migration.
 */
export const CONTRACT_MANIFEST_ASSURANCE_GENERATION = 10;

// v11 makes relation-annotated factpack-v2 the only readable workset. This is an intentional archive boundary:
// v1 runs must be prepared again rather than being assigned membership and relation semantics they never wrote.
export const ASSURANCE_VERSION = `assurance-v11-factpack-v2-${REDACTION_VERSION}`;

/** Strict re-derivation checks apply only to runs prepared under exactly the current version. */
export function runUsesCurrentAssurance(manifest: RunManifest): boolean {
  return manifest.assuranceVersion === ASSURANCE_VERSION;
}

/**
 * The assurance GENERATION a run was prepared under — the integer `n` in `assurance-v<n>-...`, decoupled
 * from the redaction suffix. A missing or malformed `assuranceVersion` is generation 0. This is the gate
 * for GENERATIVE expansion of the expected set (adding the run's own baked default items back): it must not
 * hinge on exact-version equality, or a later assurance OR redaction bump would stop re-deriving items that
 * are already baked into a run's `workitems.json`, false-failing every run prepared under this generation.
 * (The strict IDENTITY re-derivation checks keep using `runUsesCurrentAssurance` — those legitimately need
 * exact equality.)
 */
export function assuranceGeneration(manifest: RunManifest): number {
  const match = /^assurance-v(\d+)/.exec(manifest.assuranceVersion ?? "");
  return match ? Number(match[1]) : 0;
}

/** Whether a run was prepared under assurance generation `n` or later (redaction-suffix independent). */
export function assuranceGenerationAtLeast(manifest: RunManifest, n: number): boolean {
  return assuranceGeneration(manifest) >= n;
}
