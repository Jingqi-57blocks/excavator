# Compliance Pack — 基于当前 main 的可做范围与边界

> 状态：2026-08-10，配合 epic **57B-362** 执行。事实源：Linear 57B-362 + project「Excavator Compliance Pack」+ 需求 Document《Excavator Compliance Extension — Requirements》。边界受 `docs/direction.md` **§22**（消费 Core 不复制）、**§二**（近期不建托管式知识图服务）、**§十八**（Core 零模型调用）约束。

## 1. 目的

记录 Compliance Pack 在**当前 main 分支**上能做什么、明确不做什么及原因、以及被推迟部分缺哪些能力才能开始——避免把需要未建地基（稳定身份 / 持久图 / 双快照）的审计关键能力误当作可即时交付。

## 2. 当前 main 提供什么（已核）

命令面：`begin/prepare/report` → `source/search/checkpoint/workitem/trace/checklist` → `assemble` → `audit`；产出 `overview`(product+engineering) 与 `feature` 报告 + `claims/traces/coverage` JSON companions + hash-chain `timeline.jsonl` + 审计门；另有 `codegraph`、`claims scaffold`。数据模型 Evidence→Claim→Trace→Coverage，全部 run/snapshot 作用域；不可变 snapshot 绑 exact commit；Core 零模型调用、本地优先。

## 3. 能基于 main 做（本轮执行范围）

| 项 | 形态 | 交付物 |
|---|---|---|
| L0 · 证据支撑审计（S0a，findings #3） | 新代码 | `claim-receipt-support.ts` + 审计规则 + 真实 golden fixture |
| L0 · 语料↔快照对齐（S0b，findings #4） | 新代码 | `SOURCE_EXTENSIONS`/search 对齐 + `searched-not-found` 可信化 + 真实 fixture |
| SOUP Inventory（FR-4） | 新代码 | 扫 manifest/lockfile/容器的确定性 scanner + 命令 + 真实 fixture |
| Architecture Description（§12） | **既有能力** | 走 `excavator overview`(engineering) 即得草稿，无需新建代码 |
| 结构化证据导出（FR-12 部分） | **既有能力** | claims/traces/coverage JSON companions |

全部要求：确定性、零模型、垂直中立；实现与测试同批、含真实测试；从 264 绿基线增量。

## 4. 明确不做 · 为什么 · 缺什么能力才能开始

| 不做 | 为什么 | 缺什么能力 |
|---|---|---|
| 稳定逻辑身份 / requirement ID 跨 rerun（FR-7） | main 全 run/snapshot 作用域，**无逻辑身份** | L1 身份账本 + 确定性解析器（本 epic 新建，非 main 现有） |
| 持久可查询 traceability 图（FR-3） | companions 是**一次性 run 产物** | L2 本地派生图（本 epic 新建） |
| 真·可追溯矩阵（FR-9 / §13） | Trace 是 per-run、非跨对象一等 link | L1 + L2 |
| Human Review 状态（FR-14） | 对象无 review 维度 | L3 事件流（本 epic 新建） |
| Requirement / Test / Risk 一等对象 | main 只有 overview/feature 报告，无这些对象 | Phase 3 功能/需求理解 |
| 连续合规 / Release diff（UC-3、FR-10） | 无对象级双快照比较 | Phase 5 双快照比较 |
| Change Impact 预测版（§17） | 无 what-if 影响引擎 | Phase 4（"沿已建 link 的可达性"版 L2 落地即可；预测版需 Phase 4） |
| 法规模板 / Compass（L4） | 不在 main，属外部数据 | L4 数据模块（垂直中立护栏下另立 epic） |
| Word / PDF 导出（FR-12） | `packages/excavator-html` 只 MD→HTML；Word/PDF 需 npm 库 | L5 渲染 package（在 `packages/`，不入 Core） |
| 既有文档摄入 + 对账（FR-2） | 无摄入 / 冲突 / 孤儿对账能力 | 新摄入+对账切片 |
| 缺失测试的合成生成 | 超出 Excavator 边界 | 外部 Agent Builder |

## 5. 交叉依赖（影响可辩护性，但归属别处）

回执**诚实性**缺口在「保证链与可用性硬化」线（非本 epic）：findings **#1** 凭据脱敏漏逗号对、**#2** per-file 静默截断（`truncated:false` 少报）、**#5** `maxResults` 上限 200。本 epic S0a 拦住"声明 ≠ 回执"，但"回执 ≠ 现实"仍需该线修复才彻底可辩护。此处**记录为依赖，不在本 epic 顺手做**（守"范围外不顺手改"）。

## 6. 护栏

- **垂直中立**：不做的项里凡涉法规的一律 L4 数据注入，机制层不写死医疗。
- **Core 零 npm 依赖、零模型**；确定性优先，以支撑精确可重复测试。
- **渐进可测**：每片独立可测 + 真实 golden fixture，不攒到最后整测。
- 范围外发现记入 `docs/pending-decisions.md`。
