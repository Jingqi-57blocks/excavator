/**
 * Deterministic, verbatim description injection.
 *
 * A descriptions file maps `table name → one business-purpose sentence`:
 *
 *   { "wcp_leave": "Leave requests submitted by employees.", "app_user": "Application accounts." }
 *
 * The sentences are authored by a separate skill/authoring step (Core stays zero-model); this layer
 * only injects them verbatim onto the matching `TableSchema.description`, with two hard safety checks:
 *
 *   - a key that is NOT an extracted table name is rejected (ERROR). A description can only annotate a
 *     table the deterministic extractor actually recovered, so an authoring step cannot smuggle in a
 *     hallucinated table.
 *   - a value containing a newline is rejected (ERROR). A description is one line; a multi-line value
 *     would break the byte-stable single-line table description and hide arbitrary content.
 *
 * Tables with no provided description are left untouched — the renderer supplies a fixed placeholder.
 */

import type { SchemaExtraction } from "./types.ts";

/** Inject descriptions in place, or throw on the first unknown-table key or newline value. */
export function injectDescriptions(extraction: SchemaExtraction, descriptions: Record<string, string>): void {
  const tableNames = new Set(extraction.tables.map((table) => table.name));

  for (const [key, value] of Object.entries(descriptions)) {
    if (!tableNames.has(key)) {
      throw new Error(`Description references unknown table "${key}"; only extracted table names are allowed.`);
    }
    if (typeof value !== "string") {
      throw new Error(`Description for "${key}" must be a string.`);
    }
    if (/[\r\n]/.test(value)) {
      throw new Error(`Description for "${key}" contains a newline; a table description must be a single line.`);
    }
  }

  for (const table of extraction.tables) {
    const value = descriptions[table.name];
    if (value !== undefined) table.description = value;
  }
}
