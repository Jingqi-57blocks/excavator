import type { AuditFinding, EvidenceItem, SectionClaim } from "../base/types.ts";

/**
 * Faithfulness hardening for cross-source comparison claims. The audit gate proves each cited
 * evidence item EXISTS, matches its digest, and is bound to the section — but not that the evidence's
 * SCOPE covers the assertion's scope. A `fact`-marked equivalence claim ("v2 and the legacy service
 * share the same thresholds") that cites only ONE side is single-sided yet reads as two-sided.
 *
 * Core makes zero model calls, so the assertion's scope can only be APPROXIMATED mechanically. Two
 * layers do that here:
 *   1. Structural (hard): when a claim declares `sides` (its per-side grouping of evidence), the
 *      grouping must be well-formed — validated at checkpoint and re-checked at audit.
 *   2. Advisory (warning): a `fact` claim whose statement uses comparative wording, declares no
 *      `sides`, and cites path-bearing evidence that all falls in a single source unit is flagged so
 *      the author either cites every side and declares `sides` or downgrades to `inferred`.
 * Both are framework-independent: no target name, route, table, or repository is hard-coded.
 */

/**
 * Structural validation for a claim's optional `sides` grouping. Returns violation messages (empty =
 * valid). Absent `sides` is always valid — the field is additive and most claims never carry it.
 * Rules when present: at least two groups; every group non-empty; every id in every group is one of
 * the claim's own `evidenceIds`; groups pairwise disjoint (an id may not span two sides); and an
 * `unavailable` claim — which cites no evidence — must not declare sides at all.
 */
export function validateComparisonSides(claim: SectionClaim): string[] {
  const groups = claim.sides;
  if (!groups) return [];
  const violations: string[] = [];
  if (claim.marker === "unavailable") {
    violations.push(`unavailable claim ${claim.id} cites no evidence and must not declare comparison sides`);
    return violations;
  }
  if (groups.length < 2) violations.push(`claim ${claim.id} declares comparison sides but has fewer than two groups`);
  const evidenceIds = new Set(claim.evidenceIds ?? []);
  const idGroups = new Map<string, Set<number>>();
  groups.forEach((group, index) => {
    if (!group.length) violations.push(`claim ${claim.id} comparison side ${index + 1} is empty`);
    for (const id of group) {
      if (!evidenceIds.has(id)) violations.push(`claim ${claim.id} comparison side ${index + 1} cites ${id}, which is not one of the claim's evidence ids`);
      if (!idGroups.has(id)) idGroups.set(id, new Set());
      idGroups.get(id)!.add(index);
    }
  });
  for (const [id, indices] of idGroups) {
    if (indices.size > 1) violations.push(`claim ${claim.id} evidence ${id} appears in more than one comparison side`);
  }
  return violations;
}

/**
 * The advisory trigger wordlist — zh + en only for v1 (the prevention writing-rule covers every
 * language). A statement matches when it asserts equivalence, sameness, or shared values/behavior
 * across sources. The CJK patterns require comparison CONTEXT rather than a bare noun-compound
 * substring: a comparison connective (`与…相同/一致/等价/共享/同样`, `两者…`, `共享同一`) must be present,
 * so ordinary compounds (`共享读取`, `同一天`, `同一员工`, `行为一致性`) do not fire. It also EXCLUDES
 * wording that reads comparative but is not a cross-source equivalence assertion: `统一` / `unified`
 * (one shared thing, not two things being compared), the noun `一致性` ("consistency" as a quality —
 * hence the `保持一致(?!性)` negative lookahead), and bare `both`. Fine-tuning the list is allowed as
 * long as the positive/negative controls keep passing.
 *
 * `等价` and `镜像` were BARE patterns and had to stop being so: in Chinese `镜像` is simply a container
 * image, and `等价` is ordinary for semantic equivalence. A real run produced three false positives on
 * sentences like 「上层镜像把时区固定为 Europe/Vienna」, and the author rewrote 镜像 as 容器层 — trading
 * terminology accuracy for a green audit, which is the wrong thing to make an author do. Both now require
 * the same connective context the other patterns require, so a cross-source equivalence claim still trips
 * while a container image does not.
 */
const COMPARATIVE_PATTERNS: RegExp[] = [
  /共享同一/,
  /与[^，。；\n]{1,24}(?:相同|一致|等价|共享|同样|镜像)/,
  /两者[^，。；\n]{0,12}(?:相同|一致|等价|镜像)/,
  /保持一致(?!性)/,
  /\bequivalent\b/i,
  /\bidentical\b/i,
  /\bmirrors\b/i,
  /\bconsistent with\b/i,
  /\bin sync\b/i,
  /\bshares? the same\b/i,
  /\bsame\b[\s\S]{0,40}?\bas\b/i
];

/** True when the statement uses cross-source comparative wording (see `COMPARATIVE_PATTERNS`). */
export function comparativeWording(statement: string): boolean {
  return COMPARATIVE_PATTERNS.some((pattern) => pattern.test(statement));
}

/**
 * The scope unit a piece of path-bearing evidence belongs to. In a multi-root target a "side" is a
 * repository, so evidence is grouped by its first path segment when that segment names a known root;
 * in a single-root target a "side" is a file, so the whole path is the unit. Two files in the same
 * repo therefore count as one side in multi-root mode (an intra-root cross-file comparison still
 * needs `sides`), while two files in one single-root target count as two sides.
 */
function sideUnit(path: string, multiRoot: boolean, roots: Set<string>): string {
  if (!multiRoot) return path;
  const first = path.split("/")[0];
  return roots.has(first) ? first : path;
}

/**
 * Audit a section's claims for comparison-scope faithfulness. Structural `sides` violations are always
 * hard errors. Otherwise a `fact` claim earns a warning when it uses comparative wording, declares no
 * `sides`, and every one of its path-bearing evidence items falls in a single source unit — the
 * single-sided-equivalence shape. Claims whose evidence carries no `path` (SCOPE-/CG-/FG-/SEARCH- …)
 * are skipped for the warning but still structurally validated when they declare `sides`.
 */
export function auditComparativeClaims(options: {
  documentId: string;
  sectionIndex: number;
  claims: SectionClaim[];
  evidenceById: Map<string, EvidenceItem>;
  multiRoot: boolean;
  roots: string[];
}): AuditFinding[] {
  const { documentId, sectionIndex, claims, evidenceById, multiRoot } = options;
  const roots = new Set(options.roots);
  const findings: AuditFinding[] = [];
  for (const claim of claims) {
    const violations = validateComparisonSides(claim);
    if (violations.length) {
      for (const message of violations) findings.push({ level: "error", document: documentId, message: `section ${sectionIndex}: ${message}` });
      continue;
    }
    if (claim.marker !== "fact") continue;
    if (claim.sides) continue; // a well-formed declared grouping already establishes every side
    if (!comparativeWording(claim.statement)) continue;
    const paths = (claim.evidenceIds ?? [])
      .map((id) => evidenceById.get(id)?.path)
      .filter((path): path is string => typeof path === "string" && path.length > 0);
    if (!paths.length) continue; // no path-bearing evidence to scope
    const units = new Set(paths.map((path) => sideUnit(path, multiRoot, roots)));
    if (units.size <= 1) {
      findings.push({
        level: "warning",
        document: documentId,
        message: `section ${sectionIndex}: fact claim ${claim.id} uses comparative wording but cites a single source unit; cite evidence for every compared side and declare \`sides\`, or downgrade to \`inferred\``
      });
    }
  }
  return findings;
}
