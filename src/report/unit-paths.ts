/**
 * Where one authoring unit's artifacts live — `(runDir, unitId)` and nothing else.
 *
 * A UNIT ID IS UNTRUSTED INPUT THAT BECOMES A PATH. `parsePlanProposal` requires only that a unit id be a
 * non-empty string (`plan-proposal.ts`), and a proposal is bytes a model wrote. This file is the place where
 * such a string would otherwise reach the filesystem, so it is treated as what it is: a path-traversal vector,
 * not a formatting question. Two mechanisms, both required:
 *
 *   1. NAMED REFUSAL for the shapes that are hostile no matter how they are encoded — separators, `..`,
 *      drive-relative prefixes, control characters and NUL, Windows reserved device names, names a filesystem
 *      silently rewrites (leading/trailing dot or space), and anything over the length cap. A refusal is worth
 *      more than a quiet re-encoding: the plan that produced the id is the thing that has to be fixed.
 *   2. AN ALLOWLIST ENCODING for everything else. The on-disk segment is built from `[a-z0-9-]` characters this
 *      file chose, never from bytes the caller supplied, plus a suffix of the id's own sha256. Real unit ids
 *      carry `::` (`overview-product::leaf::route`) — legal in an id, a drive/ADS separator on Windows — so the
 *      encoding has to be an allowlist rather than a blocklist.
 *
 * WHY THE DIGEST, AND WHY IT IS NOT DECORATION. The slug alone COLLAPSES: `ab::b` and `ab__b` slug identically,
 * and on a case-insensitive filesystem (APFS by default) or a normalizing one so do `XY::A` and `xy::a`, and NFC/NFD
 * spellings of the same accented id. Two units sharing one directory is a silent merge of two authored
 * documents — the identity-collapse failure that still balances every conservation check downstream, because
 * nothing that counts rows would notice one row wearing two hats. The digest is taken over the RAW id bytes and
 * rendered in lowercase hex, so it survives both case folding and Unicode normalization, and
 * `assertDistinctUnitPathKeys` states the property as a check rather than trusting it — with the key function
 * injected, so a fixture can hand it the naive slug-only encoder and see the refusal actually fire.
 *
 * EVERY PATH IS DERIVED FROM THE `runDir` THE CALLER WAS HANDED (57B-452). Nothing here reads a recorded location
 * out of `run.json`, so there is no "where this run used to live" to mistake for an instruction; a copied run
 * writes into the copy. The containment assertion at the end is the tripwire for that: if a future change to the
 * encoder ever produced a segment that climbed out of the run directory, it fails by name instead of writing
 * there.
 */

import { join, resolve } from "node:path";
import { safeRelative, sha256 } from "../base/util.ts";

/** The run-relative directory every unit artifact lives under. */
export const UNITS_DIRNAME = "units";

/** The collect-written ledger, beside the per-unit directories. Named here so no caller re-spells it. */
export const UNIT_LEDGER_FILENAME = "collected.json";

/** The longest unit id that may become a path segment. */
export const UNIT_ID_MAX_LENGTH = 200;

/** The slug half of an encoded key, before the digest suffix. */
const UNIT_SLUG_MAX_LENGTH = 48;

/** Hex characters of the id's sha256 that follow the slug. 64 bits, over the raw id bytes. */
const UNIT_DIGEST_LENGTH = 16;

/**
 * The exact shape of an encoded key: lowercase ASCII only, always ending in `-<16 hex>`.
 *
 * Asserted on every key this file produces, and it is the reason two distinct keys cannot be folded together by
 * a case-insensitive or Unicode-normalizing filesystem — there is no character in the set that folds to another.
 * It is also why `collected.json` can sit beside the per-unit directories: a key can never contain a dot.
 */
export const UNIT_PATH_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-[0-9a-f]{16}$/;

