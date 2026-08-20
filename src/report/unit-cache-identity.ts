/**
 * The CACHE IDENTITY of one authoring unit: what has to be the same for a verified draft to still answer (R6a).
 *
 * IT IS THE RENDERER'S OWN OUTPUT, NOT A SECOND LIST OF INPUTS. The obvious shape — enumerate epoch, topic
 * digests, audience, policy digests, budget, scope — is the shape R5b just paid nine times over for: an instrument
 * spelled separately from the thing it grades drifts the moment the graded thing reads one more input, and here it
 * would drift towards handing back a stale draft. So the identity is a DIGEST OF THE PACKET ITSELF, composed by
 * `composeUnitPacketMarkdown` with exactly the three plan-global digest lines normalized
 * (`IDENTITY_NORMALIZED_HEADER_LABELS`). Everything a packet renders is therefore in the key by construction —
 * the obligation scope of each topic reference, the ownership stub table and the unit ids it names, the divided
 * topic's carrier partition, the lens and intent policy digests, the budget rows, the evidence reach, the facet
 * census, the epoch — and a renderer that starts printing one more input makes every identity move without anyone
 * remembering to update a list. The residual drift direction is over-invalidation, which costs a rewrite; the
 * direction a hand-written list drifts in costs a silent stale reuse.
 *
 * AND THE THREE THINGS THE VIEW CANNOT SEE — a CLOSED list, `UnitIdentityTerms`, every member of which is
 * per-document or per-build and none of which is plan-global. That last clause is the whole discipline: a
 * plan-global field in the key would put back exactly the coupling the three normalized lines exist to remove.
 *
 *   * `authorship`, with no default. A draft written by one model family is not evidence that another family would
 *     write the same thing. A closed union: a model family, or a NAMED model-free generator (the fixture plan is
 *     the only one today). There is no "unknown" arm, because an unknown author is the one case where reuse must
 *     not be considered at all.
 *   * `contract` — the claims and summary schema versions this build records a unit in. A `unit-claims-v1` draft is
 *     not admissible under `unit-claims-v2`, and the packet says nothing about the shape of the output it will be
 *     turned into. THE RECEIPT SCHEMA VERSION IS DELIBERATELY NOT HERE (R6c), and the reason is a rule about what
 *     belongs in a key at all: the bytes a reuse hands back are the content, the claims and the summary, so those
 *     two schema versions are the shape of the thing being reused. A receipt is never reused — it is deleted when
 *     the draft it vouched for is collected, and an admission mints a NEW one by going back through `draftUnit` and
 *     `collectUnits` with every existing gate (`unit-cache-admission-run.ts`). Keeping its version in the key
 *     bought one whole-ledger invalidation per receipt schema bump and no protection at all: bad bytes are stopped
 *     by the gates, not by the key. BOUNDARY CONDITION, and it is the only thing holding this up: the day any
 *     admission path starts trusting a receipt's or a ledger row's recorded VERDICT instead of re-verifying through
 *     the gates, the version of the record it trusts belongs back in the key.
 *     `tests/unit-cache-admission-record-trust.test.ts` is that premise as a check that goes red.
 *   * `request` — THIS document's recorded request row. The packet header prints the audience, intent, language and
 *     detail budget, but not the request's KNOWLEDGE BOUNDARY (`scope`, `scopeIds`) nor its `policyVersion` and
 *     `mappingVersion`. A document whose boundary moved from one feature to two renders byte-identical packets
 *     under a plan that does not divide by scope, so without this the identity would call it unchanged. The row is
 *     per document: adding another document to the request set does not touch it, which is what keeps the
 *     second-audience reuse intact.
 *
 * SCOPE AND OWNERSHIP ARE THE COLLAPSE THIS FILE EXISTS TO AVOID. Two parts of one divided topic name the same
 * topic id with the same digest and differ ONLY in `obligationScope`; the epic's own key sketch would give them
 * one identity, and one part's draft would be admissible as the other's. The same holds for the ownership
 * environment: a sibling unit appearing or disappearing changes which obligations this unit owns, stubs, or
 * accounts for by carrier — without touching a single one of its own topics. The identity view carries all of it
 * because the packet prints all of it.
 *
 * PER-SECTION DIGESTS ARE THE REASON, NOT A SECOND DERIVATION. An identity that only says "changed" makes every
 * rebuild unexplainable, so the view is also split at its own `## ` headings and digested per section: the
 * invalidation plan's reason for a rebuild is the list of sections that differ, taken from the same bytes the
 * digest is taken from.
 */

import { canonicalJson, sha256 } from "../base/util.ts";
import type { AuthoringUnitKind } from "./plan-proposal.ts";
import type { ReportRequestRecord } from "./report-requests-artifact.ts";
import { UNIT_CLAIMS_VERSION, UNIT_SUMMARY_VERSION } from "./unit-output.ts";
import { authorshipValue, describeAuthorship, type UnitAuthorship } from "./unit-provenance.ts";
import { composeUnitPacketMarkdown, type UnitPacketInput } from "./unit-packet.ts";

