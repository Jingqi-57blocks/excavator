import { readFile, readdir, copyFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { escapeHtml, parseFrontMatter, renderMarkdown } from "./markdown.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Page {
  input: string;
  stem: string;
  metadata: Record<string, string>;
  body: string;
  title: string;
  navTitle: string;
  order: number;
  outputName: string;
}

export async function buildSite(options: { inputs: string[]; output: string; title?: string }): Promise<{ pages: Array<{ title: string; output: string }>; output: string }> {
  const inputFiles = await expandInputs(options.inputs);
  if (!inputFiles.length) throw new Error("No Markdown files were found");
  const pages: Page[] = [];
  for (const input of inputFiles) {
    const parsed = parseFrontMatter(await readFile(input, "utf8"));
    const title = parsed.metadata.title || firstHeading(parsed.body) || basename(input, extname(input));
    pages.push({
      input,
      stem: basename(input, extname(input)),
      metadata: parsed.metadata,
      body: parsed.body,
      title,
      navTitle: parsed.metadata.navTitle || title,
      order: Number(parsed.metadata.order ?? 100),
      outputName: ""
    });
  }
  // Order by document-type priority before the per-run `order`, so merging an overview site
  // (orders 1-2) with a feature site (orders 1-23) keeps overviews first and never collides on
  // ordinals that are only unique within a single run's front matter.
  pages.sort((a, b) => kindPriority(a.metadata.kind) - kindPriority(b.metadata.kind) || a.order - b.order || a.title.localeCompare(b.title));
  const overview = pages.find((page) => page.metadata.kind === "overview" && page.metadata.audience === "product") ?? pages.find((page) => page.metadata.kind === "overview") ?? pages[0];
  for (const page of pages) page.outputName = page === overview ? "index.html" : `${slug(page.stem)}.html`;

  const output = resolve(options.output);
  await mkdir(join(output, "assets"), { recursive: true });
  await copyFile(join(HERE, "report.css"), join(output, "assets", "report.css"));
  await copyFile(join(HERE, "report.js"), join(output, "assets", "report.js"));
  const siteTitle = options.title || overview.title;
  for (const page of pages) await writeFile(join(output, page.outputName), renderPage(page, pages, siteTitle), "utf8");
  return { pages: pages.map((page) => ({ title: page.title, output: page.outputName })), output };
}

async function expandInputs(inputs: string[]): Promise<string[]> {
  const result: string[] = [];
  for (const input of inputs) {
    const path = resolve(input);
    if (extname(path).toLowerCase() === ".md") { result.push(path); continue; }
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch { continue; }
    result.push(...entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md")).map((entry) => join(path, entry.name)));
  }
  return [...new Set(result)].sort();
}

function renderPage(page: Page, pages: Page[], siteTitle: string): string {
  const nav = pages.map((item) => `<a class="${item === page ? "active" : ""}" href="${escapeHtml(item.outputName)}">${escapeHtml(item.navTitle)}</a>`).join("");
  const featurePages = pages.filter((item) => item.metadata.kind === "feature");
  const moduleHub = page.outputName === "index.html" && featurePages.length
    ? `<section class="module-hub"><h2>功能模块</h2><div class="module-grid">${featurePages.map((item) => `<a class="module-card" href="${escapeHtml(item.outputName)}"><strong>${escapeHtml(item.navTitle)}</strong><span>${escapeHtml(item.title)}</span></a>`).join("")}</div></section>`
    : "";
  const content = renderMarkdown(page.body.replace(/^#\s+.*$/m, "").trim());
  const language = page.metadata.language || "zh-CN";
  const labels = ariaLabels(language);
  const snapshot = page.metadata.snapshot ? `Source snapshot: ${escapeHtml(page.metadata.snapshot)}` : "Static source review";
  return `<!DOCTYPE html>\n<html lang="${escapeHtml(language)}"><head><meta charset="utf-8"/><meta content="width=device-width,initial-scale=1" name="viewport"/><title>${escapeHtml(page.title)}</title><link href="assets/report.css" rel="stylesheet"/></head><body>\n<header class="site-header"><div class="header-inner"><a class="brand" href="index.html">${escapeHtml(siteTitle)}</a><nav aria-label="${escapeHtml(labels.reportModules)}" class="global-nav">${nav}</nav></div></header>\n<div class="layout"><aside class="sidebar"><p class="sidebar-label">本页目录</p><nav aria-label="${escapeHtml(labels.tableOfContents)}" class="toc" id="toc"></nav></aside><main class="main"><section class="hero"><h1>${escapeHtml(page.title)}</h1></section>${moduleHub}<article class="content">${content}</article><div class="diagram-status">图表无法渲染。请连接网络后重新加载。</div></main></div>\n<footer class="footer">${snapshot}</footer><button aria-label="${escapeHtml(labels.backToTop)}" class="back-to-top">↑</button><dialog class="diagram-dialog" id="diagramDialog"><div class="dialog-head"><strong>图表详情</strong><button class="dialog-close">关闭</button></div><div class="dialog-body"></div></dialog><script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script><script src="assets/report.js"></script></body></html>`;
}

/**
 * Document-type ordering weight: overviews sort ahead of features, and any other/unknown `kind`
 * sorts last. This is the primary navigation sort key so a merged multi-run site is stable without
 * renumbering per-run `order` front matter.
 */
const KIND_PRIORITY: Record<string, number> = { overview: 0, feature: 1 };
function kindPriority(kind: string | undefined): number {
  return kind !== undefined && kind in KIND_PRIORITY ? KIND_PRIORITY[kind] : KIND_PRIORITY.feature + 1;
}

/** Accessibility labels localized off the report `language` front matter (zh vs. everything else). */
function ariaLabels(language: string): { reportModules: string; tableOfContents: string; backToTop: string } {
  return language.toLowerCase().startsWith("zh")
    ? { reportModules: "报告模块", tableOfContents: "本页目录", backToTop: "返回顶部" }
    : { reportModules: "Report modules", tableOfContents: "Table of contents", backToTop: "Back to top" };
}

function firstHeading(body: string): string | null { return body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null; }
function slug(value: string): string { return value.toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "") || "report"; }
