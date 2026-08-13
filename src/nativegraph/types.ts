/**
 * Framework-neutral data model for the "native-language graph" — a supplementary symbol + call
 * graph for languages CodeGraph does not index (first target: Perl, plus a light Zope/DTML template
 * inventory). It is a NAVIGATION layer, the same role CodeGraph plays for supported languages: it
 * tells an investigator where symbols are defined and what calls what, so report claims can then be
 * grounded to real source windows. It is never itself an audit-chain artifact.
 *
 * Honesty is built into the model: a call whose receiver is a runtime value (`$obj->method`) cannot
 * be statically resolved to a package, so it is recorded as `dynamic` rather than guessed. Every node
 * and edge carries `file:line` provenance so a reader can always open the real source.
 */

/** How a call's target was classified from its syntactic receiver (invocant). */
export type CallKind =
  | "package-method" // `Foo::Bar->method` — receiver is a bareword package name
  | "self" // `$self->m`, `__PACKAGE__->m` — a call within the same object/class
  | "super" // `SUPER::m` / `$self->SUPER::m` — inherited call
  | "dynamic" // `$obj->m` — receiver is a runtime scalar; NOT statically resolvable
  | "function" // `foo(...)` — a bareword function call
  | "builtin"; // a Perl builtin (`warn`, `split`, …)

/** A `package Foo::Bar;` declaration. */
export interface PerlPackage {
  name: string;
  file: string;
  line: number;
}

/** A `sub name { ... }` declaration, attributed to its enclosing package by source line. */
export interface PerlSub {
  package: string | null;
  name: string;
  file: string;
  line: number;
}

/** One call site. `resolvedPackage` is set only when the receiver is a known extracted package. */
export interface CallEdge {
  fromFile: string;
  fromLine: number;
  fromPackage: string | null;
  fromSub: string | null;
  callee: string;
  invocant: string | null;
  kind: CallKind;
  resolvedPackage?: string;
}

/** Aggregated package → package dependency, counted from resolvable method/super edges. */
export interface PackageEdge {
  from: string;
  to: string;
  count: number;
}

/** A best-effort template expression reference (regex-extracted; templates are not fully parsed). */
export interface TemplateInventory {
  zptFiles: number;
  dtmlFiles: number;
  /** Distinct referenced names (TAL paths / DTML tag names), most-referenced first. */
  refs: Array<{ name: string; count: number }>;
}

/** Optional cross-language definition census from universal-ctags (degrades to unavailable). */
export interface CtagsCensus {
  available: boolean;
  reason?: string;
  byKind: Record<string, number>;
  byLanguage: Record<string, number>;
}

/** A non-fatal note (a file that failed to parse, ctags missing, …). */
export interface NativeGraphWarning {
  kind: string;
  message: string;
  file?: string;
}

/** The full navigation graph for one target. Deterministic: every list is sorted before it lands. */
export interface NativeGraph {
  target: string;
  gitHead?: string;
  /** Extensions actually scanned, e.g. [".pm", ".pl", ".t"]. */
  scannedExtensions: string[];
  packages: PerlPackage[];
  subs: PerlSub[];
  callEdges: CallEdge[];
  packageEdges: PackageEdge[];
  templates: TemplateInventory;
  ctags: CtagsCensus;
  stats: {
    files: number;
    parsedFiles: number;
    packages: number;
    subs: number;
    callEdges: number;
    edgesByKind: Record<CallKind, number>;
    resolvedEdges: number;
    dynamicEdges: number;
  };
  warnings: NativeGraphWarning[];
}
