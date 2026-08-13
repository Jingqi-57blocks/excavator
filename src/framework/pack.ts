/**
 * The pluggable framework-pack contract.
 *
 * Each pack recognizes ONE framework's conventions and normalizes them into the shared model
 * (components + routes). Adding a framework is a new pack file plus one line in `PACKS` — the same
 * open/closed shape the DB schema parsers use. Packs are pure over the in-memory source text they are
 * given (no disk access), so they are deterministic and unit-testable with synthetic fixtures.
 */

import type { DetectedFramework, FrameworkComponent, FrameworkWarning, RouteAction, SourceText } from "./types.ts";
import { catalystPack } from "./catalyst.ts";

export interface PackResult {
  components: FrameworkComponent[];
  routes: RouteAction[];
  warnings: FrameworkWarning[];
}

export interface FrameworkPack {
  name: string;
  /** File extensions this pack cares about (lowercase, with dot), used to pre-filter the scan. */
  extensions: string[];
  /** Detect whether this framework is present; return null when it is not. Pure over `files`. */
  detect(files: SourceText[]): DetectedFramework | null;
  /** Recover components + routes by this framework's conventions. Called only when `detect` matched. */
  extract(files: SourceText[]): PackResult;
}

/** The registry. One line per framework. */
export const PACKS: FrameworkPack[] = [catalystPack];