/** v2 (R6c): the receipt schema version left the key. Any change to the formula below moves this. */
export const UNIT_CACHE_IDENTITY_VERSION = "unit-cache-identity-v2";

/**
 * The output contract a reused draft must still satisfy — the schema versions of the BYTES a reuse hands back.
 *
 * Read from the code's own constants rather than passed in: they are properties of THIS build, and a caller that
 * could state them would be able to claim a draft is admissible under a schema it was never written for.
 *
 * Two members, and the receipt version's absence is the ruling of R6c (the file header carries the argument and the
 * boundary condition). What is reused is a unit's content, claims and summary; the receipt is minted fresh by the
 * admission's own trip through `draftUnit`.
 */
export interface UnitOutputContract {
  readonly claimsVersion: typeof UNIT_CLAIMS_VERSION;
  readonly summaryVersion: typeof UNIT_SUMMARY_VERSION;
}

export const UNIT_OUTPUT_CONTRACT: UnitOutputContract = {
  claimsVersion: UNIT_CLAIMS_VERSION,
  summaryVersion: UNIT_SUMMARY_VERSION
};

/**
 * EVERY VERSION THAT ENTERS THE KEY, as one value an artifact can record and a test can pin.
 *
 * It exists because of what R6b did without anyone noticing: the receipt schema went v1 → v2 while it was in the
 * key, so every `identityDigest` checked into `eval/golden/` became a number the code could no longer produce — and
 * the suite stayed green, because nothing recomputed those digests and nothing recorded the versions they were
 * minted under. A reading that carries this value turns the next such bump into a red test in the same batch as the
 * bump. It is not a third list: the two members are the two constants `unitIdentityOf` actually digests, and
 * `tests/unit-cache-identity.test.ts` asserts an identity's own record equals them.
 */
export interface UnitIdentityKeyVersions {
  readonly identity: typeof UNIT_CACHE_IDENTITY_VERSION;
  readonly output: UnitOutputContract;
}

export const UNIT_IDENTITY_KEY_VERSIONS: UnitIdentityKeyVersions = {
  identity: UNIT_CACHE_IDENTITY_VERSION,
  output: UNIT_OUTPUT_CONTRACT
};

/*
 * `UnitAuthorship` — the required, closed "who would have written this" — lives in `unit-provenance.ts`, with the
 * other term a v2 unit record carries. It is vocabulary two files RECORD and this one KEYS ON, and defining it here
 * would make the receipt import the identity that already imports the receipt.
 */

/**
 * One section of the identity view: its position, its own `## ` heading, its bytes and its digest.
 *
 * The ordinal is part of the identity of a section rather than the heading alone, because a heading carries counts
 * ("3 obligation(s), 2 material, …") and would otherwise read as a section removed plus a section added when only
 * a number moved.
 */
export interface UnitIdentitySection {
  readonly ordinal: number;
  readonly heading: string;
  readonly bytes: number;
  readonly digest: string;
}

/**
 * The part of the key the packet does not render. Closed by construction: three fields, all per-document or
 * per-build. A member that varied with the whole plan or the whole catalog would belong in the view or nowhere.
 */
export interface UnitIdentityTerms {
  readonly authorship: UnitAuthorship;
  readonly contract: UnitOutputContract;
  /** This document's own recorded request row — its boundary, its policies and the mapping that produced it. */
  readonly request: ReportRequestRecord;
}

export interface UnitIdentity {
  readonly version: typeof UNIT_CACHE_IDENTITY_VERSION;
  readonly unitId: string;
  readonly documentId: string;
  readonly kind: AuthoringUnitKind;
  readonly terms: UnitIdentityTerms;
  /** The identity view's own byte count. Recorded so a reading can say how big the thing being digested was. */
  readonly viewBytes: number;
  /** The view split at its `## ` headings, in the view's own order. */
  readonly sections: readonly UnitIdentitySection[];
  /** sha256 over the canonical bytes of {version, authorship, contract, view}. The comparison key. */
  readonly digest: string;
}

/** The identity VIEW of one unit: the packet with the three plan-global digest lines normalized. */
export function unitIdentityView(input: UnitPacketInput): string {
  return composeUnitPacketMarkdown(input, "identity");
}

/**
 * The identity of one unit, from the values its packet is rendered from.
 *
 * The unit row is looked up in the plan the input carries so the record states the document and kind the plan
 * says, not what a caller believed; `composeUnitPacketMarkdown` has already refused an unknown unit, a foreign
 * ownership row and a dossier that does not match the kind before this line runs.
 */
