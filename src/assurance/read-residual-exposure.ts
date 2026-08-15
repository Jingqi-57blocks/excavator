// READ RESIDUAL EXPOSURE — put the strong partition in front of someone who can still act on it.
//
// WHY THIS MODULE EXISTS. S1.5 made the not-opened reading honest by splitting it four ways, and the split
// was mechanically verified: the `retained`/`named`/`in-directory` partitions are 92.9% real misses, while
// `unclassified` is 84.1% denominator noise. But measured on the real run that produced those numbers, the
// partition reached nobody who could use it: `read residual`, `not opened` and `阅读义务` appear ZERO times
// in that run's `prompts/` and `context/authoring/`, while the condition inventory — which IS rendered into
// the packet — appears in both. The only channel was two aggregate lines on freeze's stdout plus a pointer
// to a JSON file. A reading nobody reads changes no reading.
//
// This is the same lesson 57B-394 already paid for on the condition inventory: measuring without
// intervening does not make the product better (`authoring-packet.ts:288-293` records that reasoning). The
// difference is WHERE the intervention lands, and that is a mechanism question, not a wording one:
//
//   - Before freeze, opening a window is ordinary investigation. `excavator reading` renders this list
//     there, at zero friction, which is also the first time SKILL's standing instruction ("clear the ones
//     that matter before freezing") is executable at all — obligations were previously computed ONLY at
//     freeze, so the advisory arrived at the exact moment it became expensive.
//   - After freeze, every window costs a supplement (measured: `supplements: 0` across the whole baseline
//     run). So the packet block deliberately does NOT ask for windows. It states a boundary, so the
//     document is written with its blind spots in view.
//
// WHY NOTHING COUNTS THIS. The condition inventory arrived in the packet WITH an audit residual, and the
// author paid the Goodhart tax in public: a sentence of near-zero reader value ("按提交时的动作值是否为
// `next` 决定跳到下一单") written only to drive `unaccounted` from 18 to 1. So no finding, no gate, and no
// counter is attached to anything here — not even "was the command run". The Goodhart detector already
// exists and needs no extension: `openedNotConsumed` (`read-coverage.ts:9-13`) rises exactly when exposure
// induces drive-by reads.
//
// Pure: zero I/O, zero model call, byte-stable ordering. The grouping is shared by both renderers, so the
// console and the packet can never disagree about what the residual says.

import type { ReadCoverageItem } from "./read-coverage.ts";
import type { ReadObligation } from "./read-obligations.ts";

/** Which partition put a function on this list. Mirrors `attributionPartitions` naming in read-coverage.ts. */
export type ExposurePartition = "retained" | "named" | "in-directory";

/** Ceilings for the packet block: it is one block inside a document's context, not the artifact itself. */
const PACKET_MAX_FILES = 30;
const PACKET_MAX_FUNCTIONS_PER_FILE = 5;
/** The console is the acting surface, so it truncates later and never truncates a file's spans. */
const CHECK_MAX_FILES = 50;
const CHECK_MAX_UNCLASSIFIED_FILES = 10;

export interface ExposureFunction {
  name: string;
  startLine: number;
  endLine?: number;
  unreadLines: number;
  partition: ExposurePartition;
}

export interface ExposureFile {
  path: string;
  /** Unread lines summed over this file's listed functions — the ranking key. */
  unreadLines: number;
  functions: ExposureFunction[];
}

/** One file's worth of the partition nothing could place: counted and named, never expanded. */
export interface UnclassifiedFile {
  path: string;
  count: number;
  unreadLines: number;
}

export interface ReadingExposure {
  /**
   * False when the run carries no anchor labels. There is then no strong partition to steer by, and this
   * module says so rather than inventing one out of `kind` alone — a run frozen before the labels existed
   * must read exactly as it did then, the same discipline `attributionPartitions` follows.
   */
  annotated: boolean;
  files: ExposureFile[];
  totals: { functions: number; files: number; unreadLines: number; retained: number; named: number; inDirectory: number };
  unclassified: { count: number; unreadLines: number; files: UnclassifiedFile[] };
}

export interface ReadingExposureInput {
  /** The frozen (or, before freeze, the just-derived) denominator — the source of `kind` and `featureKey`. */
  obligations: ReadObligation[];
  /** Reconciled coverage items; only `not-opened` ones can appear here. */
  items: ReadCoverageItem[];
  /** Whether the obligations were relevance-annotated. Explicit for the same reason as in read-coverage. */
  annotated: boolean;
  /** Restrict to one feature, as the packet does. Omitted for the whole run, as the console does. */
  featureKey?: string;
}

/**
 * Group the never-opened obligations by file, strongest partition first.
 *
 * `kind` and `anchorHit` are read from the OBLIGATION, never from the coverage item: audit legitimately
 * omits both from an un-annotated run's residual, so a reader that took them from there would silently
 * report a smaller partition than the run actually has (measured on the baseline run: 84 instead of 99).
 */
