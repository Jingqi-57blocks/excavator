import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { buildSite } from "../src/renderer.ts";

async function temp(): Promise<string> { return mkdtemp(join(tmpdir(), "excavator-html-")); }

function page(meta: Record<string, string>, heading: string): string {
  const front = Object.entries(meta).map(([key, value]) => `${key}: ${value}`).join("\n");
  return `---\n${front}\n---\n# ${heading}\n\n## 1. ${heading}\n\n这是事实。\n`;
}

test("HTML navigation is generated only from supplied Markdown modules", async () => {
  const root = await temp();
  const reports = join(root, "reports");
  const output = join(root, "site");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(reports));
  await writeFile(join(reports, "product-overview.md"), `---\ntitle: 项目概览（非技术）\nnavTitle: 产品概览\nkind: overview\naudience: product\norder: 10\nlanguage: zh-CN\n---\n# 项目概览（非技术）\n\n## 1. 项目定位\n\n这是事实。\`事实\`\n\n\`\`\`mermaid\nflowchart LR\nA --> B\n\`\`\`\n`);
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

test("aria labels follow the report language", async () => {
  const root = await temp();
  const zhOut = join(root, "zh");
  const enOut = join(root, "en");
  const zhReports = join(root, "zh-src");
  const enReports = join(root, "en-src");
  await mkdir(zhReports);
  await mkdir(enReports);
  await writeFile(join(zhReports, "overview.md"), page({ title: "概览", navTitle: "概览", kind: "overview", audience: "product", order: "1", language: "zh-CN" }, "概览"));
  await writeFile(join(enReports, "overview.md"), page({ title: "Overview", navTitle: "Overview", kind: "overview", audience: "product", order: "1", language: "en-US" }, "Overview"));

  await buildSite({ inputs: [zhReports], output: zhOut, title: "zh" });
  const zh = await readFile(join(zhOut, "index.html"), "utf8");
  assert.match(zh, /aria-label="报告模块"/);
  assert.match(zh, /aria-label="本页目录"/);
  assert.match(zh, /aria-label="返回顶部"/);

  await buildSite({ inputs: [enReports], output: enOut, title: "en" });
  const en = await readFile(join(enOut, "index.html"), "utf8");
  assert.match(en, /aria-label="Report modules"/);
  assert.match(en, /aria-label="Table of contents"/);
  assert.match(en, /aria-label="Back to top"/);
});

// Build an overview page carrying every evidence marker plus a feature page (so the module-hub renders),
// with the SOURCE tokens deliberately crossed against the report language: the en report authors its
// markers in Chinese and the zh report in English. A pass therefore proves the emitted text follows the
// `language` front matter, not the source token — it cannot regress to echoing input or hardcoding either
// language. `body` is a paragraph the renderer keeps (the leading `#` heading is stripped by renderPage).
function reportPage(meta: Record<string, string>, heading: string, body: string): string {
  const front = Object.entries(meta).map(([key, value]) => `${key}: ${value}`).join("\n");
  return `---\n${front}\n---\n# ${heading}\n\n## ${heading}\n\n${body}\n`;
}

test("evidence markers and UI chrome follow the report language, not the source token", async () => {
  const root = await temp();
  const enReports = join(root, "en-src");
  const zhReports = join(root, "zh-src");
  const enOut = join(root, "en");
  const zhOut = join(root, "zh");
  await mkdir(enReports);
  await mkdir(zhReports);

  // en report: markers authored in Chinese in the source — must still render as the English words.
  await writeFile(join(enReports, "overview.md"), reportPage({ title: "Overview", navTitle: "Overview", kind: "overview", audience: "product", order: "1", language: "en-US" }, "Overview", "Markers: `事实` `推断` `验证` `不可得`."));
  await writeFile(join(enReports, "feature.md"), reportPage({ title: "Feature one", navTitle: "Feature one", kind: "feature", audience: "product", order: "2", language: "en-US" }, "Feature one", "Body."));
  await buildSite({ inputs: [enReports], output: enOut, title: "Reports" });
  const en = await readFile(join(enOut, "index.html"), "utf8");
  // Markers render as the English words, classes unchanged.
  assert.match(en, /<span class="tag fact">fact<\/span>/);
  assert.match(en, /<span class="tag infer">inferred<\/span>/);
  assert.match(en, /<span class="tag verify">verified<\/span>/);
  assert.match(en, /<span class="tag unavailable">unavailable<\/span>/);
  // Chrome renders in English.
  assert.match(en, /<h2>Feature modules<\/h2>/);
  assert.match(en, /class="sidebar-label">On this page</);
  assert.match(en, /Diagrams could not be rendered\. Reconnect and reload\./);
  assert.match(en, /<strong>Diagram detail<\/strong>/);
  assert.match(en, /class="dialog-close">Close</);
  // Nothing Chinese survives anywhere in an en-US report — catches a leaked source token or hardcoded chrome.
  assert.doesNotMatch(en, /[一-鿿]/, "no Chinese survives in an en-US report");

  // zh report: markers authored in English in the source — must still render as the Chinese words.
  await writeFile(join(zhReports, "overview.md"), reportPage({ title: "概览", navTitle: "概览", kind: "overview", audience: "product", order: "1", language: "zh-CN" }, "概览", "标记：`fact` `inferred` `verified` `unavailable`。"));
  await writeFile(join(zhReports, "feature.md"), reportPage({ title: "功能一", navTitle: "功能一", kind: "feature", audience: "product", order: "2", language: "zh-CN" }, "功能一", "正文。"));
  await buildSite({ inputs: [zhReports], output: zhOut, title: "报告" });
  const zh = await readFile(join(zhOut, "index.html"), "utf8");
  // Markers render as the Chinese words, classes unchanged.
  assert.match(zh, /<span class="tag fact">事实<\/span>/);
  assert.match(zh, /<span class="tag infer">推断<\/span>/);
  assert.match(zh, /<span class="tag verify">验证<\/span>/);
  assert.match(zh, /<span class="tag unavailable">不可得<\/span>/);
  // Chrome renders in Chinese.
  assert.match(zh, /<h2>功能模块<\/h2>/);
  assert.match(zh, /class="sidebar-label">本页目录</);
  assert.match(zh, /图表无法渲染。请连接网络后重新加载。/);
  assert.match(zh, /<strong>图表详情<\/strong>/);
  assert.match(zh, /class="dialog-close">关闭</);
  // The English source tokens must not survive as chip text, nor English chrome leak in.
  assert.doesNotMatch(zh, />fact<\/span>/);
  assert.doesNotMatch(zh, />inferred<\/span>/);
  assert.doesNotMatch(zh, /On this page|Feature modules|Diagram detail|Reconnect and reload/);
  assert.doesNotMatch(zh, /class="dialog-close">Close</);
});