export function unitIdentityOf(input: UnitPacketInput, authorship: UnitAuthorship): UnitIdentity {
  const author = authorshipValue(authorship);
  if (author.trim() === "" || author.trim() !== author) {
    throw new Error(`The authorship of unit ${JSON.stringify(input.unitId)} is stated as ${JSON.stringify(author)}; a cache identity must name who would have written the draft it stands for, and neither an empty name nor one with surrounding whitespace is a name — two spellings of one author would be two identities, which is a cache miss that reads as a real change`);
  }
  const view = unitIdentityView(input);
  const unit = input.planCatalog.units.find((row) => row.unitId === input.unitId);
  if (!unit) throw new Error(`Unit ${JSON.stringify(input.unitId)} is not in this plan catalog, so it has no identity to compute`);
  const request = input.requests.requests.find((row) => row.documentId === unit.documentId);
  if (!request) {
    throw new Error(`Unit ${JSON.stringify(unit.unitId)} is written into document ${JSON.stringify(unit.documentId)}, for which this run records no request; its identity cannot state the boundary it was written under`);
  }
  const terms: UnitIdentityTerms = { authorship, contract: UNIT_OUTPUT_CONTRACT, request };
  return {
    version: UNIT_CACHE_IDENTITY_VERSION,
    unitId: unit.unitId,
    documentId: unit.documentId,
    kind: unit.kind,
    terms,
    viewBytes: Buffer.byteLength(view, "utf8"),
    sections: unitIdentitySections(view),
    digest: sha256(canonicalJson({ version: UNIT_CACHE_IDENTITY_VERSION, terms, view }))
  };
}

/**
 * Which TERMS of two identities differ, as the sentences a rebuild reason is made of.
 *
 * The companion of `identitySectionDifferences`, and it exists because the digest covers more than the view: an
 * authorship change, a schema bump or a moved request boundary changes the digest while every section stays
 * byte-identical. Without this the invalidation plan would find a difference it could not explain and refuse the
 * whole plan — which is what a switch of model family, or a `unit-claims-v2`, would have done to every unit at once.
 */
export function identityTermDifferences(before: UnitIdentity, after: UnitIdentity): readonly string[] {
  const differences: string[] = [];
  if (canonicalJson(before.terms.authorship) !== canonicalJson(after.terms.authorship)) {
    differences.push(`authorship: ${describeAuthorship(before.terms.authorship)} -> ${describeAuthorship(after.terms.authorship)}`);
  }
  if (canonicalJson(before.terms.contract) !== canonicalJson(after.terms.contract)) {
    differences.push(`output contract: ${canonicalJson(before.terms.contract)} -> ${canonicalJson(after.terms.contract)}`);
  }
  if (canonicalJson(before.terms.request) !== canonicalJson(after.terms.request)) {
    differences.push(`recorded request for ${after.documentId}: ${canonicalJson(before.terms.request)} -> ${canonicalJson(after.terms.request)}`);
  }
  return differences;
}

/**
 * Split an identity view at its own `## ` headings.
 *
 * Everything before the first heading is one section named by the document's own title line: it is the header, and
 * it is where the epoch, the policies, the budgets and the graph edges live, so it must be diffable like any other
 * section rather than folded into the next one.
 */
export function unitIdentitySections(view: string): readonly UnitIdentitySection[] {
  const sections: UnitIdentitySection[] = [];
  let heading = "(packet header)";
  let lines: string[] = [];
  const flush = (): void => {
    const text = lines.join("\n");
    sections.push({ ordinal: sections.length + 1, heading, bytes: Buffer.byteLength(text, "utf8"), digest: sha256(text) });
  };
  for (const line of view.split("\n")) {
    if (line.startsWith("## ")) {
      flush();
      heading = line;
      lines = [];
      continue;
    }
    lines.push(line);
  }
  flush();
  return sections;
}

/**
 * Which sections of two identities differ, as the sentences a rebuild reason is made of.
 *
 * Paired by ordinal, so a heading whose counts moved reads as one changed section rather than one removed and one
 * added. Never empty when the digests differ: an identity that changed with no section naming it would mean the
 * sections do not cover the view, and the caller turns that into a named failure instead of an unexplained rebuild.
 */
export function identitySectionDifferences(before: UnitIdentity, after: UnitIdentity): readonly string[] {
  const differences: string[] = [];
  const count = Math.max(before.sections.length, after.sections.length);
  for (let ordinal = 1; ordinal <= count; ordinal += 1) {
    const was = before.sections[ordinal - 1];
    const now = after.sections[ordinal - 1];
    if (was && now) {
      if (was.digest === now.digest && was.heading === now.heading) continue;
      differences.push(was.heading === now.heading
        ? `section ${ordinal} ${now.heading}`
        : `section ${ordinal} ${was.heading} -> ${now.heading}`);
      continue;
    }
    if (now) differences.push(`section ${ordinal} ${now.heading} (added)`);
    if (was) differences.push(`section ${ordinal} ${was.heading} (removed)`);
  }
  return differences;
}
