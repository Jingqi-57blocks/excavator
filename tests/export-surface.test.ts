import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

/**
 * No `src/` function is exported to nobody, and the list of ones exported to nothing but their own file cannot
 * grow without an edit here.
 *
 * WHY THE COMPILER CANNOT DO THIS. `noUnusedLocals` (57B-492) catches a FILE-INTERNAL orphan and nothing else:
 * the moment a symbol carries `export`, TypeScript stops asking whether anyone wants it. So the export keyword
 * is a way to make dead code compile — measured on this tree at 57B-481, EIGHT exported functions had no
 * mention anywhere in `src/`, `tests/`, `eval/` or `packages/`, including `requireBuilt`, which no caller had
 * ever had. They were deleted in that slice; this test is what stops the ninth from arriving unnoticed.
 *
 * THE CENSUS IS TOTAL AND HAS THREE BUCKETS, so nothing falls through:
 *   - REACHED — some file other than its own mentions it. Fine, and the overwhelming majority.
 *   - INNER-ONLY — only its own file mentions it. Not dead code: the body runs. The `export` is surface with no
 *     reader, which is a smaller defect and a real one, because it makes the module's contract wider than its
 *     contract. Frozen below rather than fixed: narrowing one is a judgement about that module's API and gets
 *     made module by module, not in a sweep.
 *   - DEAD — not mentioned even by its own file. Asserted EMPTY, with no registry: there is no reason to keep
 *     one, so the fix is always deletion and never a line here.
 *
 * DELIBERATELY CONSERVATIVE, so a flagged symbol is never a false alarm. "Mentions" is a WORD MATCH over the
 * file's whole text, comments included — a symbol named only in a doc comment counts as reached. The test
 * therefore UNDER-reports, and a red is a fact rather than a parse artefact. The direction that matters is the
 * one it cannot get wrong: a function nothing anywhere names is dead however generously you read the tree.
 */

const ROOT = resolve(import.meta.dirname, "..");
const SCANNED = ["src", "tests", "eval", "packages"];
/**
 * This file is excluded from its own corpus, and that is not a convenience. The registry below NAMES every
 * inner-only symbol, so a scan that read this file would find each of them "mentioned elsewhere" and report an
 * empty set — the registry would make itself true. Measured while writing it: with this file in the corpus the
 * inner-only bucket came out empty against a 25-entry list.
 */
const SELF = resolve(import.meta.dirname, "export-surface.test.ts");
const EXPORTED_FUNCTION = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
const WORD = /[A-Za-z_$][\w$]*/g;

/** A regex that stops matching would make every bucket empty and every assertion below vacuously green. */
const MINIMUM_EXPORTED_FUNCTIONS = 500;

/**
 * Exported, and mentioned by nothing but the file that declares it. Measured at 57B-481, after the section
 * authoring path was deleted. To change it: narrow the export (drop the keyword) and delete the line, or add a
 * line when a new one is deliberate — never edit it to make a red go away without doing one of those two.
 */
const INNER_ONLY: readonly string[] = [
  // src/base/single-writer.ts
  "checkpointPath",
  // src/codegraph/codegraph-command.ts
  "installationInstructions",
  // src/crossrepo/crossrepo-artifact.ts
  "linkId",
  // src/facts/units/membership-map.ts
  "kindClass",
  // src/investigation/read-residual-exposure.ts
  "absentReadingCoverageStatement",
  "readingCoverageStatement",
  // src/report/plan-obligation-conservation.ts
  "dispositionEffect",
  // src/report/plan-revision.ts
  "assertRevisionSupersedes",
  // src/report/topic-disposition.ts
  "parseTopicDisposition",
  // src/report/unit-claim-binding-source.ts
  "readUnitClaimBinding",
  // src/report/unit-document-anchors.ts
  "headingSlugVariants",
  "withoutCode",
  // src/report/unit-grounding-audit.ts
  "bindingDisagreements",
  "groundingRequirementClause",
  // src/report/unit-status.ts
  "describeSupersededUnit",
  "unitStateCensus",
  // src/schema/parsers/js-scan.ts
  "scanBalanced",
  "skipJsComment",
  // src/schema/parsers/sequelize-field.ts
  "normalizeSequelizeType",
  // src/schema/parsers/sql-ddl.ts
  "skipSqlString",
  // src/snapshot/content-identity.ts
  "classifySample",
  // src/snapshot/snapshot.ts
  "discoverRoots",
  // src/workset/factpack-view.ts
  "factPackItemIsConsumable"
];

/**
 * Occurrences of `symbol` in `text` with comments removed.
 *
 * FAIL-CLOSED, because a stripper that eats code would turn a live export into a false "dead" report and this
 * test promises it never cries wolf: the declaration must survive the strip, or the test fails saying the
 * instrument is broken rather than saying the tree is.
 */
function countInCode(text: string, symbol: string): number {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
  assert.match(stripped, new RegExp(`function\\s+${symbol}\\b`),
    `stripping comments removed the declaration of ${symbol}; the stripper is broken, not the tree`);
  return (stripped.match(new RegExp(`\\b${symbol}\\b`, "g")) ?? []).length;
}

async function tsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await tsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

test("no exported src/ function is unreachable, and the inner-only surface is the frozen one", async () => {
  const words = new Map<string, Set<string>>();
  const declaredIn = new Map<string, Set<string>>();
  for (const scope of SCANNED) {
    for (const file of await tsFiles(join(ROOT, scope))) {
      if (file === SELF) continue;
      const text = await readFile(file, "utf8");
      words.set(file, new Set(text.match(WORD) ?? []));
      if (scope !== "src") continue;
      for (const match of text.matchAll(EXPORTED_FUNCTION)) {
        declaredIn.set(match[1], (declaredIn.get(match[1]) ?? new Set()).add(file));
      }
    }
  }
  assert.ok(declaredIn.size >= MINIMUM_EXPORTED_FUNCTIONS,
    `the extractor found only ${declaredIn.size} exported functions; it is broken, not the tree`);

  const dead: string[] = [];
  const innerOnly: string[] = [];
  for (const [symbol, homes] of [...declaredIn].sort()) {
    const elsewhere = [...words].some(([file, tokens]) => !homes.has(file) && tokens.has(symbol));
    if (elsewhere) continue;
    // Its own file names it at the declaration; a second mention IN CODE means something there uses it. Comments
    // are stripped first, and that is the whole difference between a tripwire and a loophole: a doc comment that
    // names the function it sits above is one mention, so counting comments let an export with no caller anywhere
    // score 2 and land in the registry below as "inner-only" — measured on `writeReportCompanions` and
    // `archiveCheckpoint`, which were the ninth and tenth dead exports and were deleted rather than registered.
    const mentions = (await Promise.all([...homes].map(async (home) =>
      countInCode(await readFile(home, "utf8"), symbol)))).reduce((a, b) => a + b, 0);
    const where = [...homes].map((home) => relative(ROOT, home)).sort().join(", ");
    if (mentions <= 1) dead.push(`${symbol} (${where})`);
    else innerOnly.push(symbol);
  }

  assert.deepEqual(dead, [],
    `exported functions nothing anywhere names — delete them, do not register them:\n${dead.join("\n")}`);
  assert.deepEqual(innerOnly.sort(), [...INNER_ONLY].sort());
});
