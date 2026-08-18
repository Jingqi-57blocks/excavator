import { sha256, stableJson } from "../../base/util.ts";
import { AST_LANGUAGE_BY_EXTENSION, type AstGrepApi, type AstNode } from "../probe/condition-extract.ts";
import { canonicalSpan, compareSpans, utf8OffsetMap, type CanonicalSpan, type UnitKind } from "./unit-identity.ts";

/**
 * The designated partition builder for typescript / javascript / go: a structural skeleton from ast-grep.
 *
 * WHY THE OUTERMOST STRUCTURAL NODES, not "syntax depth 1". `export class Foo {}` parses as an
 * `export_statement` whose child is the `class_declaration` — measured on the real binding — so a literal
 * depth-1 rule would miss every exported declaration in the corpus and quietly produce a file with no cells.
 * The rule is therefore structural: descend from the root, and the FIRST structural node found on each path is a
 * top-level one; do not look for another below it. The `export ` bytes in front become residual, which is
 * honest — the partition still covers them.
 *
 * That rule is also where non-overlap comes from, and it is a property of trees rather than a runtime check that
 * happens to pass. Two distinct nodes of one parse tree are either ancestor and descendant or disjoint in range;
 * the walk stops at the first structural node on every path, so no top-level node is an ancestor of another, so
 * no two of them overlap. `partition-build.ts` re-checks it anyway, because a cheap check on a structural
 * guarantee is what catches the day the guarantee stops being true.
 *
 * Nested structures — a method inside a class, a closure inside a method — are NOT cells. They are reference
 * units, carried here as the `children` of their enclosing node so `partition-build.ts` can mint them with the
 * nesting depth they really have. A class and its methods in one conservation sum would overlap; that is the
 * whole reason §一 splits `refUnits[]` from `partition[]`.
 *
 * The walk is iterative. A minified bundle (the `tiny_mce.js` that produced a 439,321-character evidence field
 * in P18 is in a real target) nests deeply enough that recursion is a real hazard, and a stack overflow here
 * would look like a parse failure.
 */

export const AST_PARTITION_VERSION = "partition-ast-v1";

/**
 * Grammar node kind → reference-unit kind, across all three grammars in one table.
 *
 * `function_declaration` is deliberately shared: TypeScript and Go both use it, and one entry is the point —
 * a per-language dialect of this table is how a language quietly gets less coverage than the one next to it.
 *
 * Every kind here was read off the real binding, not from documentation. Two of them are traps:
 *  - `class` is BOTH the anonymous class expression (`export default class {}`) and the `class` KEYWORD token.
 *    They are distinguished only by `isNamed()`, which is why the walk checks it. Without that check every
 *    class in the corpus would sprout a phantom nested class ref unit five bytes long.
 *  - `abstract_method_signature` and `function_signature` are deliberately ABSENT. A signature has no body, so
 *    it has no span a reader could be sent to read; calling it a unit would put declarations with no code in the
 *    same bucket as code.
 */
const UNIT_KIND_BY_NODE_KIND: Readonly<Record<string, UnitKind>> = {
  // typescript / javascript / tsx
  "class_declaration": "class",
  "abstract_class_declaration": "class",
  "class": "class",
  "function_declaration": "function",
  "generator_function_declaration": "function",
  "function_expression": "function",
  "method_definition": "method",
  "arrow_function": "closure",
  // go
  "method_declaration": "method",
  "func_literal": "closure"
};

/** The walk's mutable accumulator; the exported shape is deeply readonly, and this is what fills it. */
interface Draft {
  unitKind: UnitKind;
  span: CanonicalSpan;
  depth: number;
  children: Draft[];
}

/** One structural node of the skeleton. `children` are nested structures, never cells. */
export interface AstStructureNode {
  readonly unitKind: UnitKind;
  readonly span: CanonicalSpan;
  /** 1 for a top-level node; the value is what makes "this method is inside that class" readable in the artifact. */
  readonly depth: number;
  readonly children: readonly AstStructureNode[];
}

/**
 * A file's skeleton, or the one way extracting it can fail.
 *
 * `parse-failed` is CONTENT-DETERMINED and reachable: `api.parse` throws for a language the binding does not
 * have registered (measured: `Klingon is not supported in napi`), which is what happens when the dynamic Go
 * grammar fails to load while the built-ins are fine. tree-sitter itself is error tolerant and recovers from
 * broken syntax rather than throwing, so a syntax error produces a skeleton, not this state — which is correct:
 * a half-parsed file still has real structure, and refusing it would trade a partial partition for none.
 */
