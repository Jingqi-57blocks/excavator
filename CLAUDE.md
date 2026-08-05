# Excavator

AI-first 可辩护代码调查引擎（方向见 `docs/direction.md`）。Node >= 22.5，TypeScript 直跑（type stripping）。**Core 零运行时 npm 依赖、零模型调用。**

## 命令

- `npm test` — 全量测试（node:test，约 5 秒）
- `npm run test:workspace` — 真实工作区冒烟（需 `EXCAVATOR_TARGET`）
- `./src/cli.ts help` — Excavator CLI

## 必读

任何开发工作开始前，读 `docs/development.md`——开发流程状态转移表、模型分工（Fable 决策 / Opus 执行）、Git/PR 约定都在那里。产品方向与阶段护栏见 `docs/direction.md`，工具准入规则见 `docs/tool-selection.md`。任务与依赖以 Linear 看板为准。

## 硬约束

- main 只收 feat 分支的 PR，禁止直推；commit 与 PR title 格式：`<Linear ID>: <描述>`。
- 实现与测试同批提交；不许删除或跳过既有测试保绿；测试失败如实报告。
- Core（`src/`）不得新增运行时 npm 依赖、不得调用模型 API。
- 新逻辑开新文件、单一职责；注释只加关键处。
- 方案范围外的发现记入 `docs/pending-decisions.md`，不顺手修改。
