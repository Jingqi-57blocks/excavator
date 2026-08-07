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