export type AstSkeleton =
  | { readonly status: "built"; readonly topLevel: readonly AstStructureNode[]; readonly byteLength: number }
  | { readonly status: "parse-failed"; readonly detail: string };

/** The ast-grep language for one extension, or `null` when this builder does not declare it (`.mts`, `.cts`). */
export function astPartitionLanguage(extension: string): string | null {
  return AST_LANGUAGE_BY_EXTENSION[extension] ?? null;
}

/**
 * This extractor's identity: its version AND the node-kind table it walks with.
 *
 * The table is in the digest rather than trusted to a remembered version bump, because a skeleton cache keyed on
 * a version alone would serve pre-edit skeletons after someone added `method_definition` to the map — a silent
 * wrong answer of exactly the "cache key missing a semantic input" shape the contract's fifth column names.
 */
export function astSkeletonIdentity(): string {
  return sha256(stableJson({ version: AST_PARTITION_VERSION, nodeKinds: UNIT_KIND_BY_NODE_KIND }));
}

/**
 * Extract one file's skeleton.
 *
 * `api` is a PARAMETER rather than a `loadAstGrep()` call inside, for two reasons that point the same way: the
 * per-file degradation path must not be able to read a mechanism's availability (§一 — availability decides the
 * whole envelope, degradation decides one file, and letting one code path see both is how they get confused),
 * and a test needs to hand this function a binding that throws in order to prove `parse-failed` is reachable.
 */
export function extractAstSkeleton(api: AstGrepApi, language: string, source: string): AstSkeleton {
  const offsets = utf8OffsetMap(source);
  let root: AstNode;
  try {
    root = api.parse(language, source).root();
  } catch (error) {
    return { status: "parse-failed", detail: (error as Error).message };
  }
  const topLevel: Draft[] = [];
  const stack: Array<{ node: AstNode; into: Draft[]; depth: number }> = [{ node: root, into: topLevel, depth: 1 }];
  try {
    while (stack.length > 0) {
      const frame = stack.pop()!;
      for (const child of frame.node.children()) {
        const unitKind = child.isNamed() ? UNIT_KIND_BY_NODE_KIND[child.kind()] : undefined;
        if (unitKind === undefined) {
          stack.push({ node: child, into: frame.into, depth: frame.depth });
          continue;
        }
        const range = child.range();
        const draft: Draft = {
          unitKind,
          span: canonicalSpan(offsets.byteOffsetOf(range.start.index), offsets.byteOffsetOf(range.end.index)),
          depth: frame.depth,
          children: []
        };
        frame.into.push(draft);
        stack.push({ node: child, into: draft.children, depth: frame.depth + 1 });
      }
    }
  } catch (error) {
    // An offset the map refuses (outside the source, or inside a surrogate pair) means this file's ranges cannot
    // be expressed as canonical spans at all. It is the parser's output that is unusable, so it lands in the
    // parser's bucket rather than in a new one — and it is content-determined, so the same bytes fail the same way.
    return { status: "parse-failed", detail: `node range could not be converted to a canonical span: ${(error as Error).message}` };
  }
  return { status: "built", topLevel: sortDrafts(topLevel), byteLength: offsets.byteLength };
}

/** Canonical order, recursively: the stack walk visits siblings in reverse, and two runs must agree on bytes. */
function sortDrafts(nodes: readonly Draft[]): AstStructureNode[] {
  return [...nodes]
    .sort((a, b) => compareSpans(a.span, b.span) || a.unitKind.localeCompare(b.unitKind))
    .map((node) => ({ unitKind: node.unitKind, span: node.span, depth: node.depth, children: sortDrafts(node.children) }));
}

/** Every node of a skeleton, outer before inner, in canonical order. The reference-unit set of one file. */
export function flattenSkeleton(nodes: readonly AstStructureNode[]): AstStructureNode[] {
  const out: AstStructureNode[] = [];
  const visit = (list: readonly AstStructureNode[]): void => {
    for (const node of list) {
      out.push(node);
      visit(node.children);
    }
  };
  visit(nodes);
  return out;
}
