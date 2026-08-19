import { canonicalJson } from "../../src/base/util.ts";
import type { BaselineProjection } from "./projection.ts";

export interface BaselineDiff {
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/**
 * Field-level differences between a pinned projection and a fresh one.
 *
 * A bare "bytes differ" is useless here: the projection is thousands of lines, and every later slice of 57B-416
 * is supposed to move some of it. What the reviewer needs is WHICH rows moved, so the PR can argue that the
 * movement is the intended one. That argument is the deliverable; the byte equality is only its evidence.
 */
export function diffBaseline(expected: unknown, actual: unknown, path = ""): BaselineDiff[] {
  if (canonicalJson(expected) === canonicalJson(actual)) return [];

  const bothArrays = Array.isArray(expected) && Array.isArray(actual);
  const bothObjects = !bothArrays && expected !== null && actual !== null
    && typeof expected === "object" && typeof actual === "object";

  if (bothArrays) {
    const diffs: BaselineDiff[] = [];
    for (let index = 0; index < Math.max(expected.length, actual.length); index += 1) {
      diffs.push(...diffBaseline(expected[index], actual[index], `${path}[${index}]`));
    }
    return diffs;
  }
  if (bothObjects) {
    const diffs: BaselineDiff[] = [];
    const keys = [...new Set([...Object.keys(expected as object), ...Object.keys(actual as object)])].sort();
    for (const key of keys) {
      diffs.push(...diffBaseline(
        (expected as Record<string, unknown>)[key],
        (actual as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key
      ));
    }
    return diffs;
  }
  return [{ path: path || "(root)", expected, actual }];
}

/** Human-readable diff, capped: a projection that moved wholesale must not bury the first real cause. */
export function renderDiff(diffs: readonly BaselineDiff[], limit = 40): string {
  const shown = diffs.slice(0, limit).map((diff) =>
    `  ${diff.path}\n    expected: ${JSON.stringify(diff.expected)?.slice(0, 160)}\n    actual:   ${JSON.stringify(diff.actual)?.slice(0, 160)}`);
  const rest = diffs.length - shown.length;
  return `${shown.join("\n")}${rest > 0 ? `\n  … ${rest} more differing field(s)` : ""}`;
}

export function baselineMatches(expected: BaselineProjection, actual: BaselineProjection): boolean {
  return canonicalJson(expected) === canonicalJson(actual);
}
