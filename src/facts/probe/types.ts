/**
 * The comparison shapes both extraction backends produce.
 *
 * They live in their own module because the two backends would otherwise import each other for them: the
 * dispatcher (`condition-extract.ts`) calls the Perl backend, and the Perl backend needs the result shape the
 * dispatcher declared. That is a real cycle — invisible to the eye because the reverse edge is an
 * `import type` — and it makes the two files one unit that cannot be layered. Shared shapes belong beside
 * both, not inside one.
 */

/** A comparison against a literal, as found in source. Purely syntactic — no judgement applied yet. */
export interface RawComparison {
  field: string;
  operator: string;
  /** Literal as written, without quotes for strings (`16`, `approved`). */
  literal: string;
  literalKind: "number" | "string";
  /** Absolute line in the file. */
  line: number;
}

export interface ExtractionResult {
  sites: RawComparison[];
  /** Which path produced this window's sites — recorded so degraded coverage is visible, not implied. */
  via: "ast" | "regex";
}
