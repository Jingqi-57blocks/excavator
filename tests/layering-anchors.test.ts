import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Every `path:line` anchor in `docs/layering.md`, checked against the code it points at.
 *
 * Hand-verified anchors do not survive one slice. Measured: of the twenty anchors in that document, six rotted
 * inside a single slice — one `run.ts` reference was off by 41 lines — and the prose kept reading as if it were
 * true, which is worse than having no anchor at all: a contract whose citations silently drift is a contract
 * nobody can check the code against.
 *
 * The mechanism is a TOTAL classification. Every anchor the extractor finds must appear in `ANCHORS` below as
 * either `current` (the file's stated line range must contain a stated fragment, exact line numbers, no
 * tolerance), `current-file` (a path with no line range — the file must exist) or `historical` (a location as it
 * was before a fix, kept in the document as provenance; no code check). Unclassified is RED, and so is a
 * classification for an anchor the document no longer contains — the list cannot rot in either direction.
 *
 * `current-file` is the third kind because a path-only anchor has no range to check and inventing one would be
 * a fake precision that rots on its own. The two shapes are cross-checked: a `current` entry whose anchor has
 * no line range, or a `current-file` entry whose anchor has one, is itself a failure.
 */

const DOC = resolve("docs/layering.md");

type Classification =
  /** Live claim about code. The anchor supplies the file and the line range; `expect` is what must be in them. */
  | { kind: "current"; expect: string }
  /** Live reference to a file with no line range: it must exist. */
  | { kind: "current-file" }
  /** A location as it was. Kept as provenance, deliberately not chased. */
  | { kind: "historical"; why: string };

/**
 * The total classification. Keys are anchors in NORMALIZED form (`path:line` or `path:lo-hi`), which is what the
 * extractor produces — including continuation spans (`` `run.ts:1542`、`:1470` ``), where the second span
 * inherits the first's path. Normalising before classifying is the point: a regex that only matched fully
 * qualified anchors quietly skipped every continuation, and a skipped anchor is an unchecked anchor.
 */
