# 待裁决清单

> 角色：规划层挂起项账本（见 `docs/development.md` 的 P 节点）。每项由规划层起草，随 feat→main 的 PR（触点一）一并呈给用户裁决；裁决后移除或转入 Linear。

## 已裁决 · 2026-08-07（触点一 PR #11 后）

- **证据 ID 扫描器边界语义**（原 #1，PR #7）→ **接受现状**：消除伪 ID 级联的收益大于目录外 typo 静默的损失。放宽 lookahead 的备选留档于 git 历史。
- **`grant_type` 类同行过度脱敏**（原 #3，PR #8）→ **接受现状**：fail-closed 方向，已用测试钉住；根治需键值配对解析，暂不做。
- **特征作用域接口→实现盲区**（原 #5，Wave 0 实测）→ **转 Phase 2（57B-320）量化输入**，`leave` gold 集（84 项）锁为该阶段召回验收基准。完整分析见 git 历史与 PR #11 正文。

## 已裁决 · 批次 C 合同（2026-08-07）

批次 C 的更严检查会让升版前的历史 run 重审掉绿。用户裁定两条，落地为批次 C 的实现契约：

- **存量兼容 = 版本门控**：run 在 prepare 时打一个 assurance/check 版本戳；audit 对**新 run（当前版本）**施加新的严格检查为 error，对**历史 run（旧版本）**grandfather（不追溯，降级/跳过）。此一机制统一覆盖：证据层级检查统一、`FACT-*` 前缀纳入伪 ID 扫描集（原 #4）、脱敏变更 × 历史 run 重审（原 #2，`auditEvidenceCatalog` 逐字比对不再让存量掉绿）、以及下面的枚举对账。**不做**版本感知逐条比对或迁移工具（更重，非本阶段）。
- **枚举对账 = advisory / 分类目**：detailed 报告的枚举章节未覆盖事实包某行时，**作为 warning**，或仅对**未截断的小类目**（states / config-keys 等）强制；**不做** "缺行即 hard error"（Wave 0 实测事实包入口达 405 项且截断，硬 error 会让每份报告都挂）。

原待裁决 #2、#4 由此吸收为批次 C 的执行项，不再单列。

## 批次 C 已知项 · 威胁模型（记录，非缺陷；随 C 收口 PR 呈报）

- **版本门控的信任边界**（fable C1 评审）：assurance 版本门控信任 manifest 自报的 `assuranceVersion`。能全权写 run 目录的对手可将其改旧、绕过活源码再推导（grandfather 路径下同时改写 content+digest 即自洽）。audit 的保证是**防漂移/事故**，不是防对 run 目录的全权写入者——这是"版本门控、不做逐项迁移"裁决的固有边界，非缺陷。
- **`src/run.ts` 残余无反引号标记正则**（fable C3 评审）：C3 把证据层级检查收敛到 `markersIn`（要求反引号）后，另一条检查"章节含标记词 → 必须有 `<details>` 证据块"仍用**不要求反引号**的正则，散文中偶发"验证/推断"会误要求 details 块。先于 C3 存在、不在其范围。候选后续批次一并收敛到 `markersIn`。

## 批次 G（57B-349，per-module CodeGraph）评审产生

- **规划层升级（需裁决）——leaf-only 拆分在"根自带 marker"时的盲区**（fable G 评审）：per-module 拆分规则是"叶子 marker + ≥2 即拆"。当仓库**根**自带 `go.mod`/`package.json`，且又有 ≥2 个嵌套 marker（如 Go 仓的 `examples/*/go.mod`、JS 仓的 `docs/` + `e2e/` 各自 `package.json`——都常见）时，根被排除出 leaf → **主代码树失去图导航，只有边角目录得图**。行为安全（source fallback + coverage warning，不产生假边），但"单目标行为不变"护栏在此类目标的 build 侧实质被破。候选裁决：根有 marker 且未声明 workspaces 时抑制拆分。
- **备忘（非缺陷，记录）**：`CodeGraphSet` census 元数据 `Object.assign` 后模块覆写前模块（census 有损、仍确定性）；`toGlobal(dir, ".")` 产生 `service-a/.` 的 root 标签（census 美观）；`CodeGraphSet` 构造中第 N 个库打开失败时前 N-1 个 sqlite 句柄泄漏（CLI 进程退出兜底，安全但不干净）。

## 协调项 · 57B-351 × 57b-329 合同收敛

- **`sides` 需并入 Claim 合同**（57B-351 落地）：本切片给 `SectionClaim` 增补可选字段 `sides?: string[][]`（跨源比较声明的按侧证据分组）。分支 `57b-329` 的 `schemas/` v1 Claim JSON Schema 目前无此字段。两分支收敛时，需在该 Schema 补 `sides`（可选、additive；每组为 `evidenceIds` 的非空、两两不相交子集）。属协调项，非本切片改动。

## 批次 57B-351（比较 claim 忠实性）评审产生

