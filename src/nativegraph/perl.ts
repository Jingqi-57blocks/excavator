/**
 * Perl symbol + call extraction via tree-sitter (`tree-sitter-perl`).
 *
 * Per file we recover: `package` declarations, `sub` declarations, and every method / function call
 * site. Each sub and call is attributed to its enclosing package and sub by SOURCE LINE (Perl's
 * statement-form `package Foo;` applies from its line to the next package; block-form `package {}` is
 * rare in the legacy Catalyst code this targets and degrades to line attribution, never a crash).
 *
 * Call classification is honest about static limits: a method whose receiver is a bareword package
 * (`Foo::Bar->m`) is `package-method` and carries a resolvable candidate; a receiver that is a runtime
 * scalar (`$obj->m`) is `dynamic` and is NEVER guessed into an edge to a concrete package.
 */

import Parser from "tree-sitter";
import Perl from "tree-sitter-perl";
import type { CallEdge, CallKind, PerlPackage, PerlSub } from "./types.ts";

/** The minimal slice of the tree-sitter node API this module reads. */
interface TSNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  childCount: number;
  firstChild: TSNode | null;
  child(i: number): TSNode | null;
  childForFieldName(field: string): TSNode | null;
}

const PERL_BUILTINS = new Set([
  "print", "printf", "sprintf", "warn", "die", "say", "split", "join", "map", "grep", "sort",
  "keys", "values", "push", "pop", "shift", "unshift", "splice", "defined", "ref", "bless",
  "scalar", "wantarray", "length", "substr", "index", "rindex", "uc", "lc", "ucfirst", "lcfirst",
  "chomp", "chop", "exists", "delete", "each", "reverse", "abs", "int", "open", "close", "read",
  "eval", "local", "return", "chr", "ord", "hex", "oct", "sqrt", "sin", "cos", "rand", "srand",
]);

let cachedParser: unknown;
function perlParser(): { parse(src: string): { rootNode: TSNode } } {
  if (!cachedParser) {
    const parser = new (Parser as unknown as new () => { setLanguage(l: unknown): void })();
    parser.setLanguage(Perl);
    cachedParser = parser;
  }
  return cachedParser as { parse(src: string): { rootNode: TSNode } };
}

export interface PerlFileExtraction {
  packages: PerlPackage[];
  subs: PerlSub[];
  calls: CallEdge[];
  ok: boolean;
}

interface RawCall {
  callee: string;
  invocant: string | null;
  kind: CallKind;
  resolvedCandidate?: string;
  line: number;
}

/** Extract packages, subs, and (package/sub-attributed) call sites from one Perl file's source. */
export function extractPerlFile(source: string, file: string): PerlFileExtraction {
  let root: TSNode;
  try {
    root = perlParser().parse(source).rootNode;
  } catch {
    return { packages: [], subs: [], calls: [], ok: false };
  }

  const packages: PerlPackage[] = [];
  const subs: PerlSub[] = [];
  const rawCalls: RawCall[] = [];

  const stack: TSNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    const line = node.startPosition.row + 1;
    if (node.type === "package_statement") {
      const name = fieldText(node, "name");
      if (name) packages.push({ name, file, line });
    } else if (node.type === "subroutine_declaration_statement") {
      const name = fieldText(node, "name");
      if (name) subs.push({ package: null, name, file, line });
    } else if (node.type === "method_call_expression") {
      const method = fieldText(node, "method");
      if (method) rawCalls.push({ line, ...classifyMethod(fieldText(node, "invocant"), method) });
    } else if (isFunctionCall(node.type)) {
      const fn = fieldText(node, "function") ?? node.firstChild?.text ?? null;
      if (fn && /^[A-Za-z_][\w]*(::[A-Za-z_]\w*)*$/.test(fn)) {
        rawCalls.push({
          line,
          callee: fn,
          invocant: null,
          kind: PERL_BUILTINS.has(fn) ? "builtin" : "function",
        });
      }
    }
    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i);
      if (child) stack.push(child);
    }
  }

  // Attribute subs and calls to their enclosing package / sub by source line.
  const pkgByLine = byLine(packages.map((p) => ({ line: p.line, value: p.name })));
  for (const sub of subs) sub.package = pkgByLine(sub.line);
  const subByLine = byLine(subs.map((s) => ({ line: s.line, value: s.name })));

  const calls: CallEdge[] = rawCalls.map((c) => {
    const edge: CallEdge = {
      fromFile: file,
      fromLine: c.line,
      fromPackage: pkgByLine(c.line),
      fromSub: subByLine(c.line),
      callee: c.callee,
      invocant: c.invocant,
      kind: c.kind,
    };
    if (c.resolvedCandidate) edge.resolvedPackage = c.resolvedCandidate;
    return edge;
  });

  return { packages, subs, calls, ok: true };
}

function classifyMethod(
  invocant: string | null,
  method: string,
): { callee: string; invocant: string | null; kind: CallKind; resolvedCandidate?: string } {
  if (method.startsWith("SUPER::")) return { callee: method, invocant, kind: "super" };
  const inv = (invocant ?? "").trim();
  if (inv === "$self" || inv === "$class" || inv === "__PACKAGE__") {
    return { callee: method, invocant: inv, kind: "self" };
  }
  if (/^[A-Za-z_]\w*(::[A-Za-z_]\w*)*$/.test(inv)) {
    return { callee: method, invocant: inv, kind: "package-method", resolvedCandidate: inv };
  }
  return { callee: method, invocant: inv || null, kind: "dynamic" };
}

function isFunctionCall(type: string): boolean {
  return type === "function_call_expression" || type === "call_expression" || type === "func_call_expression";
}

function fieldText(node: TSNode, field: string): string | null {
  const child = node.childForFieldName(field);
  return child ? child.text : null;
}

/** Build a "greatest line ≤ query" lookup over line-tagged declarations (Perl scope-by-line). */
function byLine(items: Array<{ line: number; value: string }>): (line: number) => string | null {
  const sorted = items.slice().sort((a, b) => a.line - b.line);
  return (line: number): string | null => {
    let lo = 0;
    let hi = sorted.length - 1;
    let found: string | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].line <= line) {
        found = sorted[mid].value;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };
}