const ANCHORS: Record<string, Classification> = {
  // --- layer 1's ledger, layers 7 and 8, the epoch model -----------------------------------------------------
  "snapshot.ts:213": { kind: "historical", why: "the pre-57B-418 line where an unregistered extension never became a candidate; the document says 修之前 and keeps it as provenance" },
  "src/snapshot/source.ts:29": { kind: "current", expect: "export function windowCacheVersion" },
  "src/base/assurance-version.ts:91": { kind: "current", expect: "export function runUsesCurrentAssurance" },
  "src/run/stages/investigation-stage.ts:35": { kind: "current", expect: "plan.items.some((item) => item.id === normalized.workItemId)" },
  "src/crossrepo/link-match.ts:42": { kind: "current", expect: "export interface MatchedLink" },
  "src/run/run.ts:360": { kind: "current", expect: "createInvestigationPlan(runId, effectiveRequest, documents)" },
  // The two-bucket ruling on "the read did not happen": the demand arithmetic and the module whose advisory
  // policy the ruling aligns with. Cited by file, so the citation cannot rot on a line.
  "src/investigation/read-budget.ts": { kind: "current-file" },
  "src/investigation/read-coverage.ts": { kind: "current-file" },

  // --- §二: the seven edges, as a landing record --------------------------------------------------------------
  // The "before" column is where each violating import USED to sit. Several of those line numbers now happen to
  // hold the post-move import instead, which is exactly why they are not chased: the record is about what was
  // moved, and re-pointing it at today's line would turn a history into a false present-tense claim.
  "src/snapshot/providers.ts:6": { kind: "historical", why: "the upward import into codegraph/module-detection, before the module moved down to layer 1" },
  "src/codegraph/codegraph-command.ts:4": { kind: "historical", why: "the import that reached into snapshot/providers for executableAvailable, before it moved to the base" },
  "src/context/boundary-functions.ts:26": { kind: "historical", why: "the upward import into assurance/decision-probe, before the three probes moved down to layer 3" },
  "src/crossrepo/frontend-calls.ts:21": { kind: "historical", why: "same edge as #3, before the probes moved" },
  "src/crossrepo/route-table.ts:25": { kind: "historical", why: "same edge as #3, before the probes moved" },
  "src/core/types.ts:1-4": { kind: "historical", why: "the four upward imports the base carried for PreparedContext; src/core/ no longer exists" },
  "src/core/run.ts": { kind: "historical", why: "the false layer: run.ts sat in the same directory as the base's types; src/core/ was dissolved" },
  "src/assurance/parallel-authoring.ts:7": { kind: "historical", why: "the report side reaching up into run.ts for the checkpoint machinery, before it moved to checkpoint.ts" },
  "src/snapshot/module-detection.ts": { kind: "current-file" },
  "src/base/executable.ts": { kind: "current-file" },
  "src/context/context.ts": { kind: "current-file" },
  // The layer-5 forbidden-input violation the contract now states instead of claiming it was already fixed.
  "src/context/context.ts:174": { kind: "current", expect: "new SourceReader({" },
  "src/report/checkpoint.ts": { kind: "current-file" },
  "src/base/assurance-version.ts": { kind: "current-file" },
  "src/report/section-audit.ts": { kind: "current-file" },
  "src/investigation/investigation-artifacts.ts": { kind: "current-file" },
  "src/investigation/assurance.ts": { kind: "current-file" },
  "src/report/assurance-artifacts.ts": { kind: "current-file" },

  // --- §二: the instruments themselves -----------------------------------------------------------------------
  "tests/layering-anchors.test.ts": { kind: "current-file" },
  "tests/layer-order.test.ts": { kind: "current-file" },
  "tests/layering-registry.ts": { kind: "current-file" },
  "tests/search-corpus.test.ts:17": { kind: "current", expect: "every scanned text extension is a member of the content-search corpus" },
  "tests/artifact-result-single-definition.test.ts": { kind: "current-file" },
  "src/base/artifact-result.ts": { kind: "current-file" },
  "tests/interface-laws.compile.ts": { kind: "current-file" },
  "tests/artifact-registry-coverage.test.ts": { kind: "current-file" },
  "src/base/row-set.ts": { kind: "current-file" },
  "src/base/conservation.ts": { kind: "current-file" },

  // --- §四 the four laws ------------------------------------------------------------------------------------
  "src/base/timeline.ts:18-19": { kind: "historical", why: "the pre-57B-430 full-history read on every timeline append; the document explicitly says 57B-430 前" },
  "src/base/single-writer.ts:28-50": { kind: "current", expect: "export async function withRunWriter" },
  "src/investigation/evidence-store.ts:129-145": { kind: "current", expect: "export async function appendEvidence" },
  "src/report/unit-collect.ts:115-120": { kind: "current", expect: "view.collectionOrder.filter" },
  "src/run/stages/investigation-stage.ts:152": { kind: "historical", why: "the pre-57B-430 full-catalog normalize-and-hash on each evidence append; the document explicitly says 57B-430 前" },
  "src/workset/factpack-view.ts:54": { kind: "current", expect: "maxRowsPerCategory = 60" },

  // --- §五 P1-P18 -------------------------------------------------------------------------------------------
  "src/workset/census.ts:95": { kind: "current", expect: "export function buildScopeCensus" },
  "snapshot.ts:211": { kind: "historical", why: "P13's provenance: the pre-57B-418 scan loop, kept because the document says so explicitly" },
  "snapshot.ts:215": { kind: "historical", why: "P13's provenance: the silent path-escape continue" },
  "snapshot.ts:218": { kind: "historical", why: "P13's provenance: the silent irregular-file/symlink/oversize continue" },
  "snapshot.ts:226": { kind: "historical", why: "P13's provenance: the silent lstat-failure continue" },
  "snapshot.ts:238": { kind: "historical", why: "P13's provenance: the break that could drop a whole root" },
  "src/obligation/read-obligations.ts:258": { kind: "current", expect: 'if (fn.probe !== "decision") continue;' },
  "src/obligation/declarations.ts:93": { kind: "current", expect: "export function buildObligationDeclarations" },
  "src/attribution/allocator.ts": { kind: "current-file" },
  "eval/fixtures/allocator/preregistration-v1.json": { kind: "current-file" },
  "src/context/factpack.ts:230": { kind: "current", expect: "export async function buildFactPack" },
  "src/workset/factpack-annotate.ts:38-58": { kind: "current", expect: "export function annotateFactPack" },
  "src/workset/factpack-view.ts:6-22": { kind: "current", expect: "consumableFactPackItems" },

  // --- §六 explicitly undecided ------------------------------------------------------------------------------
  "src/facts/probe/condition-extract.ts:47-55": { kind: "current", expect: "AST_LANGUAGE_BY_EXTENSION" },
  "src/facts/probe/decision-probe.ts:52-55": { kind: "current", expect: 'return "unavailable"' },

  // --- §六 已落地: the five 57B-421 pinned, cited by file so the citation cannot rot on a line ---------------
  "src/facts/units/unit-identity.ts": { kind: "current-file" },
  "src/facts/units/membership-map.ts": { kind: "current-file" },
  "src/base/fact-kind-registry.ts": { kind: "current-file" },
  "src/base/partition-designation.ts": { kind: "current-file" }
};