export function readingExposure(input: ReadingExposureInput): ReadingExposure {
  const byId = new Map(input.obligations.map((obligation) => [obligation.id, obligation]));
  const strongByFile = new Map<string, ExposureFunction[]>();
  const unclassifiedByFile = new Map<string, UnclassifiedFile>();
  const totals = { functions: 0, files: 0, unreadLines: 0, retained: 0, named: 0, inDirectory: 0 };

  for (const item of input.items) {
    if (item.status !== "not-opened") continue;
    const obligation = byId.get(item.id);
    if (!obligation) continue;
    if (input.featureKey !== undefined && obligation.featureKey !== input.featureKey) continue;
    const partition = partitionOf(obligation);
    if (!partition) {
      const entry = unclassifiedByFile.get(item.path) ?? { path: item.path, count: 0, unreadLines: 0 };
      entry.count += 1;
      entry.unreadLines += item.uncoveredLines;
      unclassifiedByFile.set(item.path, entry);
      continue;
    }
    const list = strongByFile.get(item.path) ?? [];
    list.push({ name: item.name, startLine: item.startLine, endLine: item.endLine, unreadLines: item.uncoveredLines, partition });
    strongByFile.set(item.path, list);
    totals.functions += 1;
    totals.unreadLines += item.uncoveredLines;
    if (partition === "retained") totals.retained += 1;
    else if (partition === "named") totals.named += 1;
    else totals.inDirectory += 1;
  }

  const files: ExposureFile[] = [...strongByFile.entries()]
    .map(([path, functions]) => ({
      path,
      unreadLines: functions.reduce((sum, entry) => sum + entry.unreadLines, 0),
      functions: functions.sort((a, b) => b.unreadLines - a.unreadLines || a.startLine - b.startLine || cmp(a.name, b.name)),
    }))
    .sort((a, b) => b.unreadLines - a.unreadLines || cmp(a.path, b.path));
  totals.files = files.length;

  const unclassifiedFiles = [...unclassifiedByFile.values()].sort((a, b) => b.unreadLines - a.unreadLines || cmp(a.path, b.path));
  return {
    annotated: input.annotated,
    files,
    totals,
    unclassified: {
      count: unclassifiedFiles.reduce((sum, entry) => sum + entry.count, 0),
      unreadLines: unclassifiedFiles.reduce((sum, entry) => sum + entry.unreadLines, 0),
      files: unclassifiedFiles,
    },
  };
}

/**
 * The console rendering, for the pre-freeze check. It answers a direct question, so an empty result is
 * PRINTED rather than omitted — silence in reply to a query reads as a malfunction, which is the opposite
 * of the empty-advisory rule that governs the packet block.
 */
export function renderReadingCheck(exposure: ReadingExposure, options: { frozen: boolean }): string {
  const lines = ["Read residual — decision code inside this feature's boundary that no source window covers yet."];
  if (!exposure.annotated) {
    lines.push(
      "This run carries no anchor labels, so it has no feature-associated partition to steer by. The undivided",
      "not-opened count is reported by freeze and audit; coverage/read-residual.json carries it per obligation.",
    );
    return lines.join("\n");
  }
  lines.push(options.frozen
    ? "This run is frozen: the denominator below is the frozen one, and opening a window now requires --supplement-reason and --supplement-workitem."
    : "This run is not frozen: opening a window is still ordinary investigation (`excavator source`, no supplement needed).");
  lines.push(
    "This list is ranked by unread weight so you can decide where reading is worth buying — it is an investment",
    "aid, not a quota. Open the files you judge heavy enough to hide reportable behavior; leaving the rest unread",
    "is the normal outcome, and nothing counts how many entries you clear.",
  );
  if (!exposure.totals.functions) {
    lines.push("", "No feature-associated read residual: every strong-partition obligation has at least one window.");
  } else {
    lines.push("", headline(exposure));
    for (const file of exposure.files.slice(0, CHECK_MAX_FILES)) {
      lines.push("", `${file.path} — ${file.functions.length} function${file.functions.length === 1 ? "" : "s"}, ${file.unreadLines} unread line${file.unreadLines === 1 ? "" : "s"}`);
      for (const entry of file.functions) lines.push(`  ${entry.name} — ${span(entry)} (${entry.partition})`);
    }
    const hiddenFiles = exposure.files.slice(CHECK_MAX_FILES);
    if (hiddenFiles.length) lines.push("", `… ${hiddenFiles.length} more file(s) (${sumLines(hiddenFiles)} unread lines) not shown.`);
  }
  if (exposure.unclassified.count) {
    lines.push(
      "",
      `A further ${exposure.unclassified.count} never-opened function${exposure.unclassified.count === 1 ? "" : "s"} (${exposure.unclassified.unreadLines} line(s)) carry none of this feature's vocabulary.`,
      "Often that is code merely sharing a file with the feature — but not provably, so it is listed per file",
      "rather than dismissed. Spans are in coverage/read-residual.json once this run is frozen.",
    );
    for (const file of exposure.unclassified.files.slice(0, CHECK_MAX_UNCLASSIFIED_FILES)) {
      lines.push(`  ${file.path} — ${file.count} function${file.count === 1 ? "" : "s"}, ${file.unreadLines} unread line${file.unreadLines === 1 ? "" : "s"}`);
    }
    const hidden = exposure.unclassified.files.slice(CHECK_MAX_UNCLASSIFIED_FILES);
    if (hidden.length) lines.push(`  … ${hidden.length} more file(s) (${hidden.reduce((sum, file) => sum + file.unreadLines, 0)} unread lines) not shown.`);
  }
  return lines.join("\n");
}

