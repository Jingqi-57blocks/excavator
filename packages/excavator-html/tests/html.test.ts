import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tempDir } from "../../../tests/temp-dir.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { buildSite } from "../src/renderer.ts";

async function temp(): Promise<string> { return tempDir("excavator-html-"); }

function page(meta: Record<string, string>, heading: string): string {
  const front = Object.entries(meta).map(([key, value]) => `${key}: ${value}`).join("\n");
  return `---\n${front}\n---\n# ${heading}\n\n## 1. ${heading}\n\n这是事实。\n`;
}

test("HTML navigation is generated only from supplied Markdown modules", async () => {
  const root = await temp();
  const reports = join(root, "reports");
  const output = join(root, "site");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(reports));
  await writeFile(join(reports, "product-overview.md"), `---\ntitle: 项目概览（非技术）\nnavTitle: 产品概览\nkind: overview\naudience: product\norder: 10\nlanguage: zh-CN\nmarkerFact: 事实\n---\n# 项目概览（非技术）\n\n## 1. 项目定位\n\n这是事实。\`事实\`\n\n\`\`\`mermaid\nflowchart LR\nA --> B\n\`\`\`\n`);
  await writeFile(join(reports, "access-product.md"), `---\ntitle: Account access (product)\nnavTitle: Account access\nkind: feature\naudience: product\norder: 20\nlanguage: zh-CN\n---\n# Account access\n\n## 1. 功能边界\n\n<details><summary>依据</summary><p>source</p></details>\n`);
  const result = await buildSite({ inputs: [reports], output, title: "Project reports" });
  assert.deepEqual(result.pages.map((page) => page.output), ["index.html", "access-product.html"]);
  const index = await readFile(join(output, "index.html"), "utf8");
  assert.match(index, />产品概览<\/a>/);
  assert.match(index, />Account access<\/a>/);
  assert.doesNotMatch(index, /Billing/);
  assert.match(index, /class="mermaid"/);
  assert.match(index, /class="tag fact"/);
  const css = await readFile(join(output, "assets", "report.css"), "utf8");
  assert.match(css, /\.site-header/);
});

test("merging runs orders overview pages ahead of features regardless of per-run order", async () => {
  const root = await temp();
  const reports = join(root, "reports");
  const output = join(root, "site");
  await mkdir(reports);
  // An overview run (orders 1-2) merged with a feature run (orders 1-23): the ordinals collide, so
  // the doc-type priority must decide, keeping both overviews before every feature.
  await writeFile(join(reports, "overview-1.md"), page({ title: "Overview one", navTitle: "OverviewOne", kind: "overview", audience: "product", order: "1", language: "en-US" }, "Overview one"));
  await writeFile(join(reports, "overview-2.md"), page({ title: "Overview two", navTitle: "OverviewTwo", kind: "overview", audience: "engineering", order: "2", language: "en-US" }, "Overview two"));
  await writeFile(join(reports, "feature-a.md"), page({ title: "Feature A", navTitle: "FeatureA", kind: "feature", audience: "product", order: "1", language: "en-US" }, "Feature A"));
  await writeFile(join(reports, "feature-b.md"), page({ title: "Feature B", navTitle: "FeatureB", kind: "feature", audience: "product", order: "2", language: "en-US" }, "Feature B"));
  await writeFile(join(reports, "feature-c.md"), page({ title: "Feature C", navTitle: "FeatureC", kind: "feature", audience: "product", order: "23", language: "en-US" }, "Feature C"));
  const result = await buildSite({ inputs: [reports], output, title: "Merged reports" });
  assert.deepEqual(result.pages.map((item) => item.title), ["Overview one", "Overview two", "Feature A", "Feature B", "Feature C"]);
  assert.equal(result.pages[0].output, "index.html", "the product overview stays the landing page");
});

test("build derives <parent>/html-reports when --output is omitted for a single directory input", async () => {
  const root = await temp();
  const reports = join(root, "reports");
  await mkdir(reports);
  const runId = "run-2026_08_10_09_30-abcd1234-ef567890-0011aabb";
  await writeFile(join(reports, "overview.md"), page({ title: "Overview", navTitle: "Overview", kind: "overview", audience: "product", order: "1", language: "en-US", run: runId }, "Overview"));

  const result = await buildSite({ inputs: [reports] });
  assert.equal(result.output, join(root, "html-reports"), "the default output sits beside the input directory");
  const index = await readFile(join(root, "html-reports", "index.html"), "utf8");
  assert.match(index, new RegExp(`Run: ${runId}`), "the run-id from front matter reaches the footer");
});

test("a report without a run front-matter key renders no run line", async () => {
  const root = await temp();
  const reports = join(root, "reports");
  await mkdir(reports);
  await writeFile(join(reports, "overview.md"), page({ title: "Overview", navTitle: "Overview", kind: "overview", audience: "product", order: "1", language: "en-US" }, "Overview"));
  await buildSite({ inputs: [reports], output: join(root, "site") });
  const index = await readFile(join(root, "site", "index.html"), "utf8");
  assert.doesNotMatch(index, /Run:/, "an absent run key stays graceful for older reports");
});

test("omitting --output errors for a file input or multiple inputs", async () => {
  const root = await temp();
  const reports = join(root, "reports");
  await mkdir(reports);
  const file = join(reports, "overview.md");
  await writeFile(file, page({ title: "Overview", navTitle: "Overview", kind: "overview", audience: "product", order: "1", language: "en-US" }, "Overview"));
  await assert.rejects(buildSite({ inputs: [file] }), /--output is required/, "a single file input has no unambiguous default output");
  await assert.rejects(buildSite({ inputs: [reports, reports] }), /--output is required/, "multiple inputs have no unambiguous default output");
});