interface Anchor {
  /** Normalized `path` or `path:lines`. */
  readonly id: string;
  readonly path: string;
  /** `null` for a path-only anchor. */
  readonly lines: { readonly lo: number; readonly hi: number } | null;
  /** Document line, so a failure says where to edit. */
  readonly docLine: number;
}

export interface Extraction {
  readonly anchors: readonly Anchor[];
  /** Lines whose inline backticks do not pair. Non-empty means the extractor cannot be trusted on this document. */
  readonly unbalanced: readonly string[];
}

const PATH_SPAN = /^([A-Za-z0-9_./-]+\.(?:ts|md|json|jsonl))(?::(\d+(?:-\d+)?))?$/;
const CONTINUATION = /^:(\d+(?:-\d+)?)$/;
/** A span with no line range is an anchor only if it names a path from the repo root; `files.json` is prose. */
const REPO_ROOTED = ["src/", "tests/", "docs/", "packages/", "eval/", "skills/"];

/**
 * Pull every anchor out of the document.
 *
 * Two things here were learned by getting them wrong. FENCED BLOCKS are dropped first: a ``` fence's backticks
 * shift the parity of every inline span after it, and the first version of this extractor silently stopped
 * finding anchors a third of the way down the file while still reporting a plausible count. And a line whose
 * inline backticks do not pair is reported rather than parsed, because that is the same failure returning by
 * another route.
 *
 * CONTINUATION spans are resolved against the last path seen in document order, so `` `run.ts:1542`、`:1470` ``
 * yields two fully qualified anchors. Skipping them was the other silent miss.
 */
