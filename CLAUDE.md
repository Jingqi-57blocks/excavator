# Excavator

AI-first 可辩护代码调查引擎。Node >= 22.5，TypeScript 直跑（type stripping）。**Core 零模型调用。**

## 命令

- `npm test` — 全量测试（node:test，约 5 秒）
- `npm run test:workspace` — 真实工作区冒烟（需 `EXCAVATOR_TARGET`）
- `./src/cli.ts help` — Excavator CLI

## 必读

任何开发工作开始前，读 `docs/development.md`——开发流程状态转移表、模型分工（Fable 决策 / Opus 执行）、Git/PR 约定都在那里。code → knowledge 的分层契约见 `docs/layering.md`：每层的输入、输出、失败输出与**禁止输入**，改这一段的代码前必读。方向与任务以 Linear 看板为准。

## 硬约束

- main 只收 feat 分支的 PR，禁止直推。**Linear ID 是完成声明**：只有「合并即完成该 issue」时，PR title 与分支名才带 `57B-xxx`（格式 `<Linear ID>: <描述>`）；不交付 issue 的 PR（文档、流程、工具、清理）用 `docs:` / `chore:` 前缀，分支名也不含 ID——带上就会把 issue 误置 Done。
- 实现与测试同批提交；不许删除或跳过既有测试保绿；测试失败如实报告。
- Core（`src/`）不得调用模型 API。
- 新逻辑开新文件、单一职责；注释只加关键处。
- 方案范围外的发现不顺手修改。
- **不为过程创建文档**：`docs/` 只放确定不变的东西，会随代码变的写进代码。不建待裁决清单、决策归档、调研记录、问题清单、状态报告，也不建转述代码机制的说明（见 `docs/development.md` 文档节）。
