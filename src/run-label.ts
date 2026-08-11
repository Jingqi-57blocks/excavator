import type { ReportRequest } from "./types.ts";
import { slugify } from "./util.ts";

/** Longest a single feature slug may grow before it is truncated. */
const FEATURE_SLUG_MAX = 16;
/** Longest the whole scope slug may grow before it collapses to a summary form. */
const SCOPE_SLUG_MAX = 48;

/** Truncate to at most `max` Unicode code points, then drop any hyphen left dangling at the cut. */
function clip(value: string, max: number): string {
  return [...value].slice(0, max).join("").replace(/-+$/u, "");
}

/**
 * A short, deterministic, filesystem-safe slug describing what a run documents, for the run directory
 * name. Built only from the requested scope — a leading `"overview"` when any overview is requested,
 * then each feature subject through `slugify` — so it stays framework-agnostic and never hardcodes a
 * target name. Parts keep request order, are de-duplicated, and join with `+`. When the assembled slug
 * would be unreadably long it collapses to `<first-part>+<N-1>more`; an empty scope becomes `"docs"`.
 * Deterministic within a request; the run id keeps its uuid segment for global uniqueness.
 */
export function runScopeSlug(request: Pick<ReportRequest, "overviewAudiences" | "features">): string {
  const parts: string[] = [];
  if (request.overviewAudiences.length) parts.push("overview");
  for (const feature of request.features) {
    const part = clip(slugify(feature.subject), FEATURE_SLUG_MAX);
    if (part) parts.push(part);
  }
  const unique = [...new Set(parts)];
  if (!unique.length) return "docs";
  const joined = unique.join("+");
  if ([...joined].length <= SCOPE_SLUG_MAX) return joined;
  // Too many or too long to read at a glance: keep the first part and count the rest.
  return clip(`${unique[0]}+${unique.length - 1}more`, SCOPE_SLUG_MAX);
}