- **方案假设修正（记录，非缺陷）**：plan-of-record 的 FP 回测称"0 噪声误报"，实际落地在真实 WCP run 上出现 3 条噪声误报——`同一自然日`（04/claim-18、04/claim-55）、`共享存储`（06/claim-36）命中了裁定保留的 `同一`/`共享` 词条。不构成升级：advisory 通道本就设计为吸收不精确、退出码不受影响（0 error）、每条 warning 带 claim id 易分诊，且收窄词表有真阳损失风险（`同一` 是 claim-1 `同一批` 的必保真阳）。
- **词表调优候选（需更多样本后再裁决）**：`同一` + 时间量词负向前瞻 `同一(?![^\s]{0,3}[日天月年])`——可精确消灭 `同一自然日/同一天` 类而保住 `同一批/同一套/同一份`；`共享` + 资源名词（如 `共享存储`）保持现状不动——"两组件共享同一存储"本身可能是合法双侧断言，机械零模型不可判别，属固有残差。
- **延后的非阻断测试缺口（fable 评审）**：`claim-comparison.test.ts` 缺两条负对照——`verified` marker 的比较句不告警（现仅由 `inferred` 用例间接覆盖 fact-only 裁决）、多根模式下 path 首段不匹配任何 root 的退化路径。可在后续切片补，不阻断本切片。

## 批次 57B-353（workdir 统一 .work）产生

- **`.work` 未进快照默认忽略表（需裁决，audit-semantic）**：Slice 1 把默认 workdir 从 `.excavator-work` 改为 `.work`，但 `src/snapshot.ts:39` 的默认忽略表含 `.excavator`/`.excavator-work` 却**不含 `.work`**。当**目标仓自身**含顶层 `.work/`（如分析 excavator 仓本身、或目标采用了 `.work`）时，`.work/` 会进入快照语料并影响哈希——旧默认 `.excavator-work` 是被忽略的，故属本次改名引入的 parity 退化。**未在 Slice 1 修**：改默认忽略表会改 `ignoreRulesDigest` → 快照身份，属 audit-semantic，且需先核清 audit 是"用 manifest 捕获的忽略规则"还是"按当前代码重新派生"（决定历史 run 重审是否会 `identity changed` 掉绿），再定是否需版本门控。候选并入 Slice 2（保证链切片）处理，或单列。低危（多数目标 workdir 与目标仓分离，不触发）。

## 批次 57B-354（Slice 2 保证链/事实包正确性）评审产生

- **#6b 比较词表残余过/欠匹配（advisory 固有残差，非缺陷）**（fable 评审）：收窄后仍有两处——`与…` 模式的分隔符类不含 ASCII 标点，`与 legacy 解耦, 日志格式一致` 会跨 ASCII 逗号误触发；`与…一致` 分支无 `(?!性)` 前瞻，`行为一致性良好` 会误触发。另有欠匹配：无 `与/两者` 连接词的裸 `相同`（`两套服务使用相同的取整规则`）不再触发。均被 fact+单源+无 sides 的后置门控稀释、且 advisory 不改通过性。后续如需再收窄可加 ASCII 标点分隔 + `一致(?!性)` 统一前瞻，但要防真阳损失。
- **README checklist 终态漂移（并入 Slice 3 doc 一并修）**：`README.md:65` 仍写 checklist 终态只有 hit/searched-not-found/cannot-determine，未含本片新增的 `not-applicable`。评审建议勿在 Slice 2 顺手改；随 Slice 3（可读性/文档切片）一并订正。
- **57B-329 schema 对齐补充**：若 `57b-329` 分支的 artifact schema 扩展到 checklist/workitems，其 verdict 枚举须含 `not-applicable`（与已记的 `sides` 协调项并列）。

## 批次 57B-355（Slice 3 可读性 advisory）评审产生

- **overview:product §3/§8 "表或列表"张力（advisory 噪声候选，非缺陷）**（fable 评审）：这两节的模板 directive 允许"表或嵌套列表"，但它们在 `READABILITY_TABLE_SECTIONS` advisory 集合内——作者按 directive 选列表仍会收到"consider a table (advisory)"warning。措辞为建议式、不改通过性，属批准集合内既定选择。若后续 warning 噪声反馈集中于此，把这两节判定放宽为"table 或 Markdown list 任一即可"。
- **模板 directive 比 advisory 检查更严的保守不对称（记录，非缺陷）**：部分模板强制要求表格（feature:product §4 states、§12 coverage、overview:product §6/§10、engineering-overview §12）但对应索引不在 advisory 集合——directive 比检查严。刻意保守（漏提醒而非误提醒）。后续可对齐。

## 批次 57B-360（run 可观测性 · view 增量）产生

- **图查询无 timeline 事件，per-query 过程叙事需 Core 改动（决策押后 · R3）**：`eval view` 的过程叙事逐条渲染 timeline 事件，但图查询在 timeline 中**没有事件**（metrics 仅报 `graphQueries`/`graphQueryCacheHits` 计数）。要给图查询做 per-query 过程叙事，需 Core 往 timeline 加图查询事件（动哈希链事件流），属 Core 改动，决策押后。view 现状：图查询只显示计数，并在渲染中注明"no per-query timeline events exist"。
