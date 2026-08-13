/**
 * Resolve Go `const X TableName = "physical_name"` declarations into a lookup table.
 *
 * gorm models name their physical table through a `TableName()` method that usually returns a typed
 * string constant, e.g. `return constant.TbLv.String()`. To recover the real table name without
 * running Go, we scan the given const files for `NAME [Type] = "literal"` declarations (grouped
 * `const ( ... )` blocks and single-line `const` forms) and index them by the bare const name.
 *
 * `resolveConstExpr` then normalizes a return expression back to that key: it drops a trailing
 * stringer call like `.String()` and reduces a package-qualified reference (`constant.TbLv`) to its
 * final identifier (`TbLv`). An expression that is not a known const — a raw literal, an unknown
 * name, a computed value — resolves to `null`; the caller decides what to do (record a warning),
 * because guessing a table name is exactly the fabrication this extractor must not do.
 *
 * Pure and deterministic: files are read through the injected `readFile` in sorted order, and the
 * first declaration of a given name wins (duplicate names with the same value are harmless).
 */

import type { ReadFile } from "./parser.ts";

/** One resolved `const NAME = "value"` declaration, with a back-pointer to where it was declared. */
export interface ConstEntry {
  name: string;
  value: string;
  file: string;
  line: number;
}

// `NAME [OptionalType] = "value"` — the type between name and `=` is optional (e.g. `TbLv TableName = "..."`).
// The value capture keeps escape sequences literal; table-name constants are plain identifiers in practice.
const CONST_ASSIGN = /^\s*([A-Za-z_]\w*)(?:\s+[\w.\[\]*]+)?\s*=\s*"((?:[^"\\]|\\.)*)"/;

function recordDecl(map: Map<string, ConstEntry>, text: string, file: string, line: number): void {
  const m = text.match(CONST_ASSIGN);
  if (!m) return;
  const [, name, value] = m;
  // First declaration wins → deterministic across sorted files; duplicate same-value names are harmless.
  if (!map.has(name)) map.set(name, { name, value, file, line });
}

/** Build `constName → ConstEntry` from every string-valued const declaration in the given files. */
export function buildConstMap(files: string[], readFile: ReadFile): Map<string, ConstEntry> {
  const map = new Map<string, ConstEntry>();
  for (const file of [...files].sort()) {
    const lines = readFile(file).split("\n");
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = i + 1;
      if (inBlock) {
        if (/^\s*\)/.test(raw)) inBlock = false;
        else recordDecl(map, raw, file, line);
        continue;
      }
      if (/^\s*const\s*\(/.test(raw)) {
        inBlock = true;
        continue;
      }
      const single = raw.match(/^\s*const\s+(.*)$/);
      if (single) recordDecl(map, single[1], file, line);
    }
  }
  return map;
}

/**
 * Resolve a `TableName()` return expression to its const entry, or `null` if it is not a known const.
 * Handles `constant.TbLv.String()`, `TbLv.String()`, and bare `TbLv`; anything else (literal, computed)
 * returns null so the caller can decide (literal fast-path elsewhere, warning otherwise).
 */
export function resolveConstExpr(expr: string, constMap: Map<string, ConstEntry>): ConstEntry | null {
  // Drop a trailing stringer call such as `.String()` on the typed-string const.
  const stripped = expr.trim().replace(/\.\w+\(\s*\)\s*$/, "");
  // Reduce a qualified reference to its final identifier segment (`constant.TbLv` → `TbLv`).
  const segment = stripped.split(".").pop() ?? "";
  if (!/^[A-Za-z_]\w*$/.test(segment)) return null;
  return constMap.get(segment) ?? null;
}
