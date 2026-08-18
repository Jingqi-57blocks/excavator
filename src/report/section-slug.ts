/**
 * Deterministic naming for a run's per-section files.
 *
 * Section files are named `NN-<slug>.md` (paired claims `NN-<slug>.json`) so a run directory reads
 * to a human, while the zero-padded `NN` prefix preserves numeric ordering past ten sections. The slug
 * comes from the *English template* section title — stable and filesystem-safe — not the localized
 * rendered heading. Pure and byte-stable: identical inputs always yield the identical stem.
 */

/**
 * Slug of a section title: drop a leading `"N."`/`"N)"` ordinal, lowercase, non-alphanumerics to `-`,
 * collapse and trim runs of `-`, and cap the length. Returns "" when the title carries no alphanumeric
 * content, so the caller can fall back to the bare number.
 */
export function sectionTitleSlug(title: string, maxLength = 60): string {
  const slug = title
    .replace(/^\s*\d+[.)]\s+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // The length cap can slice mid-token and leave a trailing "-"; trim it again so the stem never ends in "-".
  return slug.slice(0, maxLength).replace(/-+$/g, "");
}

/**
 * The shared filename stem for the 1-based section `index` titled `title`: `NN` when the title yields no
 * slug, otherwise `NN-<slug>`. The section markdown and its claims sidecar share this stem so a section
 * and its claims carry the same name; the leading `NN` stays extractable for ordering.
 */
export function sectionFileStem(index: number, title: string): string {
  const prefix = String(index).padStart(2, "0");
  const slug = sectionTitleSlug(title);
  return slug ? `${prefix}-${slug}` : prefix;
}
