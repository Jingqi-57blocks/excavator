// SYNTACTIC extraction of literal comparisons — the layer an open-source parser does better than we can.
//
// The judgment layer (which comparison is a business rule, which is structural noise) stays in
// condition-inventory.ts, because no tool knows that `record.status < 7` is a rule and `len(parts) != 3` is
// not. This module answers only the mechanical question: WHERE are the comparisons against a literal.
//
// Why AST instead of the hand-written regex it replaces (measured on a real 21-feature run, 535 windows):
//   - a regex per language is a per-language omission machine: it found 24 conditions in Go/TS/JS, 5 in Perl
//     and 0 in C#/Kotlin, and it silently missed SQL `=`, shell `-ne`, and every string-literal comparison;
//   - the AST excludes comments and string bodies for free — the regex matched `// retries > 3` and
//     `"threshold x > 88"` as real conditions;
//   - one pattern text (`$A > $N`) works across every C-family grammar, so adding a language adds a grammar,
//     not a new dialect of regex;
//   - it finds MORE, not fewer: 249 numeric comparisons where the regex raw-matched 204.
//
// Excerpt windows parse fine — tree-sitter is error tolerant, verified on all 535 real windows (0 failures).
//
// DEGRADATION IS EXPLICIT. A language with no grammar here falls back to the calibrated regex, which is
// numeric-only: quoting/escaping rules differ too much per language to extract string literals safely by
// regex, so `literalKind: "string"` is only ever produced by a structural path. Every site records which
// path produced it, so a reader can tell "no string rules here" from "no string extraction here".
//
// TWO STRUCTURAL BACKENDS, ONE CONTRACT. C-family languages go through ast-grep; Perl goes through
// tree-sitter (ast-grep has no Perl grammar, and on sigil syntax the regex is inert rather than merely
// weak — see condition-extract-perl.ts). Both report `via: "ast"`, because the distinction that matters to
// a reader is structural-versus-degraded, not which library did the parsing. The Perl parser must be
// warmed by `warmExtractors()` first: it cannot be loaded synchronously, and an unwarmed run degrades to
// regex honestly rather than pretending.

import { createRequire } from "node:module";
import type { EvidenceItem } from "../../base/types.ts";
import { extractPerlComparisons, loadPerlParser, type PerlParser } from "./condition-extract-perl.ts";
import type { ExtractionResult, RawComparison } from "./types.ts";

// Re-exported so the shapes stay reachable from the extractor that produces them; `types.ts` owns them.
export type { ExtractionResult, RawComparison } from "./types.ts";

// The grammars are native CommonJS addons, and this module is ESM: `require` does not exist here, so it is
// constructed explicitly. Getting this wrong fails silently into the regex path — which is exactly what the
// per-site `via` field is for, and how the mistake was caught on a real run.
const requireNative = createRequire(import.meta.url);

const OPERATORS = [">=", "<=", "===", "!==", "==", "!=", ">", "<"] as const;

/** Extension → ast-grep language id. Built-ins need no package; `go` is registered dynamically below.
 *  Exported so every ast-grep consumer resolves languages the same way — grammar registration has one owner. */
export const AST_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "Tsx",
  ".js": "JavaScript",
  ".jsx": "Tsx",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".go": "go",
};

/** Extensions handled by the tree-sitter Perl backend rather than ast-grep. Exported so the mechanism
 *  registry's `condition-ast-perl` support set is proven equal to what this module actually branches on. */
export const PERL_EXTENSIONS = new Set([".pm", ".pl", ".t", ".cgi", ".psgi"]);

/** The languages this extractor understands structurally — an enumerable fact, not a guess. Perl is
 *  structural only once `warmExtractors` has run; every site records the path that produced it. */
export const AST_LANGUAGES: readonly string[] = ["TypeScript", "Tsx", "JavaScript", "go", "Perl"];

/** The Perl parser, once warmed. `null` means "tried and unavailable"; `undefined` means "never warmed" —
 *  both degrade to regex, and both are visible per site as `via: "regex"`. */
let perlParser: PerlParser | null | undefined;

/** Load the parsers that cannot be loaded synchronously. Idempotent; call once before extraction. */
export async function warmExtractors(): Promise<void> {
  if (perlParser === undefined) perlParser = await loadPerlParser();
}

