export interface MarkdownDocument {
  metadata: Record<string, string>;
  body: string;
}

export function parseFrontMatter(input: string): MarkdownDocument {
  const normalized = input.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { metadata: {}, body: normalized };
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return { metadata: {}, body: normalized };
  const metadata: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) metadata[match[1].trim()] = stripQuotes(match[2].trim());
  }
  return { metadata, body: normalized.slice(end + 5) };
}

/** The report `language` front matter selects Chinese vs. the English default for all rendered UI text. */
export function isZhLanguage(language: string | undefined): boolean {
  return (language ?? "").toLowerCase().startsWith("zh");
}

/** Visible text of the four evidence-marker chips, in the report language (English is the default). */
export interface MarkerLabels { fact: string; infer: string; verify: string; unavailable: string; }
function markerLabels(language: string | undefined): MarkerLabels {
  return isZhLanguage(language)
    ? { fact: "事实", infer: "推断", verify: "验证", unavailable: "不可得" }
    : { fact: "fact", infer: "inferred", verify: "verified", unavailable: "unavailable" };
}

export function renderMarkdown(markdown: string, language?: string): string {
  const markers = markerLabels(language);
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    if (/^<details[\s>]/i.test(line.trim())) {
      const openLine = line;
      index += 1;
      let depth = detailsDepth(openLine);
      if (depth <= 0) {
        // A whole `<details>…</details>` that opens and closes on one line is passed through as raw
        // HTML — its inner markup is authored by hand and must not be re-rendered.
        out.push(openLine);
        continue;
      }
      // Multi-line block: collect the inner lines until depth returns to zero (its matching close),
      // counting nested `<details>` so a nested block's close is not mistaken for this one's.
      const content: string[] = [];
      let closeLine = "";
      let closed = false;
      while (index < lines.length) {
        const current = lines[index];
        depth += detailsDepth(current);
        if (depth <= 0) { closeLine = current; closed = true; index += 1; break; }
        content.push(current);
        index += 1;
      }
      if (!closed) {
        // No matching close before end of input: keep the current swallow-to-EOF behavior, raw.
        out.push([openLine, ...content].join("\n"));
        continue;
      }
      const parts = [openLine];
      let bodyStart = 0;
      // A `<summary>…</summary>` on the first inner line is the block's label: keep it verbatim,
      // never routed through inline() and never treated as body prose.
      if (content.length && /^<summary>.*<\/summary>$/i.test(content[0].trim())) {
        parts.push(content[0]);
        bodyStart = 1;
      }
      // Everything after the summary is real markdown (lists, tables, paragraphs, tag chips) and is
      // rendered recursively — renderMarkdown is a pure function and safely reentrant.
      const inner = renderMarkdown(content.slice(bodyStart).join("\n"), language);
      if (inner) parts.push(inner);
      parts.push(closeLine);
      out.push(parts.join("\n"));
      continue;
    }

    const fence = line.match(/^```([^\s]*)\s*$/);
    if (fence) {
      const language = fence[1].toLowerCase();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) { code.push(lines[index]); index += 1; }
      if (index < lines.length) index += 1;
      if (language === "mermaid") {
        out.push(`<div class="diagram"><button aria-label="Expand diagram" class="diagram-expand" type="button"><svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" stroke-linecap="round" stroke-linejoin="round"></path></svg></button><pre class="mermaid">${escapeHtml(code.join("\n"))}</pre></div>`);
      } else {
        out.push(`<pre><code class="language-${escapeAttribute(language || "text")}">${escapeHtml(code.join("\n"))}</code></pre>`);
      }
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2], markers)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^---+$/.test(line.trim())) { out.push("<hr/>"); index += 1; continue; }

    if (isTableHeader(lines, index)) {
      const headers = splitTableRow(lines[index]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) { rows.push(splitTableRow(lines[index])); index += 1; }
      out.push(`<div class="table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${inline(cell, markers)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, column) => `<td>${inline(row[column] ?? "", markers)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) { quote.push(lines[index].replace(/^>\s?/, "")); index += 1; }
      out.push(`<div class="note-box">${paragraphs(quote.join("\n"), markers)}</div>`);
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const tag = ordered ? "ol" : "ul";
      const items: string[] = [];
      const regex = ordered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/;
      while (index < lines.length) {
        const match = lines[index].match(regex);
        if (!match) break;
        items.push(`<li>${inline(match[1], markers)}</li>`);
        index += 1;
      }
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) { paragraph.push(lines[index]); index += 1; }
    const text = paragraph.join(" ").trim();
    if (/^\*\*(所以呢|这意味着什么|What this means|Conclusion|核心结论)\*\*/i.test(text)) {
      const match = text.match(/^\*\*(.+?)\*\*\s*(.*)$/s)!;
      out.push(`<div class="conclusion-callout"><div class="conclusion-title">${inline(match[1], markers)}</div><p>${inline(match[2], markers)}</p></div>`);
    } else if (/^\*\*(警告|注意|限制|Warning|Note)\*\*/i.test(text)) {
      out.push(`<div class="warning-box">${inline(text, markers)}</div>`);
    } else out.push(`<p>${inline(text, markers)}</p>`);
  }
  return out.join("\n");
}

function paragraphs(value: string, markers: MarkerLabels): string { return value.split(/\n{2,}/).map((part) => `<p>${inline(part.replace(/\n/g, " "), markers)}</p>`).join(""); }

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index];
  return /^#{1,6}\s+/.test(line) || /^```/.test(line) || /^>\s?/.test(line) || /^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line) || /^<details[\s>]/i.test(line.trim()) || /^---+$/.test(line.trim()) || isTableHeader(lines, index);
}

/** Net `<details>` nesting a line contributes: opens minus closes, so a block's matching close is found by depth. */
function detailsDepth(line: string): number {
  const opens = (line.match(/<details[\s>]/gi) ?? []).length;
  const closes = (line.match(/<\/details>/gi) ?? []).length;
  return opens - closes;
}

function isTableHeader(lines: string[], index: number): boolean {
  return index + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[index]) && /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(lines[index + 1]);
}

function splitTableRow(line: string): string[] { return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()); }

function inline(input: string, markers: MarkerLabels): string {
  const placeholders: string[] = [];
  // Both English and Chinese tokens are accepted as input; only the emitted chip text follows `language`.
  let value = input.replace(/`([^`]+)`/g, (_, code: string) => {
    const token = code.trim().toLowerCase();
    if (["事实", "fact"].includes(token)) return stash(`<span class="tag fact">${markers.fact}</span>`);
    if (["推断", "inferred", "inference"].includes(token)) return stash(`<span class="tag infer">${markers.infer}</span>`);
    if (["验证", "verified"].includes(token)) return stash(`<span class="tag verify">${markers.verify}</span>`);
    if (["不可得", "unavailable"].includes(token)) return stash(`<span class="tag unavailable">${markers.unavailable}</span>`);
    return stash(`<code>${escapeHtml(code)}</code>`);
  });
  value = escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, href: string) => `<a href="${escapeAttribute(href)}">${label}</a>`);
  value = value.replace(/@@HTML_(\d+)@@/g, (_, number) => placeholders[Number(number)] ?? "");
  return value;

  function stash(html: string): string { const id = placeholders.push(html) - 1; return `@@HTML_${id}@@`; }
}

export function escapeHtml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
function escapeAttribute(value: string): string { return escapeHtml(value).replace(/`/g, "&#96;"); }
function stripQuotes(value: string): string { return value.replace(/^(["'])(.*)\1$/, "$2"); }
