import type { MechanismAvailability } from "../../base/mechanism-registry.ts";
import { AST_LANGUAGE_BY_EXTENSION, type AstGrepApi } from "../probe/condition-extract.ts";

/**
 * Whether ast-grep really holds each GRAMMAR the designated partition builder needs — which is not the same
 * question as whether its native binding loaded.
 *
 * `@ast-grep/napi` carries TypeScript / Tsx / JavaScript compiled in, while Go lives in a SEPARATE package that
 * `loadAstGrep` registers dynamically and is allowed to fail quietly, because the built-in languages keep working
 * without it. So a machine can sit between the two facts, and this one does when `@ast-grep/lang-go` is absent:
 * measured here, `parse("TypeScript", "")` succeeds while `parse("go", "")` throws `go is not supported in napi`.
 *
 * Reading only the binding cost the contract its central promise. Every `.go` file's parse threw, each landed in
 * `parse-failed`, each became one residual cell, and the envelope still said `built` — a partition made coarser by
 * which package happened to be installed (§一 forbids exactly that), filed under a bucket that calls itself
 * content-determined. Measured on the fixture: `main.go` came out as one residual cell while `app.ts` next to it
 * came out as three.
 *
 * The probe is the SAME call the builder makes — `parse(language, …)` then `root()` — for the same reason
 * `mechanism-availability.ts` states about ctags and Perl: a probe that asks a different question than the
 * mechanism can disagree with it, and the disagreement is invisible.
 */

/**
 * Every ast-grep language the partition adapter can designate, derived from the one extension table rather than
 * re-listed. A second list is a list that goes stale: adding `.rs → Rust` there must probe Rust here on the same
 * day, not on the day someone remembers.
 */
export const AST_PARTITION_GRAMMARS: readonly string[] =
  [...new Set(Object.values(AST_LANGUAGE_BY_EXTENSION))].sort();

/** One verdict per ast-grep language. Total over `AST_PARTITION_GRAMMARS`; see `grammarAvailability` for the rest. */
export type AstGrammarAvailability = Readonly<Record<string, MechanismAvailability>>;

/** Probe every designated grammar against this binding. `null` means the binding itself never loaded. */
export function probeAstGrammars(api: AstGrepApi | null): AstGrammarAvailability {
  const grammars: Record<string, MechanismAvailability> = {};
  for (const language of AST_PARTITION_GRAMMARS) grammars[language] = probeGrammar(api, language);
  return grammars;
}

function probeGrammar(api: AstGrepApi | null, language: string): MechanismAvailability {
  if (api === null) return { status: "unavailable", cause: "the @ast-grep/napi native binding could not be loaded" };
  try {
    api.parse(language, "").root();
    return { status: "available" };
  } catch (error) {
    return { status: "unavailable", cause: `ast-grep has no registered grammar for ${language}: ${(error as Error).message}` };
  }
}

/**
 * One grammar's verdict, fail-closed.
 *
 * A language nobody probed reads as unavailable rather than as available or as a third state, because the only
 * honest thing to say about an unasked question is that it was not asked — and the caller of this predicate is a
 * gate whose "yes" publishes a partition. `AST_PARTITION_GRAMMARS` makes the miss unreachable for any language the
 * extension table can yield; this covers the caller that invents one.
 */
export function grammarAvailability(grammars: AstGrammarAvailability, language: string): MechanismAvailability {
  return grammars[language] ?? { status: "unavailable", cause: `the ast-grep grammar for ${language} was never probed` };
}
