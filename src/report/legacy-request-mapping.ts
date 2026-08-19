/**
 * The one-off explicit mapping from the legacy request vocabulary to `ReportRequestV2`.
 *
 * Six arms, and they are the whole mapping: (`overview` | `feature`) x (`product` | `engineering` | `prd`) minus
 * the pair that has no document. It is a TOTAL function — every input combination lands in a visible bucket, so
 * there is no arm that quietly falls through to a default and no combination whose outcome has to be inferred
 * from what the caller does next.
 *
 * `overview` + `prd` is a NAMED REFUSAL rather than a default: prd is a feature-only audience because no
 * prd-overview template exists, which `prepareRun` already enforces at the request boundary
 * (`src/run/run.ts:275`). The refusal here is the same verdict at the same severity — the caller turns it into a
 * hard error, exactly as that guard does. One fact must not be an error in one place and an advisory in another.
 *
 * The refusal is a RUNTIME value, not a compile-time hole: the legacy `Audience` and `DocumentKind` are
 * independent types and the illegal pair is one point in their product, so a type could only forbid it by
 * splitting `Audience` per kind — which would rewrite the legacy vocabulary this mapping exists to leave alone.
 * Exhaustiveness over what the types DO allow is compile-time: every switch here ends in `assertNever`, so
 * deleting an arm fails the typecheck rather than reaching a fallback.
 */

import { assertNever } from "../base/artifact-result.ts";
import type { Audience, DetailLevel, DocumentKind } from "../base/types.ts";
import { REPORT_POLICY_VERSION } from "./report-policy-registry.ts";
import type { DetailBudget, ReportRequestV2 } from "./report-request-v2.ts";

/** The mapping table's own version. It is recorded per row, so a remap is visible in an old run's record. */
export const LEGACY_REQUEST_MAPPING_VERSION = "legacy-request-mapping-v1";

/**
 * One planned document in the legacy vocabulary. Structurally a `PlannedDocument` plus the two request-level
 * fields the v2 row needs; `detailLevel` and `language` are required because the caller has already resolved
 * them (prepare defaults `detailLevel` once, at the top), and re-defaulting them here would be a second
 * normalisation site of the kind that made the redaction flag disagree with itself.
 */
export interface LegacyDocumentRequest {
  readonly documentId: string;
  readonly kind: DocumentKind;
  readonly audience: Audience;
  readonly featureKey: string | null;
  readonly detailLevel: DetailLevel;
  readonly language: string;
}

export type LegacyRequestMapping =
  | { readonly outcome: "mapped"; readonly request: ReportRequestV2 }
  | { readonly outcome: "refused"; readonly reason: string };

/** The six arms, plus the two structural refusals a `kind`/`featureKey` mismatch has to land in. */
export function mapLegacyDocumentRequest(document: LegacyDocumentRequest): LegacyRequestMapping {
  const shared = {
    detailBudget: mapDetailLevel(document.detailLevel),
    language: document.language,
    policyVersion: REPORT_POLICY_VERSION
  } as const;
  switch (document.kind) {
    case "overview": {
      if (document.featureKey !== null) {
        return refused(`an overview document carries feature key ${JSON.stringify(document.featureKey)}; the project scope is not addressed by feature`);
      }
      switch (document.audience) {
        case "product":
          return mapped({ scope: "project", scopeIds: [], audience: "product-manager", intent: "overview", ...shared });
        case "engineering":
          return mapped({ scope: "project", scopeIds: [], audience: "engineer", intent: "overview", ...shared });
        case "prd":
          return refused("the prd audience is feature-only: no project-scope prd document exists, and prepareRun refuses it at the request boundary");
      }
      return assertNever(document.audience, "legacy overview audience");
    }
    case "feature": {
      if (document.featureKey === null) {
        return refused("a feature document carries no feature key, so its knowledge boundary would be undefined");
      }
      const scopeIds = [document.featureKey];
      switch (document.audience) {
        case "product":
          return mapped({ scope: "feature", scopeIds, audience: "product-manager", intent: "deep-dive", ...shared });
        case "engineering":
          return mapped({ scope: "feature", scopeIds, audience: "engineer", intent: "deep-dive", ...shared });
        // prd is the arm the legacy vocabulary conflated: the reader is still the product manager, what changes
        // is the document's task. Splitting reader from task is why this arm exists.
        case "prd":
          return mapped({ scope: "feature", scopeIds, audience: "product-manager", intent: "prd", ...shared });
      }
      return assertNever(document.audience, "legacy feature audience");
    }
  }
  return assertNever(document.kind, "legacy document kind");
}

/**
 * `standard` and `detailed` map across by name. `compact` has NO producer in this mapping: nothing in the legacy
 * vocabulary asks for it, and inventing a back door here would be a request nobody made.
 */
function mapDetailLevel(detailLevel: DetailLevel): DetailBudget {
  switch (detailLevel) {
    case "standard": return "standard";
    case "detailed": return "detailed";
  }
  return assertNever(detailLevel, "legacy detail level");
}

function mapped(request: ReportRequestV2): LegacyRequestMapping {
  return { outcome: "mapped", request };
}

function refused(reason: string): LegacyRequestMapping {
  return { outcome: "refused", reason };
}