/**
 * The authoring-packet block. It states a boundary and asks for nothing: the packet is read AFTER freeze,
 * where every window costs a supplement, so a block that asked for windows would be asking the author to
 * pay the highest available price — and one that asked for a sentence per entry would reproduce exactly the
 * Goodhart the condition inventory already demonstrated.
 *
 * Empty means absent: an advisory block that renders when there is nothing to say trains people to skip
 * advisory blocks (the rule `tests/read-coverage-attribution.test.ts:88` pins for the audit advisory).
 */
export function renderReadingBoundary(exposure: ReadingExposure): string {
  if (!exposure.annotated || !exposure.totals.functions) return "";
  const lines = ["## Reading boundary — feature-associated decision code never opened"];
  lines.push(
    "The investigation frozen behind this packet never opened these functions, although they sit inside this " +
    "feature's boundary or carry its vocabulary. Nothing is known about their contents — that is what this block " +
    "records. It exists so the document is written with its blind spots in view: where a section touches an area " +
    "listed here, state what was verified rather than speculating about what was never read. Do not answer this " +
    "list item by item, do not mention it in the report, and do not open windows merely to shorten it — an " +
    "opened-but-uncited window is recorded as a drive-by read, and no audit counts anything in this block. If, " +
    "while writing, one of these files becomes genuinely necessary, open it with `excavator source` using " +
    "--supplement-reason and --supplement-workitem.",
  );
  lines.push("", headline(exposure));
  for (const file of exposure.files.slice(0, PACKET_MAX_FILES)) {
    lines.push(`- \`${file.path}\` — ${file.functions.length} function${file.functions.length === 1 ? "" : "s"}, ${file.unreadLines} unread line${file.unreadLines === 1 ? "" : "s"}`);
    for (const entry of file.functions.slice(0, PACKET_MAX_FUNCTIONS_PER_FILE)) {
      lines.push(`  - \`${entry.name}\` — ${span(entry)} (${entry.partition})`);
    }
    const hidden = file.functions.length - Math.min(file.functions.length, PACKET_MAX_FUNCTIONS_PER_FILE);
    if (hidden > 0) lines.push(`  - … ${hidden} more in this file, in coverage/read-residual.json`);
  }
  const hiddenFiles = exposure.files.slice(PACKET_MAX_FILES);
  if (hiddenFiles.length) lines.push(`- … ${hiddenFiles.length} more file(s) (${sumLines(hiddenFiles)} unread lines) in coverage/read-residual.json`);
  if (exposure.unclassified.count) {
    lines.push(
      "",
      `A further ${exposure.unclassified.count} never-opened function${exposure.unclassified.count === 1 ? "" : "s"} ` +
      `(${exposure.unclassified.unreadLines} line(s)) carry none of this feature's vocabulary and are not listed here — ` +
      "mostly, but not provably, code that shares files with this feature; coverage/read-residual.json lists them per file.",
    );
  }
  return lines.join("\n");
}

// --- pure helpers ---

/**
 * `retained` before the anchor partitions, name before path — the same precedence and the same words the
 * audit advisory uses, so the two readings of one run cannot appear to disagree.
 */
function partitionOf(obligation: ReadObligation): ExposurePartition | undefined {
  if (obligation.kind === "decision-function") return "retained";
  if (obligation.anchorHit === "name") return "named";
  if (obligation.anchorHit === "path") return "in-directory";
  return undefined;
}

/** The totals precede any truncation, so a capped list still states the full size it was cut from. */
function headline(exposure: ReadingExposure): string {
  const { functions, files, unreadLines, retained, named, inDirectory } = exposure.totals;
  return `${functions} function${functions === 1 ? "" : "s"} across ${files} file${files === 1 ? "" : "s"}, ` +
    `${unreadLines} unread line${unreadLines === 1 ? "" : "s"} — retained ${retained}, named ${named}, in-directory ${inDirectory}.`;
}

function span(entry: ExposureFunction): string {
  return entry.endLine !== undefined && entry.endLine !== entry.startLine
    ? `lines ${entry.startLine}-${entry.endLine}`
    : `line ${entry.startLine}`;
}

function sumLines(files: ExposureFile[]): number {
  return files.reduce((sum, file) => sum + file.unreadLines, 0);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
