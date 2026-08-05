import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite } from "../src/renderer.ts";

async function temp(): Promise<string> { return mkdtemp(join(tmpdir(), "excavator-html-")); }

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