/** Windows reserved device names. A file so named is a device on Windows, whatever the extension says. */
const WINDOWS_RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`)
]);

export interface UnitPaths {
  /** The encoded directory name, for a caller that reports it without re-deriving it. */
  readonly key: string;
  readonly dir: string;
  readonly content: string;
  readonly claims: string;
  readonly summary: string;
  /** The commit marker a draft writes last and `collect` consumes. */
  readonly receipt: string;
  readonly historyDir: string;
}

/**
 * Refuse a unit id that may not become a path segment, naming the rule it broke.
 *
 * Called by `unitPathKey`, so there is no path into the encoder that skips it. Order is deliberate: the checks
 * that describe a traversal attempt come before the cosmetic ones, so the message a hostile id gets is the one
 * about traversal.
 */
export function assertUsableUnitId(unitId: string): void {
  const shown = JSON.stringify(unitId);
  if (typeof unitId !== "string" || unitId.trim() === "") {
    throw new Error(`Authoring unit id ${shown} is blank; a unit id names a directory inside the run, so it cannot be empty`);
  }
  if (unitId.length > UNIT_ID_MAX_LENGTH) {
    throw new Error(`Authoring unit id ${shown} is ${unitId.length} characters; a unit id is capped at ${UNIT_ID_MAX_LENGTH} because it becomes one path segment`);
  }
  // Matched rather than scanned by code point: a hand-rolled scan mixed a code-point index with the UTF-16 index
  // `codePointAt` takes, and reported a surrogate half of the PRECEDING character as the offending byte. A message
  // that misidentifies the character it exists to explain is worse than no message.
  const control = /[\u0000-\u001f\u007f]/.exec(unitId);
  if (control) {
    const code = control[0].codePointAt(0)!;
    throw new Error(`Authoring unit id ${shown} contains a control character (0x${code.toString(16).padStart(2, "0")} at index ${control.index}); such a byte cannot be part of a path segment`);
  }
  if (unitId.includes("/") || unitId.includes("\\")) {
    throw new Error(`Authoring unit id ${shown} contains a path separator; a unit id is one path segment, never a path`);
  }
  if (unitId === "." || unitId === "..") {
    throw new Error(`Authoring unit id ${shown} is a filesystem-relative name, not a unit id; rebasing it onto the run directory would name the run itself or its parent`);
  }
  if (unitId.includes("..")) {
    throw new Error(`Authoring unit id ${shown} contains a path traversal segment (".."); rebasing it onto the run directory would write outside the run`);
  }
  if (/^[A-Za-z]:/.test(unitId)) {
    throw new Error(`Authoring unit id ${shown} starts with a drive-relative prefix; a unit id is one path segment, never a path`);
  }
  if (WINDOWS_RESERVED_NAMES.has(unitId.split(".")[0]!.trim().toLowerCase())) {
    throw new Error(`Authoring unit id ${shown} is the Windows reserved device name ${JSON.stringify(unitId.split(".")[0]!.toUpperCase())}; a file so named is a device, not a file`);
  }
  if (/^[.\s]/.test(unitId) || /[.\s]$/.test(unitId)) {
    throw new Error(`Authoring unit id ${shown} begins or ends with a dot or a space; some filesystems rewrite such a name, so two ids could land on one directory`);
  }
}

/**
 * The directory name for one unit id: `<slug>-<digest16>`.
 *
 * The slug is for a human reading the run directory; the digest is what makes the name an identity. Distinct ids
 * therefore land in distinct directories even when their slugs are identical, which `assertDistinctUnitPathKeys`
 * states as a check over a whole plan.
 */
export function unitPathKey(unitId: string): string {
  assertUsableUnitId(unitId);
  const slug = unitId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, UNIT_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  const key = `${slug || "unit"}-${sha256(unitId).slice(0, UNIT_DIGEST_LENGTH)}`;
  // A construction assertion, not input validation: reaching it means the encoder above changed and a segment
  // the filesystem could fold, or read as a traversal, was about to be used.
  if (!UNIT_PATH_KEY_PATTERN.test(key)) {
    throw new Error(`Authoring unit id ${JSON.stringify(unitId)} encoded to ${JSON.stringify(key)}, which is not a safe path segment`);
  }
  return key;
}

/**
 * Refuse a unit id set whose members share one directory, naming both ids.
 *
 * `keyOf` is REQUIRED rather than defaulted for the reason R3's budget table is: a collapse check that can only
 * ever run against the real encoder can only ever go green, and a guard nobody has seen fire is a guard nobody
 * knows the shape of. The negative fixture hands it the slug-only encoder — the design this file rejected — and
 * watches this refusal fire on `a::b` versus `a__b`.
 */
export function assertDistinctUnitPathKeys(unitIds: readonly string[], keyOf: (unitId: string) => string): void {
  const byKey = new Map<string, string>();
  for (const unitId of [...unitIds].sort(compareUnitIds)) {
    const key = keyOf(unitId);
    const taken = byKey.get(key);
    if (taken !== undefined && taken !== unitId) {
      throw new Error(`Authoring units ${JSON.stringify(taken)} and ${JSON.stringify(unitId)} both encode to the directory ${JSON.stringify(key)}; two units in one directory is one unit wearing two identities`);
    }
    byKey.set(key, unitId);
  }
}

/**
 * The ONE order identity strings are sorted and checked in.
 *
 * NOT `localeCompare`. A collator returns 0 for strings it considers equivalent, and distinct unit ids can be
 * collate-equal — the NFC and NFD spellings of one accented id are exactly the pair this module goes to such
 * lengths to keep in separate directories. Sorting with a collator and then demanding "strictly greater than 0"
 * from the same collator is a contradiction: the writer produces a file its own validator refuses, and the run's
 * unit path is bricked by bytes it wrote itself. Code-unit order is total — distinct strings never compare 0 — so
 * one comparator can serve both sides, and it must be the same one on both sides.
 */
export function compareUnitIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The `units/` directory of one run. */
export function unitsDir(runDir: string): string {
  return join(resolve(runDir), UNITS_DIRNAME);
}

/** The collect-written unit ledger of one run. */
export function unitLedgerPath(runDir: string): string {
  return join(unitsDir(runDir), UNIT_LEDGER_FILENAME);
}

/** Every path one unit's artifacts occupy, derived from the run directory the caller was handed. */
export function unitPaths(runDir: string, unitId: string): UnitPaths {
  const root = resolve(runDir);
  const key = unitPathKey(unitId);
  const dir = join(root, UNITS_DIRNAME, key);
  const paths: UnitPaths = {
    key,
    dir,
    content: join(dir, "content.md"),
    claims: join(dir, "claims.json"),
    summary: join(dir, "summary.json"),
    receipt: join(dir, "receipt.json"),
    historyDir: join(dir, "history")
  };
  for (const path of [paths.dir, paths.content, paths.claims, paths.summary, paths.receipt, paths.historyDir]) {
    // `safeRelative` is the base's own containment primitive, with the resolve/normalise semantics already worked
    // out; a second spelling of this rule here would be a second place to fix. Only the message is local, because
    // "which unit id did this" is what makes the refusal actionable.
    try {
      safeRelative(root, path);
    } catch {
      throw new Error(`Authoring unit ${JSON.stringify(unitId)} resolves to ${JSON.stringify(path)}, which is outside the run directory ${JSON.stringify(root)}`);
    }
  }
  return paths;
}
