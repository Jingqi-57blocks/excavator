import { assertNever } from "../base/artifact-result.ts";
import type { FactKindId } from "../base/fact-kind-registry.ts";
import type { TopicFacet } from "./topic-candidate.ts";

/**
 * Which report facet a layer-3 fact kind becomes a topic in — the whole table, in one exhaustive switch.
 *
 * WHY IT IS A SWITCH OVER THE KIND AND NOT A CONDITION INSIDE A PRODUCER ARM. Before this file, the catalog
 * asked `kind === "indexed-route" ? "route" : null` for codegraph and returned `"entity"` for EVERY db-schema
 * kind. Both spellings are a `default` in disguise: registering a new fact kind changed no line here and lit no
 * compiler error, so a producer could publish facts that either vanished into the unmapped census or were routed
 * to a facet nobody chose. Because the kind registry already binds each kind to its producer
 * (`buildProducerFactSet` refuses a fact whose kind belongs elsewhere), the kind alone is the honest key, and a
 * switch over the closed kind union makes registering the NEXT kind a typecheck failure until someone decides
 * where its facts land.
 *
 * `null` is a decision, not a gap: it means "this kind is not a topic subject", and the catalog COUNTS every such
 * fact in `factRouting.unmapped`. The wcp baseline's 6,008 indexed functions are not report topics, and the
 * catalog says so with a number rather than by omission.
 */
export function facetForFactKind(kind: FactKindId): TopicFacet | null {
  switch (kind) {
    // Routes: one topic per ledger row, per producer. An indexed route and a recovered route are two rows and
    // therefore two topics — merging them would be a graph computation wearing a de-duplication's clothes.
    case "indexed-route":
    case "recovered-route":
      return "route";
    // Tables: the entity facet's only subject. Columns are a table's detail, not topics of their own.
    case "db-table":
      return "entity";
    // Not topic subjects, and each for its own reason: a function is a unit rather than a subject, a frontend
    // call is one end of a link, an `http-link` is already the external-system facet's edge (projected from
    // `context/crossrepo-links.json`, not from the fact), and a corpus term frequency has no subject at all.
    case "indexed-function":
    case "frontend-call":
    case "http-link":
    case "term-df":
      return null;
  }
  return assertNever(kind, "fact kind facet routing");
}