export function extractAnchors(markdown: string): Extraction {
  const anchors: Anchor[] = [];
  const unbalanced: string[] = [];
  let inFence = false;
  let lastPath: string | null = null;
  markdown.split(/\r?\n/).forEach((line, index) => {
    const docLine = index + 1;
    if (line.startsWith("```")) { inFence = !inFence; return; }
    if (inFence) return;
    if ((line.match(/`/g) ?? []).length % 2 !== 0) {
      unbalanced.push(`docs/layering.md:${docLine}: inline backticks do not pair, so every span after it may be misread`);
      return;
    }
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const span = match[1]!.trim();
      const path = PATH_SPAN.exec(span);
      if (path) {
        lastPath = path[1]!;
        if (path[2]) anchors.push(makeAnchor(path[1]!, path[2], docLine));
        else if (REPO_ROOTED.some((prefix) => path[1]!.startsWith(prefix))) anchors.push({ id: path[1]!, path: path[1]!, lines: null, docLine });
        continue;
      }
      const continuation = CONTINUATION.exec(span);
      if (continuation && lastPath) anchors.push(makeAnchor(lastPath, continuation[1]!, docLine));
    }
  });
  return { anchors, unbalanced };
}

function makeAnchor(path: string, range: string, docLine: number): Anchor {
  const parts = range.split("-").map(Number);
  return { id: `${path}:${range}`, path, lines: { lo: parts[0]!, hi: parts[parts.length - 1]! }, docLine };
}

async function extraction(): Promise<Extraction> {
  return extractAnchors(await readFile(DOC, "utf8"));
}

test("the anchor extractor can be trusted before its answers are: fences dropped, backticks paired, enough found", async () => {
  const { anchors, unbalanced } = await extraction();
  assert.deepEqual(unbalanced, []);
  // The instrument prior. The count is a floor, not a pin: a regex that stops matching (which is exactly what a
  // stray fence did) must go red rather than report a clean, short, plausible list.
  assert.ok(anchors.length > 40, `expected the whole document's anchors, got ${anchors.length}`);
  assert.ok(anchors.some((anchor) => anchor.lines !== null), "and anchors with line ranges among them");
});

test("the extractor resolves a continuation span against the path before it", () => {
  const { anchors } = extractAnchors("两函数（`src/run/run.ts:1542`、`:1470`）随 #6 同批下移。\n");
  assert.deepEqual(anchors.map((anchor) => anchor.id), ["src/run/run.ts:1542", "src/run/run.ts:1470"]);
});

test("the extractor ignores what is inside a fence, and reports an unpaired backtick instead of guessing", () => {
  const fenced = ["前言 `src/base/util.ts:1`", "```", "src/never/parsed.ts:99 `src/also/not.ts:5`", "```", "后记 `src/base/types.ts:2`"].join("\n");
  assert.deepEqual(extractAnchors(fenced).anchors.map((anchor) => anchor.id), ["src/base/util.ts:1", "src/base/types.ts:2"]);
  const odd = extractAnchors("一处 `src/base/util.ts:1` 与一个漏掉的反引号 `src/base/types.ts:2\n");
  assert.equal(odd.anchors.length, 0);
  assert.match(odd.unbalanced[0]!, /backticks do not pair/);
});

test("a bare artifact name in prose is not an anchor, but a repo-rooted path is", () => {
  const { anchors } = extractAnchors("`files.json` 与 `run.ts` 是散文；`src/base/util.ts` 与 `tests/helpers.ts` 是锚点。\n");
  assert.deepEqual(anchors.map((anchor) => anchor.id), ["src/base/util.ts", "tests/helpers.ts"]);
});

test("every anchor in the contract is classified, and every classification is still in the contract", async () => {
  const { anchors } = await extraction();
  const found = new Set(anchors.map((anchor) => anchor.id));
  const unclassified = [...found].filter((id) => !(id in ANCHORS)).sort();
  assert.deepEqual(unclassified, [],
    "a new anchor must be classified current / current-file / historical before it is written; there is no fourth state");
  const stale = Object.keys(ANCHORS).filter((id) => !found.has(id)).sort();
  assert.deepEqual(stale, [],
    "and a classification for an anchor the document no longer holds must go, or the list rots in the other direction");
});

test("each classification matches its anchor's shape: a line range iff the claim is about lines", async () => {
  const { anchors } = await extraction();
  const mismatched: string[] = [];
  for (const anchor of anchors) {
    // An unclassified anchor is already the previous test's failure; reporting it twice would bury the real one.
    const classification = ANCHORS[anchor.id];
    if (!classification) continue;
    if (classification.kind === "current" && anchor.lines === null) mismatched.push(`${anchor.id}: classified current but names no line range`);
    if (classification.kind === "current-file" && anchor.lines !== null) mismatched.push(`${anchor.id}: classified current-file but names lines, which are checkable`);
  }
  assert.deepEqual(mismatched, []);
});

test("every current anchor really points at what the contract says it does", async () => {
  const { anchors } = await extraction();
  const cache = new Map<string, string[] | null>();
  const rot: string[] = [];
  let checked = 0;
  for (const anchor of anchors) {
    const classification = ANCHORS[anchor.id];
    if (!classification || classification.kind === "historical") continue;
    if (!cache.has(anchor.path)) {
      cache.set(anchor.path, await readFile(resolve(anchor.path), "utf8").then((text) => text.split(/\r?\n/), () => null));
    }
    const lines = cache.get(anchor.path)!;
    if (lines === null) { rot.push(`docs/layering.md:${anchor.docLine}: ${anchor.id} — no such file`); continue; }
    checked += 1;
    if (classification.kind === "current-file") continue;
    if (anchor.lines!.hi > lines.length) {
      rot.push(`docs/layering.md:${anchor.docLine}: ${anchor.id} — the file has only ${lines.length} lines`);
      continue;
    }
    const window = lines.slice(anchor.lines!.lo - 1, anchor.lines!.hi).join("\n");
    if (!window.includes(classification.expect)) {
      rot.push(`docs/layering.md:${anchor.docLine}: ${anchor.id} no longer contains ${JSON.stringify(classification.expect)}; it now reads:\n${window}`);
    }
  }
  assert.deepEqual(rot, [], "these anchors moved — fix the document (and the classification), not this test");
  assert.ok(checked > 25, `the check must actually reach the code; it verified ${checked} anchors`);
});

test("historical anchors are a stated minority, not a place to park anything inconvenient", async () => {
  const { anchors } = await extraction();
  const historical = [...new Set(anchors.filter((anchor) => ANCHORS[anchor.id]?.kind === "historical").map((anchor) => anchor.id))];
  const live = [...new Set(anchors.map((anchor) => anchor.id))].length - historical.length;
  assert.ok(historical.length < live, `historical ${historical.length} vs live ${live}: a document that is mostly provenance is documenting the past`);
  for (const id of historical) {
    const classification = ANCHORS[id];
    assert.ok(classification?.kind === "historical" && classification.why.trim().length > 20,
      `${id} must say why it is not chased; "historical" with no reason is an allowlist entry`);
  }
});
