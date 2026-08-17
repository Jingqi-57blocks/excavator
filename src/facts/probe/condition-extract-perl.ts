// Perl comparison extraction via tree-sitter — the second structural backend behind `condition-extract.ts`.
//
// Why a second backend at all: ast-grep has no Perl grammar (`@ast-grep/lang-perl` does not exist), and on
// Perl the regex fallback is not merely weaker, it is INERT. Its left-hand-side class accepts neither the
// `$`/`@` sigils, nor the `->` arrow, nor `{}` subscripts, so `$lv->{hours} > 16` matches nothing at all —
// a language where every variable carries a sigil scored ~0 real conditions while still reporting a
// fallback path, which a reader cannot distinguish from "this code has no rules".
//
// Why loading is asynchronous: `tree-sitter-perl` uses top-level await, so `require` refuses it outright
// ("require() cannot be used on an ESM graph with top-level await") and only dynamic `import()` works.
// Extraction itself stays synchronous, so the caller warms the parser once (`warmExtractors`) and the
// result is cached here; a platform whose native binding is missing keeps the documented degradation to
// regex instead of crashing a run.
//
// The grammar excludes comments and string bodies for free, exactly as the ast-grep path does: `# $x > 99`
// and `'text $q > 88 here'` produce no comparison node.

import type { RawComparison } from "./types.ts";

/** The minimal slice of the tree-sitter node API this module reads. */
interface PerlNode {
  type: string;
  text: string;
  startPosition: { row: number };
  childCount: number;
  child(index: number): PerlNode | null;
}

export interface PerlParser {
  parse(source: string): { rootNode: PerlNode };
}

/** Perl splits comparison into two node types; both carry `[left, operator, right]`. */
const COMPARISON_NODES = new Set(["relational_expression", "equality_expression"]);

/** Numeric and string comparison operators. `<=>` and `cmp` are ordering operators, not conditions. */
const OPERATORS = new Set([">", "<", ">=", "<=", "==", "!=", "eq", "ne", "lt", "gt", "le", "ge"]);

let cached: PerlParser | null | undefined;

/** Load the Perl parser once. Never throws: a missing native binding yields `null` and the caller degrades. */
export async function loadPerlParser(): Promise<PerlParser | null> {
  if (cached !== undefined) return cached;
  try {
    const [treeSitter, perl] = await Promise.all([import("tree-sitter"), import("tree-sitter-perl")]);
    const Parser = treeSitter.default as unknown as new () => PerlParser & { setLanguage(language: unknown): void };
    const parser = new Parser();
    parser.setLanguage(perl.default);
    cached = parser;
  } catch {
    cached = null;
  }
  return cached;
}

/** Extract every comparison against a literal in one Perl window. */
export function extractPerlComparisons(parser: PerlParser, content: string, startLine: number): RawComparison[] | null {
  let root: PerlNode;
  try {
    root = parser.parse(content).rootNode;
  } catch {
    // `null`, not `[]`: the caller must be able to tell "parsed, found nothing" from "could not parse", or
    // a failed parse would be labelled `via: "ast"` and read as a window with no rules.
    return null;
  }
  const sites: RawComparison[] = [];
  const stack: PerlNode[] = [root];
  while (stack.length) {
    const node = stack.pop() as PerlNode;
    for (let index = 0; index < node.childCount; index++) {
      const child = node.child(index);
      if (child) stack.push(child);
    }
    if (!COMPARISON_NODES.has(node.type) || node.childCount < 3) continue;
    const left = node.child(0);
    const operator = node.child(1);
    const right = node.child(2);
    if (!left || !operator || !right) continue;
    const symbol = operator.text.trim();
    if (!OPERATORS.has(symbol)) continue;
    const literal = classifyPerlLiteral(right);
    if (!literal) continue;
    sites.push({ field: left.text.trim(), operator: symbol, literal: literal.literal, literalKind: literal.kind, line: startLine + node.startPosition.row });
  }
  // Depth-first over a stack yields no useful order; sort so the artifact is byte-stable across runs.
  sites.sort((a, b) => a.line - b.line || a.field.localeCompare(b.field) || a.operator.localeCompare(b.operator) || a.literal.localeCompare(b.literal));
  return sites;
}

/** A literal is a bare number or a quoted string with nothing interpolated into it. */
function classifyPerlLiteral(node: PerlNode): { literal: string; kind: "number" | "string" } | null {
  const text = node.text.trim();
  if (node.type === "number") return /^\d+(\.\d+)?$/.test(text) ? { literal: text, kind: "number" } : null;
  if (node.type !== "string_literal" && node.type !== "interpolated_string_literal") return null;
  const quoted = /^(['"])([\s\S]*)\1$/.exec(text);
  if (!quoted) return null;
  // `"$status approved"` is a template, not a value the code compares against.
  if (node.type === "interpolated_string_literal" && /[$@]/.test(quoted[2])) return null;
  return { literal: quoted[2], kind: "string" };
}
