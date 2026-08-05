# excavator-html

A standalone Markdown-to-static-HTML converter. It imports no Excavator analysis code and does not read CodeGraph, source trees, caches, or run manifests.

```bash
./packages/excavator-html/src/cli.ts build \
  --input .excavator-work/runs/<run-id>/reports \
  --output ./report-site \
  --title "Project report"
```

Every Markdown file may define front matter:

```yaml
---
title: 项目概览（非技术）
navTitle: 产品概览
kind: overview
audience: product
order: 10
language: zh-CN
---
```

Only files supplied to the command appear in the top navigation. A product overview becomes `index.html` when present; otherwise the first overview or first file becomes the index.
