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

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    if (/^<details[\s>]/i.test(line.trim())) {
      const block: string[] = [line];
      index += 1;
      while (index < lines.length) {
        block.push(lines[index]);
        if (/<\/details>/i.test(lines[index])) { index += 1; break; }
        index += 1;
      }
      out.push(block.join("\n"));
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
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^---+$/.test(line.trim())) { out.push("<hr/>"); index += 1; continue; }

    if (isTableHeader(lines, index)) {
      const headers = splitTableRow(lines[index]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) { rows.push(splitTableRow(lines[index])); index += 1; }
      out.push(`<div class="table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, column) => `<td>${inline(row[column] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) { quote.push(lines[index].replace(/^>\s?/, "")); index += 1; }
      out.push(`<div class="note-box">${paragraphs(quote.join("\n"))}</div>`);
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
        items.push(`<li>${inline(match[1])}</li>`);
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
      out.push(`<div class="conclusion-callout"><div class="conclusion-title">${inline(match[1])}</div><p>${inline(match[2])}</p></div>`);
    } else if (/^\*\*(警告|注意|限制|Warning|Note)\*\*/i.test(text)) {
      out.push(`<div class="warning-box">${inline(text)}</div>`);
    } else out.push(`<p>${inline(text)}</p>`);
  }
  return out.join("\n");
}

function paragraphs(value: string): string { return value.split(/\n{2,}/).map((part) => `<p>${inline(part.replace(/\n/g, " "))}</p>`).join(""); }

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index];
  return /^#{1,6}\s+/.test(line) || /^```/.test(line) || /^>\s?/.test(line) || /^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line) || /^<details[\s>]/i.test(line.trim()) || /^---+$/.test(line.trim()) || isTableHeader(lines, index);
}

function isTableHeader(lines: string[], index: number): boolean {
  return index + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[index]) && /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(lines[index + 1]);
}

function splitTableRow(line: string): string[] { return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()); }

function inline(input: string): string {
  const placeholders: string[] = [];
  let value = input.replace(/`([^`]+)`/g, (_, code: string) => {
    const token = code.trim().toLowerCase();
    if (["事实", "fact"].includes(token)) return stash('<span class="tag fact">事实</span>');
    if (["推断", "inferred", "inference"].includes(token)) return stash('<span class="tag infer">推断</span>');
    if (["验证", "verified"].includes(token)) return stash('<span class="tag verify">验证</span>');
    if (["不可得", "unavailable"].includes(token)) return stash('<span class="tag unavailable">不可得</span>');
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