test("UI chrome (aria labels) is neutral English regardless of report language — no per-language template", async () => {
  const root = await temp();
  const zhOut = join(root, "zh");
  const enOut = join(root, "en");
  const zhReports = join(root, "zh-src");
  const enReports = join(root, "en-src");
  await mkdir(zhReports);
  await mkdir(enReports);
  await writeFile(join(zhReports, "overview.md"), page({ title: "概览", navTitle: "概览", kind: "overview", audience: "product", order: "1", language: "zh-CN" }, "概览"));
  await writeFile(join(enReports, "overview.md"), page({ title: "Overview", navTitle: "Overview", kind: "overview", audience: "product", order: "1", language: "en-US" }, "Overview"));

  // A zh report gets the SAME neutral English chrome — the report content carries the language, the
  // chrome is not a maintained zh/en translation table.
  await buildSite({ inputs: [zhReports], output: zhOut, title: "zh" });
  const zh = await readFile(join(zhOut, "index.html"), "utf8");
  assert.match(zh, /aria-label="Report modules"/);
  assert.match(zh, /aria-label="Table of contents"/);
  assert.match(zh, /aria-label="Back to top"/);
  assert.doesNotMatch(zh, /aria-label="报告模块"|aria-label="本页目录"|aria-label="返回顶部"/);

  await buildSite({ inputs: [enReports], output: enOut, title: "en" });
  const en = await readFile(join(enOut, "index.html"), "utf8");
  assert.match(en, /aria-label="Report modules"/);
  assert.match(en, /aria-label="Table of contents"/);
  assert.match(en, /aria-label="Back to top"/);
});

// An evidence chip DISPLAYS the report's own marker word; the concept class comes from the report's
// marker vocabulary — the neutral English built-in, or a front-matter `markerFact: …` declaration for
// any other language. Chrome is neutral English. This proves there is no hard-coded per-language label
// table. `body` is a paragraph the renderer keeps (the leading `#` heading is stripped by renderPage).
function reportPage(meta: Record<string, string>, heading: string, body: string): string {
  const front = Object.entries(meta).map(([key, value]) => `${key}: ${value}`).join("\n");
  return `---\n${front}\n---\n# ${heading}\n\n## ${heading}\n\n${body}\n`;
}

test("evidence chip shows the report's OWN marker word (built-in EN or declared vocabulary); chrome is neutral English", async () => {
  const root = await temp();
  const enReports = join(root, "en-src");
  const zhReports = join(root, "zh-src");
  const enOut = join(root, "en");
  const zhOut = join(root, "zh");
  await mkdir(enReports);
  await mkdir(zhReports);

  // en report: English markers are the neutral built-in vocabulary — no declaration needed.
  await writeFile(join(enReports, "overview.md"), reportPage({ title: "Overview", navTitle: "Overview", kind: "overview", audience: "product", order: "1", language: "en-US" }, "Overview", "Markers: `fact` `inferred` `verified` `unavailable`."));
  await writeFile(join(enReports, "feature.md"), reportPage({ title: "Feature one", navTitle: "Feature one", kind: "feature", audience: "product", order: "2", language: "en-US" }, "Feature one", "Body."));
  await buildSite({ inputs: [enReports], output: enOut, title: "Reports" });
  const en = await readFile(join(enOut, "index.html"), "utf8");
  assert.match(en, /<span class="tag fact">fact<\/span>/);
  assert.match(en, /<span class="tag infer">inferred<\/span>/);
  assert.match(en, /<span class="tag verify">verified<\/span>/);
  assert.match(en, /<span class="tag unavailable">unavailable<\/span>/);
  assert.match(en, /<h2>Feature modules<\/h2>/);
  assert.match(en, /class="sidebar-label">On this page</);

  // zh report: declares its marker vocabulary in front matter; chips show the report's OWN words, the
  // concept classes are unchanged, and the chrome stays neutral English (no hard-coded Chinese chrome).
  await writeFile(join(zhReports, "overview.md"), reportPage({ title: "概览", navTitle: "概览", kind: "overview", audience: "product", order: "1", language: "zh-CN", markerFact: "事实", markerInferred: "推断", markerVerified: "验证", markerUnavailable: "不可得" }, "概览", "标记：`事实` `推断` `验证` `不可得`。"));
  await writeFile(join(zhReports, "feature.md"), reportPage({ title: "功能一", navTitle: "功能一", kind: "feature", audience: "product", order: "2", language: "zh-CN" }, "功能一", "正文。"));
  await buildSite({ inputs: [zhReports], output: zhOut, title: "报告" });
  const zh = await readFile(join(zhOut, "index.html"), "utf8");
  assert.match(zh, /<span class="tag fact">事实<\/span>/);
  assert.match(zh, /<span class="tag infer">推断<\/span>/);
  assert.match(zh, /<span class="tag verify">验证<\/span>/);
  assert.match(zh, /<span class="tag unavailable">不可得<\/span>/);
  // Chrome stays neutral English even for a zh report; no hard-coded Chinese chrome leaks in.
  assert.match(zh, /class="sidebar-label">On this page</);
  assert.doesNotMatch(zh, /本页目录|功能模块|图表详情|图表无法渲染|返回顶部/);
});
