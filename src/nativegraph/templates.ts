/**
 * Best-effort Zope template inventory (ZPT/TAL `.zpt`, DTML `.dtml`).
 *
 * Templates are NOT fully parsed — they are scanned with regexes for the binding directives that
 * reference server-side names (TAL `tal:content` / `metal:use-macro`; DTML `<dtml-var>` / `&dtml-…;`).
 * The result is a coverage inventory (how many templates, which names they reference most), not a
 * resolved call graph. Callers must treat these as textual references, not verified dispatch.
 */

import type { TemplateInventory } from "./types.ts";

export interface TemplateEntry {
  file: string;
  kind: "zpt" | "dtml";
  content: string;
}

const TAL_ATTR = /\b(?:tal|metal):[a-z-]+\s*=\s*"([^"]*)"/g;
const DTML_TAG = /<\/?dtml-([a-z]+)\b([^>]*)>/gi;
const DTML_ENTITY = /&dtml-([A-Za-z_][\w.]*)\b/g;
const DTML_NAME_ATTR = /\b(?:name|expr)\s*=\s*"([^"]*)"/i;

/** Scan template entries into a distinct, count-ranked reference inventory. */
export function scanTemplates(entries: TemplateEntry[]): TemplateInventory {
  const counts = new Map<string, number>();
  let zptFiles = 0;
  let dtmlFiles = 0;

  for (const entry of entries) {
    if (entry.kind === "zpt") {
      zptFiles++;
      for (const match of entry.content.matchAll(TAL_ATTR)) {
        for (const name of talNames(match[1])) bump(counts, name);
      }
    } else {
      dtmlFiles++;
      for (const match of entry.content.matchAll(DTML_TAG)) {
        const attr = DTML_NAME_ATTR.exec(match[2]);
        const name = attr ? firstToken(attr[1]) : match[1];
        if (name) bump(counts, name);
      }
      for (const match of entry.content.matchAll(DTML_ENTITY)) bump(counts, match[1]);
    }
  }

  const refs = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || cmp(a.name, b.name));

  return { zptFiles, dtmlFiles, refs };
}

/** Pull referenced names out of one TAL expression value (`here/foo`, `python:x.y()`, `a b`). */
function talNames(expr: string): string[] {
  const names: string[] = [];
  for (const part of expr.split(/[;|]/)) {
    const token = firstToken(part.trim());
    if (!token) continue;
    // A slash path (`here/getTitle`) references its last segment; keep other tokens whole.
    const seg = token.includes("/") ? token.slice(token.lastIndexOf("/") + 1) : token;
    if (/^[A-Za-z_][\w.]*$/.test(seg)) names.push(seg);
  }
  return names;
}

function firstToken(value: string): string {
  const cleaned = value.replace(/^(?:python|string|path|not|exists|nocall):\s*/, "").trim();
  const match = /[A-Za-z_][\w./]*/.exec(cleaned);
  return match ? match[0] : "";
}

function bump(counts: Map<string, number>, name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