/** Numeric-only fallback, byte-identical in behaviour to the regex this module replaces. */
const REGEX_COMPARISON = /([A-Za-z_][\w.[\]()]{0,40})\s*(===?|!==?|>=|<=|>|<)\s*(\d+(?:\.\d+)?)\b/g;

export interface AstGrepApi {
  parse(language: string, source: string): { root(): AstNode };
}
export interface AstNode {
  /** A pattern string (`$A > $N`) or a rule object (`{ rule: { kind: "if_statement" } }`). */
  findAll(query: string | { rule: { kind: string } }): AstMatch[];
}
interface AstMatch {
  getMatch(name: string): { text(): string } | null;
  range(): { start: { line: number } };
}

/** Loaded once, lazily, and never fatal: a platform without the native binding degrades to regex. */
let astGrep: AstGrepApi | null | undefined;
export function loadAstGrep(): AstGrepApi | null {
  if (astGrep !== undefined) return astGrep;
  try {
    const api = requireNative("@ast-grep/napi") as AstGrepApi & { registerDynamicLanguage(langs: Record<string, unknown>): void };
    try {
      const go = requireNative("@ast-grep/lang-go");
      api.registerDynamicLanguage({ go });
    } catch {
      // Dynamic grammar unavailable: built-in languages still work, Go falls back to regex.
    }
    astGrep = api;
  } catch {
    astGrep = null;
  }
  return astGrep;
}

/** Extract every literal comparison in one source window. */
export function extractComparisons(window: EvidenceItem): ExtractionResult {
  const content = typeof window.content === "string" ? window.content : "";
  const startLine = typeof window.startLine === "number" ? window.startLine : 1;
  const extension = extensionOf(window.path);
  const language = AST_LANGUAGE_BY_EXTENSION[extension];
  const api = language ? loadAstGrep() : null;
  if (api && language) {
    const ast = extractWithAst(api, language, content, startLine);
    if (ast) return { sites: ast, via: "ast" };
  }
  if (perlParser && PERL_EXTENSIONS.has(extension)) {
    const perl = extractPerlComparisons(perlParser, content, startLine);
    if (perl) return { sites: perl, via: "ast" };
  }
  return { sites: extractWithRegex(content, startLine), via: "regex" };
}

function extractWithAst(api: AstGrepApi, language: string, content: string, startLine: number): RawComparison[] | null {
  let root: AstNode;
  try {
    root = api.parse(language, content).root();
  } catch {
    return null;
  }
  const sites: RawComparison[] = [];
  // ast-grep matches operators exactly — `$A == $N` does not match `x === 1`, `$A > $N` does not match
  // `z >= 3` (verified against the real binding), so no cross-operator de-duplication is needed.
  for (const operator of OPERATORS) {
    let matches: AstMatch[];
    try {
      matches = root.findAll(`$A ${operator} $N`);
    } catch {
      continue;
    }
    for (const match of matches) {
      const field = match.getMatch("A")?.text()?.trim() ?? "";
      const raw = match.getMatch("N")?.text()?.trim() ?? "";
      if (!field || !raw) continue;
      const classified = classifyLiteral(raw);
      if (!classified) continue;
      const line = startLine + match.range().start.line;
      sites.push({ field, operator, literal: classified.literal, literalKind: classified.kind, line });
    }
  }
  return sites;
}

function extractWithRegex(content: string, startLine: number): RawComparison[] {
  const sites: RawComparison[] = [];
  const lines = content.split("\n");
  for (let offset = 0; offset < lines.length; offset++) {
    REGEX_COMPARISON.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REGEX_COMPARISON.exec(lines[offset])) !== null) {
      sites.push({ field: match[1].trim(), operator: match[2], literal: match[3], literalKind: "number", line: startLine + offset });
    }
  }
  return sites;
}

/** A literal is a bare number or a quoted string; anything else (a variable, a call) is not a literal. */
function classifyLiteral(raw: string): { literal: string; kind: "number" | "string" } | null {
  if (/^\d+(\.\d+)?$/.test(raw)) return { literal: raw, kind: "number" };
  const quoted = /^(["'`])([\s\S]*)\1$/.exec(raw);
  if (quoted) return { literal: quoted[2], kind: "string" };
  return null;
}

function extensionOf(path: unknown): string {
  const value = String(path ?? "");
  const dot = value.lastIndexOf(".");
  return dot < 0 ? "" : value.slice(dot).toLowerCase();
}
