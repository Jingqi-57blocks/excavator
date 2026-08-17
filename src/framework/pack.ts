/**
 * The pluggable framework-pack contract.
 *
 * Each pack recognizes ONE framework's conventions and normalizes them into the shared model
 * (components + routes). Adding a framework is a new pack file plus one line in `PACKS` — the same
 * open/closed shape the DB schema parsers use. Packs are pure over the in-memory source text they are
 * given (no disk access), so they are deterministic and unit-testable with synthetic fixtures.
 */

import type { FrameworkPack } from "./types.ts";
import { catalystPack } from "./catalyst.ts";

/** The registry. One line per framework. */
export const PACKS: FrameworkPack[] = [catalystPack];
