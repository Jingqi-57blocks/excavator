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

- **view 渲染健壮性备忘（非阻断，下增量收）**（fable 评审）：① `render-run-stats.ts` searches 段 `identity:` 行把 `sourceSearches + sourceSearchCacheHits` 之和标为 "timeline events"、未与实际 timeline 搜索事件数比对——退化/截断数据下措辞会显矛盾；改 "expected to equal" 或不等时记 anomaly。② `run-stats.ts computeGaps` 遇不可解析时间戳静默得 0 gap 且 prevAt 变 NaN 级联，不抛异常（前向兼容 OK）但应补 "unparseable timestamp" anomaly。③ header runId 回退读 raw[0] 而非排序后 events[0]（纯装饰）。

## 批次 57B-359 增量 1（冻结/解耦首切片）评审产生（fable，2026-08-10）

增量 1 判定"可合"（软门 + supplement 双裁决逐字兑现、门不漂移、grandfather 字节零扰动、五闸无旁路）。五条非阻塞 finding，按方案纪律记账不顺手改：

- **#1 冻结后审计的单向盲区（should-fix，归增量 2）**：`auditFrozenKnowledge`（`src/freeze.ts:141-170`）检查 2/3/4 是"当前 − 冻结"单向差集（只抓冻结后**新增**未记 supplement 的 evidence/workitem 状态变化/trace）。**冻结后直接编辑文件删除**一条 open-origin（非 required）workitem、或一条未被任何 workitem/claim 引用的 trace → audit 静默通过。`knowledge.workitemsDigest`/`tracesDigest` 已记录但从未与当前文件对账（当前是死重）。required 项删除仍由 `auditWorkItems` "missing" 兜住、evidence 删除由 evidenceDigest 兜住；CLI 的 merge 语义删不掉（仅直接文件篡改可触发），威胁面小。**与方案 §3.2 原文"当前 id 集 − 冻结集"字面一致，属方案预注册残差而非实现偏离。** 增量 2（ASSURANCE_VERSION v3 + 硬门，本就动 audit 语义）补对称检查：冻结集 ⊆ 当前集（post-freeze merge 只增不删，故冻结 id 消失即非法），或直接对账 workitemsDigest/tracesDigest。
- **#2 freeze 对 auditTraces 传空 claim 集（nit）**：`src/freeze.ts:55`。软门世界若模型"先写作后 freeze"，trace step 引用了 claim id → freeze 以"references missing claim id"拒绝，与 audit（传真实 claim 集）在此边缘路径判定不一致——fail-closed 但报错语义误导。可在 `freezeRun` 收集已 checkpoint 的 claims 传入。正常三段流程（freeze 在任何 begin 前）不触发。
- **#3 未冻结 run 静默丢弃完整 supplement 对（nit）**：`src/run.ts` `enforceFreezeGate` 未冻结时返回 undefined，丢弃一个已校验的完整 supplement 对（不记录、不提示）；而只传单个 flag 反而抛错。建议未冻结时对完整 supplement 对给明确报错/提示（"run not frozen, supplement ignored"）。
- **#4 MATERIAL_FLOW_DIMENSIONS 重复（nit）**：`src/freeze.ts:16` 复制了 `src/assurance.ts:654` 的内联维度列表；仅供 completeness 报告数字、不参与门控，漂移只影响报告。可抽公共常量。
- **#5 supplement 成功路径测试覆盖不全（nit）**：`tests/freeze.test.ts` 三处一致性只直测 search 与 workitem 两个变更器；source/checklist/trace 只测拒绝路径（记账共享 `recordSupplement`，风险低）。后续补齐。

## 批次 57B-359 增量 1 真实 e2e 冒烟产生（2026-08-10，leave-mini 三段流程）

e2e 结论：freeze 机制在真实产物上正确（freeze 门抓出真缺口、零 supplement、audit PASS 无 knowledge error）。顺带暴露两项与 57B-359 无关的既有项：

- **`begin` 不为"已开始未完成"文档重置计时器（预存行为，非 57B-359 引入）**：`beginDocument`（`src/run.ts:205`）仅在 `!startedAt || completedAt` 时重置 `startedAt`；对已 `begin` 过、`startedAt` 已置且未 complete 的文档再次 `begin` 不重新计时，唯一重置窗口的是 `resume`（`src/run.ts:701`）。而 `begin` 的 help 文案写"Start or restart one document authoring timer"，语义误导。候选：要么让 `begin` 对未完成文档重新计时，要么订正 help 文案指向 `resume`。低优先，独立于本 issue。
- **`eval` forbidden pin 对结构性分离的诚实否定 FP（已在修，Fable 规划中）**：见正在进行的 eval-harness 修复（57B-358 血脉，独立分支）。真实表格否定（"未发现任何通知发送代码"行的关键字单元格被抽成裸 claim）触发 `no-notification-send` 假阳。**此项不押后——是 3+3 测量前置**，故单独走方案而非仅记账。（备注：e2e 测试请求的 `authorMs=120000` 太小导致每次 checkpoint 抛 timeout，但 section 在抛前已落盘、零丢失——属我测试请求的预算设置，非产品问题，无需处理。）
## 批次 57B-364（报告呈现打磨）评审产生（fable 复核 #2/#3，2026-08-11）

判定"返工"（advisory 缺测试，已补齐同批），核心逻辑经 Fable 逐号核实无误。三条 advisory 残差（warning-only，不阻合）：

- **`auditEvidenceMarkerPlacement` 假阴性：带 bullet 前缀的引导语逃检（nit）**：`EVIDENCE_LEVEL_LEAD_IN`（`src/assurance.ts:509`）锚定行首，未剥列表前缀，故 `- 证据级别: \`fact\`` 形态（引导语前带 `- `）不触发 warning。warning-only、影响小；后续如需可在检测前剥 `^\s*[-*+]\s+`。
- **advisory 的 `EVIDENCE_MARKER_WORD` 口径比 `markersIn` 宽（nit）**：`src/assurance.ts:510` 无反引号的裸"事实"独行也触发 warning，而硬路径 `markersIn` 要求 CJK 必须带反引号。退化场景、warning-only、不影响硬路径判定。
- **attribution 常量不做版本门控（planner 已自标注，fail-open）**：重审旧 product-feature run 时，问题章序号从旧 §10 变新 §11，旧 §10 的问题内容逃过 `auditTargetProblemAttribution` 检查——方向是**漏检非误报**（fail-open，不产生假 error），且旧完结 run 极少重审。做 per-version 序号映射属过度工程，不做。

## 批次 57B-363（eval forbidden searched-not-found 豁免）评审产生（fable，2026-08-10）

修复判定"可合"（谓词保守性、base/unless/pass 零改动、五种真幻觉全不豁免、真实 leave-mini run forbidden 2→0 均已核实）。两条 advisory 残差：

- **正向断言只引零命中检索回执会被全局豁免（should-fix，归 audit 层）**：`isSearchedNotFound` 谓词让"引用 ≥1 证据且全部是零命中未截断 search 回执"的 claim 对**所有** forbidden 规则免疫。连贯写作下这类 claim 按构造是诚实否定；但**不连贯**的作者若写正向断言（"系统发送邮件"）却只引一条零命中回执，会被漏过。这属"引证不支撑声明"，正解在 audit 层的被引 SEARCH 回执支撑性校验（57B-362 S0a 合规线在做，尚未进 main 主线）。在主线补上前是真实但极小的盲区（自相矛盾的产物才触发）。`eval/README.md` 措辞 "by construction cannot be a positive assertion" 描述的是连贯写作构造，已在此标注其边界。
- **`truncated` 缺失按未截断处理（nit）**：`eval/knowledge.ts` 的 `truncated: Boolean(item?.data?.truncated)` 把缺失字段当作未截断（可豁免）；严格保守应视缺失为"可能截断"而不豁免。产出方 `src/source.ts` 类型上保证必写该字段，仅畸形/手写 evidence.json 受影响；eval 属 advisory 诊断层，风险可忽略。后续如需可改为要求显式 `truncated === false`。

## 批次 57B-359 增量3 规划暴露 · 调查深度杠杆（2026-08-11，需用户裁决投入方向）

2026-08-11 WCP demo（请假 product）漏了 16h/40h 分层审批阈值、流程图退化。规划增量3（authoring packet）时 Fable 核实**根因是调查深度不足、非结构/运输问题**：真实阈值在 `wcp-service-v2/internal/handlers/leave/service.go:510/557/711` 的函数体字面量（`lv.Hours > 16` / `> 40`），**不在** `constant/leave.go` 常量（那里只有假期类型枚举）；新 run 的冻结知识**零窗口**覆盖 service.go 460-610——作者根本没挖到。authoring packet 渲染的是冻结知识，**知识里没有的变不出来 → 增量3 不治此类深度漏项**（packet 治的是"挖到了但没送到章节"的运输退化 + 墙钟/context）。

深度杠杆候选（独立于解耦增量序列，需用户裁决投入方向）：
- **(a) SKILL 调查指令强化**：如"枚举层级/阈值时，必须定位选择每一层的条件再处置 decision-flow/calculations 项"。增量3 方案里已含这一句 rider（可摘除），但作为独立杠杆值得系统化。效果模型依赖、非确定性保证。
- **(b) eval golden 把 WCP 16/40 钉成 mustFind**：让深度回归可测（否则深度失败无法机检）。低成本、高价值，建议优先。
- **(c) fact-pack thresholds 类目（扫 `> \d+`）——倾向否决**：同文件 `service.go:1558 style.Font.Size = 16`、`:1626 SetRowHeight(...,40)` 是呈现常量，纯确定性扫描无法区分业务阈值与噪声，信号被淹。

另记：**`reconcileFactPack` 扩展到 product 报告**（advisory）——本次 WCP 案例因 fact-pack 六类目全 truncated 而无效，优先级低，留证待议。

## 批次 57B-359 增量3（authoring packet）评审产生（fable 复核，2026-08-11）

判定"可合"（九项重点逐条核实：纯确定性字节级/不 bump 版本/knowledge-v1 零改动/advisory warning-only/框架无关映射/摘录纪律/接线；离线回放独立复跑运输保证成立）。三项非阻塞残差：
- **open 起源 feature workitem 无 reportSection 时静默落不进任何 packet block（残差）**：`src/authoring-packet.ts` 按 `reportSection` 分块，而 `mergeWorkItems`（assurance.ts）允许 open feature 项 reportSection=undefined → 其证据不被 packet 运输、不进 advisory 应覆盖集（渲染与 advisory 共派生故内部一致无误报），但 Completeness 头部计数含它、块里看不见。候选：open feature 项强制 reportSection，或渲染 "unassigned" 块。
- **advisory 消费集只认 claim.evidenceIds 不认 traceIds（残差，合方案 §1.3/R5）**：作者以 verified trace 引用满足 workitem 时，底层 S- id 仍可能被 advisory 警告。方案明文按证据 id 对账、已接受 warning 噪声；留后续降噪候选。
- **featureKeyOf 反推逻辑三处拷贝（残差，归 57B-361）**：`src/authoring-packet.ts` 的 `featureKeyOf` 与 `src/run.ts` 的 `feature-<key>-<audience>` 反推是第二/三份拷贝（正推在 run.ts）。57B-361 src/ 重组时收敛为单一导出。

## 批次 57B-365（leave-mini golden 深度化）评审产生（fable 复核，2026-08-11）

判定"可合"（pattern 只宽不窄逐条核实、深度项 AND 语义、固化 fixture 字节级一致无泄漏、判别器真实工作 base-2/3 红=没查调用方、334 pass）。残差：
- **leave-mini 深度天花板（核心边界）**：真判别器仅 `depth-restore-uncalled` 负空间一轴；结构深度项（终态/白名单/阈值/unpaid）当前 6/6 稳定命中、只作回归护栏无判别力；**WCP 式"大文件跳窗"失败在 leave-mini（最大文件 41 行、无窗可跳）结构上测不出**——需后续 leave-midi（多窗口大文件、阈值埋中段）切片。
- **单语义改写的同义词残差（nit）**：`authz-l1-guard` 新 pattern 丢了旧"直接经理"同义词；`authz-scope-employee-self` 对"仅可见本人"类不命中——数学上非严格超集，但方案原文如此、6-run 实测零假阴；遇红按只宽不窄纪律再加宽。
- **`depth-restore-uncalled` 裁量风险（有意为之）**：报告若把 restore 结论写进 reversal-flow workitem 而不出 claim → 红。深度门就该要求它成为报告命题。
- **6-run bench 在仓库外**（excavator-measure-359/）、验证为本机人工步骤不进 CI，如实记。

## 批次 57B-367（并行分节撰写）评审产生（fable 复核，2026-08-11）

判定"通过"（四安全根逐行静态核验：draft 写路径零交集、collect 链由构造成立、冻结门无旁路、audit 三门不破；344 pass）。残差：
- **collect 超时不写 `audit/<doc>-timeout.json` 诊断文件（待裁定，判可接受）**：checkpointSection 超时会写该诊断文件（run.ts:456），但方案只授权 export normalizeSection/archiveCheckpoint、未授权 diagnoseTimeout，故 collect 超时仅置 timed-out+warning、不写诊断文件。全库 grep：该文件**无任何程序消费方**（resume/audit/eval/SKILL 都不读），纯人读产物；timed-out+warning 已入账、resume 可续。coder 守授权边界上报而非扩权。候选：是否 export diagnoseTimeout 补 collect 侧诊断对等——低优先。
- **并行 run 的 per-event "TIMED OUT" 标记永不出现（R2 时间语义，已 PR 披露）**：collect 预算在全部 append 之后才判，超时不打在 timeline 事件上；stage 级总墙钟不受影响。
- **hasClaims sidecar 缺失 fail-closed 分支无对应测试（轻微覆盖缺口）**：parallel-authoring.ts:147，后续补。

## 批次 57B-370（边界召回度量地基）评审产生（fable 复核 high effort，2026-08-11）

判定"可合"（九项重点逐条实证：确定性/FG shape 判别防假贷记/路径语义同一/gold 三层/基线10-13可信/NUL修复等价；364 pass；独立复跑真实run确定性 + 独立重算fixture投影一致）。残差：
- **leave-mini boundary gold 后续切片**：本切片只建 wcp-leave boundary gold（真实 run）。若 57B-371 需 CI 内端到端真 prepare 验证，可给 leave-mini 建 boundary gold 作后续切片。
- **T3 informational 未逐条裁定实质性**：15 条 optional 是疑似额外边界缺口，照方案不进闸门，57B-371 用作诊断即可。
- **旧报告窗口计数 tokenize 口径差异（无害）**：coder 机械复现 56 窗口/32 srcOnly vs 方案 64/37，但 gold 取材三桶（11 node-overlap / 4 file-in-FG-node-cut / 12 neither）与方案一致，gold 不受影响。差异来自 markdown 证据抽取 tokenize 口径。
- **gold `_meta` 文档精度 nit**：T3 桶算术标注（"4 个 node-cut"实际 3 条）+ 一处 note 行号 :268 vs 实际 267——纯 provenance 文字，锚是 name 匹配不影响判定。后续顺手订正。
- **coveredBySourceWindow 方向性预期未兑现（无碍）**：方案预期 optional miss 相当部分 true，本 demo run 实际只 2 条 UI modal（S-窗口集与旧好报告 run 不同）；机制两分支已测试覆盖。

## 批次 57B-371（pruneFeatureGraph 两段式剪枝）评审产生（fable 复核 high effort，2026-08-12）

判定"可合"（十项重点逐条对代码验证：硬上限三重保证永不超cap、stage1逐字节零churn、缩写骨架运行时派生框架无关、桥信号出边方向性排hub、edgesAmong四项、门测试13/13且nodeCount=250有效；387 pass）。范围外残差（本切片未动 diff、另议）：
- **application 别名污染（比本切片更大的单一污染源）**：anchorTerms 的 `application` 把 promotion 路由 + application 模块（ApplicationForward/LeaderApplication/PeerApplication）拉进 leave 边界，占 ~3 救援席。是 Target Resolution 的下一个杠杆——别名生成质量（feature.aliases）本身该收窄。归 57B-320 后续切片。
- **stage1 tie-break localeCompare 的 locale 稳定性隐患**：stage1 评分逐字节搬移时保留了原 `localeCompare`（locale 相关、字节稳定性隐患）；本切片为保零churn未动，新救援代码已用普通字典序 compareStr。后续可把 stage1 也统一为字节序。
- **FG 主排名含 import/file kind 节点占席**：这些结构节点占 maxNodes 预算但对边界召回价值低；后续可在主排名过滤。
- **expand edge LIMIT 截断时 kind 字母序隐性优先级**：截断恰落在同(kind,source,target)多行时行序依赖 sqlite 内部序（同 db 双跑字节一致已覆盖）；异构 sqlite 构建下留意。
- **巨仓残差**：hop-1 圈 > 6×maxNodes 时仍会 expand 饥饿（优雅降级、不劣于现状）。
- 理论角落：cap<quota（≤8 极端配置）stage1 空席、seeds 可能被救援顶掉——默认 220/demo 250 不可达，纯理论。

## 批次 57B-375（救援 logic → logic-disposition work item）评审产生（fable 复核，2026-08-12）

判定"返工"（两处小 must-fix 已修，余通过）。本切片修复项与后续待办：

- **57B-372 漏 bump BUILDER_VERSION（既存缺陷，本切片 Fix 2 修复）**：57B-372 加 `logic` 类目时未 bump `BUILDER_VERSION`（`src/context.ts:15`），feature 缓存键 `${BUILDER_VERSION}-${key}.json` 命中即直接返回旧 fact pack。同 target 复跑（wcp-leave 常规流）命中缓存 → 服无 logic 项的旧 pack → v4 run 派生 0 个 logic work item → 三方期望一致、audit 零 finding → 强制函数被静默旁路（fail-open）。本切片 v16→v17 修复；记为 57B-372 的遗留。**教训：凡改 `buildFactPack`/context 产物形态必同步 bump BUILDER_VERSION。**
- **前向祖父泄漏（本切片 Fix 1 修复）**：生成式期望集扩张原按 `runUsesCurrentAssurance`（精确串等）门控，下一次 assurance 或 REDACTION_VERSION bump 会使所有 v4 期 run 的 `=== ASSURANCE_VERSION` 变假，而其 `workitems.json` 已烘焙 origin-default 的 logic 项 → 每个此类 run 假失败 `unexpected non-open work item`×N。已改为按运行自身 assurance **世代**（`assuranceGenerationAtLeast(manifest, 4)`，解耦 redaction 后缀）门控；严格身份校验仍用精确串等。

Fable 非阻塞后续（记录待议，本切片未动）：
- **`mergeWorkItems` 不保护 `material` 字段**：作者可在冻结前把某 logic 项降为 `material:false` 逃避 claim-coverage 要求（处置本身仍被强制且 timeline 记账，故非静默跳过，但覆盖门可绕）。后续可让 mergeWorkItems 对 origin-default 项固定 `material`。
- **`auditFrozenKnowledge` 不复核 `knowledge.factPackDigests` vs 磁盘 pack**：冻结后篡改 fact pack 文件会以"workitem 分歧"这种误导性形态浮现，而非直接的 pack 摘要不符。后续可加 factPackDigests 复核。
- **authoring-packet 尾块标题硬编码 "rescued decision functions"，但实际收集所有无 `reportSection` 的项**（含 open-origin 项）——轻微标签漂移；后续可按块内实际成分动态措辞。
- **`buildFactPack` 对 `name@path:line` 去重（已确认安全）**：logic 类目 `dedupeBy: "location"`（`category|filePath|line`），同 (path,line) 折叠为一条；work-item id `feature:<key>:logic:<name>@<path>:<line>` 的唯一性由 (path,line) 唯一性蕴含（去重键是其超集），故不会产生重复 id / freeze 重复项错误。记为已确认，无需改动。

## 批次 57B-376（请假规则覆盖金标准 POST-forcing 校准）产生（2026-08-13）

- **`extractKnowledge` 跨章节 claim-ref 冲突（记录，非缺陷；后续可修）**：`eval/knowledge.ts` 用 `${documentId}#${claimId}` 作 fact 的 `ref`，而多个 section 文件共享同一 `documentId`、各自从 `claim-1` 起编号，故不同 section 的相异 fact 会共享同一 `ref`（如多条 `…#claim-16`）。**不影响 found/miss 正确性**（diff 按 window+pattern+marker 逐 fact 匹配，不靠 ref 唯一性），仅使 `Diff.found[].via` 这个 provenance 串有歧义（按 ref 反查会取到首个同 ref fact，可能非真正命中的那条）。后续可让 ref 纳入 section/文件名消歧。

## excavator source 命令缺越界校验（D2 真跑发现，2026-08-13）
`excavator source` 对 start > 文件长度的越界窗口不报错，写入了非法区间证据（如 `197-92`，start>end），后续 `freeze` 才被该非法区间挡下。作者手工剪除并重算 evidenceDigest 才过。建议 `source` 命令加输入校验：start≤文件行数、start≤end，越界即拒并给清晰错误，而非留到 freeze 才失败。范围外，记此备后续修。

## 报告结构应随项目类型自适应（未来方向，用户 2026-08-13 提，暂不做）
当前 section 是**每种报告类型固定**（product-overview 10 / engineering-overview 13 / product-feature 13 / engineering-feature 12 / prd-feature 10），从模板 `##` 标题派生、烤进 manifest，**与项目无关**——不管 SaaS、游戏、CMS 都同样几章。用户指出：**不同项目类型侧重点完全不同**（SaaS 关注租户/计费/权限；游戏关注实体/循环/状态机/资源经济；CMS 关注内容模型/模板/发布），固定章会"重要维度没深挖、不相关维度占篇幅"。
**未来要做的**：报告结构按项目类型/领域自适应——候选方向：① 模板标注 optional 章 + prepare 时按内容纳入/省略（要改 makeDocumentPlan + audit 章数对账，触 assurance）；② 按探测到的项目类型选不同模板变体；③ 章骨架保留但"深度预算"按侧重点倾斜。**暂不做**（当前聚焦 DB 抽取 57B-382）。做时注意：改章数=改 manifest 烤定值=触 audit 章数硬检查，需版本闸 + 不破坏现有 run（参照 57B-379/380 的结构性 grandfather 手法）。

## DB 抽取器落地后：从 engineering-overview 模板移除 §13 数据库设计章（用户 2026-08-13）
方向改为 DB schema 由独立 `db-schema` 抽取器（57B-382）单独出 → engineering-overview 模板不该再留 §13「数据库设计」章（否则每份 overview 都重复/半吊子做 DB）。**这是 57B-379(C1) 的回退**：移除模板末章 §13 + assurance `READABILITY_TABLE_SECTIONS["overview:engineering"]` 去掉 index 13 + template-sections 测试 13→12 章 pin。engineering-overview 回到 12 章。**约束**：改章数=改 manifest 烤定值=触 audit 章数硬检查 → 版本闸 + 结构性 grandfather（已烤 13 章的旧 run 不破，参照 57B-379/380 手法）。**时机**：57B-382 DB 抽取器可用、验证过之后再做（否则中间态既无模板 DB 章、又无抽取器，DB 无处可去）。

## 批次 57B-392（阅读层问责 V1）实测暴露 · 读义务分母的召回上限（需裁决投入方向）

V1 的读义务分母来自 fact pack `logic` 类目 = 保留 pruned-FG 节点的 complement 全量枚举。实测 WCP 请假 feature run 暴露两个具体后果，均为**方案已声明的天花板的实例化**，非本片缺陷，但需裁决下一步投哪边：

- **未被剪枝保留的函数根本没有读义务（具体实例）**：`wcp-service-v2/internal/handlers/leave/service.go` 的 `Creation`（请假提交，第 73 行 `if len(repr.Attachment) == 0` 是"哪些假期类型必须附件"的规则所在）**不在本次 run 的 factpack/分母里** → 其"读没读"对 V1 零可见。而 eval 的 gold FG fixture（较早的 demo run）里 `Creation 56-133` 是**有**的 → **保留集随 run/剪枝版本漂移**。裁决候选：(a) 投边界召回（57B-391 Phase 1 检索层 / 57B-371 剪枝改进）；(b) 给分母加第二来源（tests-as-oracle：测试断言是独立分母，能抓边界外的漏）；(c) 两者都做但排序。
- **声明式规则不是分支，未来的"条件清单"不能只抓 `if`**：前端表单规则以 antd `Form.Item rules={[{ required: true }]}`（`wcp-ui/src/pages/leave/ApplyLeave.tsx:583/614/663…`）的**JSX 属性对象字面量**形式存在，落在 `ApplyLeave 68-873` 这一条义务内、但每条规则不单独记账；同理 `CategoryStyle` 枚举（同文件第 57 行，定义 continuous/category 两种填写模式）**落在义务 span(68-873) 之外**。若 V1.1 的"窗口内条件清单"只枚举比较/分支（`if $X > $N`），**将系统性漏掉整类表单/校验规则**。裁决候选：条件清单的 material 定义必须含声明式规则对象（props/schema/常量目录），不只分支。

## 条件清单的语言覆盖实测（2026-08-14，用户提问触发；三个真实 run 对照）

同一条件清单机制跑在三个真实 run 上，命中密度差异巨大：

| 项目 | 语言 | 源码窗口 | 条件命中 |
| -- | -- | -- | -- |
| WCP | Go/TS/JS | .go 338 / .tsx 91 / .js 76 / .ts 30 | **24**（.go 14、.tsx 6、.js 3、.ts 1） |
| provital | Perl/Zope | .pm 61 | **5**（.pm 4、.zpt 1） |
| cebreo | C#/Kotlin | .cs 23 / .kt 14 | **0** |

**机制不依赖 `if`**（匹配的是比较表达式，故 `if`/`while`/三元/guard/`when` 皆可），但依赖两件语言相关的事：

1. **算符集是 C 家族**（`== === != !== >= <= > <`）：覆盖 Go/Java/C#/JS/TS/Python/PHP/Rust/Swift/Kotlin 与 Perl 的**数值**比较；**漏** SQL `=`/`<>`、shell `-ne`/`-gt`（provital 的 `.sh` 里实测存在 `if [ $TABLE_EXISTS_STATUS -ne 0 ]`）、Erlang `=:=`/`/=`、Lisp 前缀 `(> x 40)`、Pascal/VB `=`。
2. **只匹配数字字面量** → **所有语言的字符串枚举比较全漏**：`status == "approved"`、`role != 'admin'`、Perl `$type eq 'sick'`。**这是最大的洞且与语言无关**，也是 Perl 仅 5 条的主因（Perl 业务规则大量用 `eq`/`ne` 与哈希查表）。
3. **降噪过滤器亦有 C/英文惯用法偏差**：`len(`/`.length`/`Math.`/`count` 抓不到 Perl 的 `scalar(@a) != 3`、`length($x)`，故 Perl 侧噪声结构不同、过滤失效。

**候选下一片（V1.3，需先校准）**：扩到 ① 字符串/引号字面量比较 ② 非 C 家族算符（SQL `=`/`<>`、shell 测试算符、Perl `eq/ne/gt/lt`）③ 按语言分组的降噪词表。**必须先校准**：字符串字面量会引入新噪声类（日志文案、SQL 片段、URL、CSS 类名），不校准直接上会重犯字面量保真的错误。

## 阅读残差从未进入作者可见面（2026-08-15 实测，S1.5 合并后立即发现）

评审在讨论「是否该跑 run 验证分区 advisory 改变了作者行为」时提了一个**更上游、更便宜的先决问题**：作者的上下文里到底出现没出现分区读数？若从未曝光，行为差异在因果上不可能发生，跑十次也测不出东西。

**实测答案（不用跑新 run）**：真实 run 的 `prompts/` 与 `context/authoring/` 里，`read residual`、`not opened`、`未打开`、`阅读义务` 等词**出现 0 次**；而 `Literal conditions`、`Value sets`（条件清单）**确实在 packet 里**。

更精确地说：`SKILL.md:175` 给了作者一个**指针**——「detail 在 `coverage/read-residual.json`」——但没给内容。对照条件清单是**渲染进 packet** 的，作者想躲也躲不开。

**上条的自我修正（当日稍后核实，本条以修正版为准）**：「从未曝光」说过头了。`src/cli.ts` 的 freeze 分支是 `print(result)`，而 `result.findings` 含 `run.ts` 推入的全部 `auditReadAccountability` finding——**残差会打到调查者的 console 上**，只是形态为聚合两行、逐文件明细仍只在 JSON 里。准确的说法是：**曝光发生在 freeze 的 stdout，写作阶段（读 packet 时）完全不在上下文里**。

**而那条到达面本身是失效的（这才是真问题，57B-401 由此改形）**：`SKILL.md:175` 写着「Clear the ones that matter **before** freezing」，但阅读义务与残差**只在 freeze 时计算**（`readObligations` 全仓仅两个调用点：freeze 与 audit 复核），`runStatus` 无阅读维度——**freeze 之前没有任何办法看到残差**。残差是 warning 级 → freeze 成功 → run 被冻结 → 拒绝再 freeze。于是**调查者第一次看到账单的那一刻，正是它变贵的那一刻**：此后开窗必须走补充通道，而闸门文案还在主动劝退。佐证：上一次真实 run 的 `sourceWindows: 69`、**`supplements: 0`**——补充通道实测使用为零。

**这正是 57B-394 立论的那句话没有应用到阅读侧**：「测量不干预不会让产品变好」。当时把条件清单从审计残差搬进 packet，才让它真正影响了写作（好的一面：16/40 阈值对照；坏的一面：为压 unaccounted 写出的垃圾句）。阅读残差至今停在「测量但不干预」的状态。

**后果**：S1.5 修好的分区读数目前只服务 **between-runs 的漏斗决策**（下一片投哪），不服务 **in-run 的作者阅读选择**。前者已由机检钉死，后者机制上还不存在。

**下一片（57B-401，已落地为双曝光面）**：主曝光是**冻结前的只读命令** `excavator reading`（零摩擦窗口，也让 SKILL:175 那条既有指令第一次可执行）；次曝光是 packet 末尾的 `Reading boundary` 块——它**只声明边界、不索要窗口**（packet 在冻结后才被读，索要窗口等于把行动成本钉在最高点）。教训带上了：给的是「**该开哪些文件**」，不是「每条都写一句话」；后者正是条件清单产生垃圾句的形状。

**另注（本次测量的污染）**：上一次真实撰写 run 的 agent 是被我明确要求「跑完 audit 后读取并汇报这些数字」才去读 coverage JSON 的——那不代表正常作者会读。此处的结论只依赖「packet/prompts 里 0 次出现」这个确定性事实，不依赖对作者行为的推测。

## 批次：曝光片落地后的首次真实 run（2026-08-15，预注册口径判定）

Run：`.work/wcp-bf72b0/runs/run-2026_08_15_21_40-请假管理-e7b7fd1a-5fbd4975-300ae843`（12 章 / 560 claims / audit 0 error / 14 advisory）。对照基线 `run-2026_08_15_17_36`。判据在跑之前就已钉死（57B-401 §五），下面按那份口径逐条读。

### 一、曝光已送达 ✅

5 条 `investigation.read-check` 事件（sequence 2/63/136/137/148），**全部早于 freeze**（158）；packet 里 `Reading boundary` 块存在（56 行）。

### 二、起作用 ✅（确定性痕迹，非自报）

| | 基线 | 本次 |
| -- | -- | -- |
| sourceWindows | 69 | **134** |
| 义务已覆盖 / 部分 / 未打开 | 114 / 36 / 225 | 176 / 28 / **171** |
| **strong 分区（冻结时）** | 99 | **48** |
| 报告行数 / claims | 921 / 472 | **867 / 560**（更短更密，非灌水） |

**因果签名**：第一条 read-check 发生在 sequence 2，**此前零窗口**；其后到 freeze 之间开了 137 个窗口，其中 **108 个落在该事件点名的文件上**；预注册的锐指标「清单头部 3 个文件至少 1 个获得窗口」实际是 **3/3**——而基线的 69 个窗口对这三个文件**全程零命中**。n=1 下这是巧合无法伪造的形态。

**实质回报**：报告首次陈述 **16 小时**阈值（基线里 `16 小时` 出现 **0 次**，`40 小时` 2 次；本次分别为 2 次与 5 次），并带窗口 `S-ac48e2c07e — leaveService.js:1211-1285`。这正是启动整条线的那个漏报（spike：`leave/service.go:510/557` 连续 5 个 run 一次没打开）。

### 三、有害：三个 Goodhart 信号中**一个已触发** ⚠️

- (i) 「开签名不开函数体」**未触发**——partial 反而从 36 降到 28。
- (ii) **`openedNotConsumed` 从 13 跳到 34**。按「已打开义务」归一：8.7%（13/150）→ **16.7%（34/204）**，约翻倍。notOpened 降了 54，而 openedNotConsumed 升了 21——**约 40% 的新打开义务变成了无人引用的顺手读**。audit 自己打出了那句为此设计的告警（"an opened-not-consumed count that rises while not-opened falls means the loss migrated rather than closed"）。
- (iii) 枚举式提及未见；但 packet 消费 advisory 报了 5 条冻结证据无 claim 引用。

**判定**：曝光**有效**且**同时产生了可测量的迁移**，两者都真。损失没有单纯地「关闭」，一部分从「从未打开」移到了「打开但从未被引用」。这是探测器**首次实战即按设计触发**，也是它存在的理由。

**尚不可判的部分（诚实边界）**：16.7% 的顺手读率里，有多少是「被清单诱导的刷窗」、有多少是「读得多必然引用率下降的正常定向阅读」，n=1 无法区分。这是下一片的输入，不是本次的结论。

### 四、本次 run 顺带暴露的引擎缺陷（撰写方反馈 + 我的独立复现）

**两条静默损失（最重，均已独立复现）**：

- **`source` 静默截断到 240 行**（`src/snapshot/source.ts:57`：`Math.min(requestedEnd, safeStart + 239)`）。调用方传 `--start 1 --end 247` 得到 1-240，**无任何告警**，只能从返回的 `endLine` 反推。工件本身诚实（残差按真实 endLine 算），但**调用方的心智模型会偏离**：`Approve` 是 378 行，作者若以为一次窗口覆盖了它，尾部就静默未读。修法：返回 `clamped: true` 或显式告警。
- **跨仓解析静默漏掉泛型调用**（`extractFrontendCalls`）。最小复现（我构造并实测）：三个调用中只有非泛型那个被找到，`httpClient.post<App.ResponseBase<LeaveInfo>>(...)` 与 `httpClient.get<Foo>(...)` **既不在结果里、也不在 `ambiguous`/`unresolved`、`warnings` 为空**——对引擎而言根本不存在。真实 target 上消失的恰是 **approve 与 reject** 这两个最关键的请假调用。**静默缺失比标成未解析危险得多**，这正是本条线要消灭的失败类。

**其余八条（撰写方反馈，未独立复现，按其原话记录）**：

- `source` 输出是带 `\n` 转义的 JSON 字符串，无法阅读——记录窗口与阅读代码本是同一动作，现被迫拆成两次（Read 工具 + CLI 盲记）。给个 `--quiet` 或纯文本渲染即可合一。
- `trace` / `workitem` / claims 的 JSON schema **全无文档**，`--help` 只有 `--file <json>`；作者是从上一个 run 的产物反推字段的，且错误一次只报一条。修法：`--print-schema` 或 skill 里放示例。
- **`searchScope` 是 `searched-not-found` 的硬性字段但任何文档里都没有**，字段名只存在于源码。相关提示也该说清「只能引用零命中回执」。
- **句中标记静默破坏 claim 匹配**：`……类型 \`事实\`，与 Go 侧不一致。` 会让 statement 在 section 里找不到（标记从 claim 剥了、从正文没剥），报错指不到病因。修法：两侧同样归一化，或 writing-rules 写死「标记必须落在句段末尾」。
- **rescued-logic 检查与 skill 自相矛盾**：skill 明说「prose 不必出现符号名，账由证据绑定」，而 `auditRescuedLogicCoverage` 只做全文文本匹配。照 skill 写会被全部警告。二者必须统一。
- **事实包对账看不见它自己给的逃生口**：提示说可「折叠进显式计数的分组」，作者照做仍报 "38 item(s) not represented"。照文档做还被警告的告警会被长期无视。且这些类目混了大量域外项（LDAP 键、JWT 公钥），逐条点名反而污染报告。
- **`condition residual` 无法诚实清零**：62/102 里含同行被多窗口重复记录的条件、以及确无可报告行为的 UI 条件，没有「已考虑并有意排除」的标记手段，数字永远归不了零，久了会被当噪声。（与已排期的条件清单卫生片同源。）
- **freeze 失败时输出顺序误导**：findings 在前、完整 run.json 在后，`| tail` 只看到 JSON 会误判成功（退出码正确，脚本化无碍）。
- 非缺陷观察：`--terms` 是字面子串匹配（`describe(` 命中 yup 的 `.describe()`），skill 值得加一句「选只在待证明对象中出现的词」。

## 批次 57B-404（条件清单 Goodhart 卫生）产生（2026-08-16）

**过期记录已更正（跑前核实，避免「修一个已经对的东西」）**：57B-404 原文第 2 项说「packet 渲染与 audit 的 `values.length > 1` 口径不一致，8 个族里 7 个单值」。**实测两侧口径已经一致**——`authoring-packet.ts:338` 与 `condition-inventory.ts:299` 都是 `values.length > 1`（该记录写于某次修复之前，未同步）。**本片不动它**。真实 run 上是 15 个族、13 个单值、2 个多值。

**范围切分（我的判断，非规划层裁定）**：57B-404 原有三项，第 1 项（协议值过滤）已完全校准可独立交付，第 3 项（诚实清零的排除通道）是**新的作者面机制**（新命令 + 新工件 + 审计接线），拆为 **57B-404b**。依据「每片独立可测可交付」。

**协议值过滤的自校准（送评前预检，goal 硬性）**：把真实 run 的 28 条 UI 字符串比较全部列出人工判，规则「字符串比较 + 文件扩展 ∈ {tsx,jsx,vue} + LHS **末段精确等于** type/action/status」杀 7 放 21。**精确匹配是保护域规则的关键**：`leaveType === "bto"` 末段是 `leaveType` 不是 `type`，`info.name === "holiday_type"` 比较的是 `name`——两者都活。另**亲眼读了源码**确认那 7 条确是协议：`action === 'next'` 决定批准后 `goNext()` 还是 `refresh()`；`info.type === 'change'` 决定筛选变化时是否重置到第 1 页。

**测试缺口（我自己的变异抓到，记为教训）**：packet 渲染条件有**两条路径**——section 块内（`renderConditions`）与末尾未归属块（`renderUnassignedConditions`）。我第一版测试只走了第二条，于是「删掉 section 块守卫」的变异**存活**。补测第一条后变红。**教训与 57B-402 同型：一个模块有几条输出路径，测试就得走几条，否则变异验证只是在验证我走过的那条。**

**评审构造的误杀反例，已按其给的机制修（非记档）**：仅凭「字段末段」无法区分回调协议与业务状态——`leave.status === "approved"`、`user.type === "admin"`、`notification.type === "leave_request"`、`item?.leave?.status === "pending"` 在 `.tsx` 里**全部会被误杀**（评审实测）。加第四条件「**RHS 字面量也必须是协议词**」后，四个反例全部改判 owed，而真实 run 的 7 条真杀零损失（其 RHS 只有 `change`/`next`，另一 run 还有 `error`）。

**为什么这个词表可以存在，而 relevance-annotation 的同义词表不可以**：本词表**只会让过滤器更严格**——每移除一个词就把 site 还回债务里，所以没人能靠转它把残差弄好看，它**对转动它的人不利**。而 anchor 词表转动会直接移动召回读数（被判定的那个数），方向相反。残余偏差是诚实的那一侧：没被列进词表的协议值仍然欠着。

**`.vue` 是死分支（评审实测，范围外，记档）**：`AST_LANGUAGE_BY_EXTENSION` 无 vue 语法 → 回退正则只见数字字面量 → **`.vue` 的字符串比较根本进不了条件清单**。所以过滤器的 vue 分支今天无害但不可测。更大的事实是：**Vue target 的字符串条件在上游就全盲**——这不是本片引入的，但对以 Vue 为主的目标是一整类不可见。

**评审指出的真缺口，已在本片关闭**：`auditConditionCoverage` 原本在 `unaccounted === 0` 时提前返回，于是**残差一旦归零，指向该工件的唯一指针随之消失**，排除计数就成了没人被告知去看的 JSON 数字——「标记而非删除」在那一刻退化成「删除但留了痕」。现改为排除计数**独立于残差**始终上报。（Goodhart run 的 unaccounted 已经是 1，这个状态迫在眉睫。）

## 批次：403/404/405 落地后的 run#2（2026-08-16，按跑前钉死的判据判读）

Run：`.work/wcp-bf72b0/runs/run-2026_08_16_02_01-请假管理-e7b7fd1a-5fbd4975-b6cd0139`（12 章 / 869 行 / **619 claims** / audit **0 error / 8 advisory**）。对照基线 `run-2026_08_15_21_40`。

### 一、分母（403）✅

来自两个 v1 express 文件的义务 **1 → 17**（其中 `recovered-route-handler` 16 条，`registrations` 16、`duplicate` 0）。719 可问责行进入分母。

### 二、v1 规则陈述：**析取护栏的第二支兑现**（这正是把它写成析取的理由）

报告本次**未**陈述 `hours > 8` / `holiday_type === 2`（基线 run#2 陈述了）。但**记账可见**：covered 9 / partial 3 / not-opened 5，**openedNotConsumed 0**。

按预注册判据：「消失但记账可见 = **403 成功**、转诊断材料」；只有「消失且记账不可见」才是硬失败。**若无 403，这次消失将完全不可见**——这正是本片的价值主张。

诊断层面还多一条信息：`openedNotConsumed 0` 说明 v1 窗口**被打开且被 claim 引用了**，作者只是选了另一个角度报告 v1（报告实际给出「v2 与遗留在恰好 40 小时处判定不一致」）。所以这不是「读了没用」，是「用了但换了个说法」——单跑措辞方差，不是损失。

### 三、迁移信号（openedNotConsumed）✅ **退回监控带以下**

| | 基线 | 本次 |
| -- | -- | -- |
| counted / notOpened / opened | 375 / 171 / 204 | 391 / 191 / 200 |
| openedNotConsumed | 34 | **17** |
| **uncitedRate** | **16.7%** | **8.5%** |

按 57B-401 预注册的三档（<10% 正常边际递减 / 10–25% 监控 / >25% 立案），**从监控带退到正常带**。上一轮触发的那个 Goodhart 信号这一轮没有复现。

### 四、strong 分区上升 48 → 66：**必须与窗口数一起读，不许只报好消息**

goal 明写「strong 可能上升而非下降，单看一个数报好消息一律无效」。事实是：

- 分母 375 → 391（+16，全是 403 新增）
- **本次只开了 75 个窗口，基线开了 134 个**——作者这一轮**读得少得多**
- strong +18 中，仅 5 条来自 v1 新义务；其余 13 条是既有义务从 opened 变回 not-opened

**所以 strong 上升的主因不是分母增长，是这一轮读得少。** 这是单跑行为方差（`supplements` 也从 0 变成 3，说明它换了策略：少开窗口、多用补充通道）。**不构成 403/404/405 的退化，也不构成改善——它是噪声，如实记录。**

### 五、条件卫生（404）✅

**协议值垃圾句 0**（基线 3）。sites 72、excluded 8（排除率 11.1%）、unaccounted 26、families 5。

### 六、claim 计数（405）✅ 端到端验证

**直数 619 = `metrics.claims` 619**。基线是 560 直数 / 92 metrics。修复在真实 run 上兑现。

### 七、曝光仍在起作用（57B-401 的因果签名复现）

4 次 read-check（seq 2/3/88/95，freeze@109），**首次在 sequence 2、此前零窗口**；其后开窗 89 个，**78 个落在该事件点名的文件上**；预注册锐指标「头部 3 文件至少 1 个获得窗口」实际 **3/3**。

### 八、XR 负空间结论：**重推导后仍然成立**（我曾预告可能被推翻）

修好的仪表（泛型调用不再消失、`unparsed-shape` 0 条、508 registrations）上重新推导：**指向 `/leaves*`（v1 express，非 v2）的工作区内链路 = 0**。而 `/v2/leaves*` 有 **13 条**。

所以上一轮那个结论**不是仪表撒谎撑起来的**——前端只调 v2，v1 路由确实无工作区内调用方。**结论保留，且现在建立在一台已知不静默漏泛型调用的仪表上。**

### 九、run#2 暴露的最重缺陷：**脱敏器损坏业务证据**（撰写方反馈 #1，我已独立复现）

`redactSecrets`（`src/core/util.ts:133`）用 `line.indexOf("=")` 找赋值，**不区分赋值与比较/复合赋值**。而这个领域用 `*Token` 后缀表示「已用小时数」，于是请假额度的算术在证据目录里不可读。我的独立复现（三条全中）：

```
holiday.PtoToken += hours                     → holiday.PtoToken += <redacted>
const [oldHoursTem, token, err] = calc(a, b)  → const [oldHoursTem, token, err] = <redacted>
if holiday.FuneralToken > 0 && err != nil {   → if holiday.FuneralToken > 0 && err != <redacted>
```

**第三条最糟**：`err != nil` 被改成 `err != <redacted>`——仅因同行提到 `FuneralToken`，而 `!=` 根本不是赋值。对照组正常：`holiday.PtoHours += hours` 未改，真机密 `const apiToken = "sk-live-abc123"` 正确遮盖。

撰写方另报一条我未复现但形态可信的：`leaveService.js` 里同一个调用的字面量 `'pto'` **在单行写法下被遮盖、在多行写法下幸存**——同值同文件，仅因空白不同而输出不同。

**后果**：`consumeByYear` 与 `withdrawHours` 各 10 个分支的额度算术全部不可引用，作者只能绕开写并在第 12 章披露。**这是证据损坏，不是过度保守**——审计会重新推导被脱敏的窗口，所以作者连「引用真实值」这条路都没有。

**修法方向（确定性，可精确修）**：① 只认真正的赋值——排除 `+=` `-=` `*=` `/=` `!=` `==` `===` `<=` `>=` `:=` `=>`；② 值侧否决扩到裸标识符/参数（`= hours` 不是机密）；③ import 路径已豁免（实测 `mcp_token` 未改），保持。

**为什么单独立片**：改脱敏会改 `REDACTION_VERSION`，而它进 `ASSURANCE_VERSION`、进所有审计产物字节——属独立切片 + 世代闸，不能顺手改。

### 十、run#2 的其余撰写方反馈（未独立复现，按原话记录）

- **`reading` 与 freeze 对「部分读」给相反建议**：`reading` 说「nothing counts how many entries you clear」，freeze 随后发 8 条 warning 点名它留下的**部分覆盖区间**。若 freeze 要点名 partial，`reading` 就该同时列出 per-function 的 partial（今天只列从未打开的）。**这条我认为成立且该修**——它正是「照文档做还被警告」的同型。
- **`cannot-determine` 静默要求 `settledBy`**：SKILL 说「records why, what would settle it, and evidence」但从不点名字段，作者从 freeze 报错才学到（与 `searchScope` 同型，已在 57B-406）。
- **`reportSection` 钉死在写作时不可见**：v2-vs-legacy 阈值对比本属第 4 章，但引用 `model-parity` 会硬错（该项钉在第 6 章），写作时无任何提示。
- **n/a logic-disposition 是硬门却写得像建议**，且只在**最终全量 audit** 才浮现（此前 12 次单文档 audit 全清白）。
- **冻结后无法重读自己冻结前的证据**：对冻结前记录的窗口跑 `excavator source`（纯缓存命中、零变更）仍被拒，作者只好手工解析 `evidence.json`。建议只读的 `excavator evidence show <id>`。
- **authoring packet 约 80% 是重复**：177 项 `logic` 全表在第 3/4/5 章各抄一遍，packet 4507 行。
- **事实包枚举闸推向填充**：403 个 entrypoints 里仅约 18 个是请假路由；`external-calls` 的 38 条里 13 条是前端调**本系统**的 `httpClient`，不是外部集成。为消警告写了两段对读者无价值的对账段落。
- **负向发现难记录**：`searched-not-found` 需零命中且未截断的回执，首次补充检索 50 条截断不可用。
- **真正兑现价值的（原话）**：「absence claims need a receipt」的压力**抓出了作者自己草稿里的一个真错**——他原写 `wcp_review_service` 不含请假代码，补充检索证明它直接 join `wcp_leave`/`wcp_leave_detail` 并带自己的状态过滤，「without the gate I'd have shipped a wrong boundary」。

## 批次 57B-409（脱敏器修复）产生（2026-08-16）

**根因**：`redactSecrets` 用 `line.indexOf("=")` 找赋值，把 `==`/`!=`/`>=`/`+=`/`=>`/`:=` 全当成赋值。改为 `simpleAssignmentIndex`（只认前后都不是运算符字符的裸 `=`）。

**为什么这不是安全面放松（关键性质，实证过）**：被排除出赋值路径的每一种形态，**仍然经过行末的 `redactSensitiveStringLiterals` 兜底**，它逐个判断行内的引号字面量。实测 `apiKey += "sk-live-…"`、`token := "sk-live-…"`、`if token == "sk-live-…"` 三种形态**字面量照样被遮**。消失的只是从来不是机密的东西：裸标识符、调用、比较操作数。测试文件后半段专门守这条契约。

**顺带修的两处（第一处是我的测试首跑抓到的）**：

- **调用表达式豁免**：`const tokenService = require("./tokenService")` 原本被遮成 `= <redacted>`，**毁掉一条 import**——与额度算术同类的损坏，但走的是普通赋值路径，算符修复够不着。加 `CALL_EXPRESSION_PATTERN` 否决（`fn(...)`/`a.b.fn(...)`/`await`/`new`）。调用**内部**的字面量仍由兜底判断，实测 `login("sk-live-…")` 照样遮。
- **Go `:=` 被 mapping 分支吃掉**：输出成 `apiToken :<redacted>`，值遮了但 `=` 丢了。mapping 分支现在排除 `:=`。

**三轮才收敛，两轮都错在同一个方向（拿证据换暴露），如实记录**：

- **v1（按算符排除）**：把 `+=`/`:=` 整个踢出赋值路径，理由是「兜底会接住」。**兜底只接引号字面量**，于是 `API_TOKEN := sk-live-abc123`（Makefile）与 `apiKey += sk-live-abc123` 漏遮。**我自己的探针抓到的。**
- **v2（裸引用豁免只看"无数字"）**：把裸标识符一律当代码引用。**评审构造证伪**——单词形弱口令拼写得和标识符一模一样：`PASSWORD=changeme`、`db.password=letmein`、`API_KEY=deadbeef`、`MYSQL_ROOT_PASSWORD: example` 全部漏遮。评审指出了我错误的确切位置：**既有 `isNameLikeLiteral` 的安全性来自「无数字 **且** 内容本身是敏感名」这个合取，我丢了第二个合取项。**
- **v2 还漏了一条独立通道**：比较整类排除后，shell 硬编码口令比较 `if [ $PASSWORD != s3cr3tpass99 ]` 漏遮。它**带数字**，所以与上一条不是同一个洞；兜底只看引号字面量，接不住。

**v3（现行）：按算符语义分，裸引用豁免只在算符已经表明"是量"的地方花掉。**

- 比较**回到**判定路径（保留运算符，只替换右操作数），因为排除它会漏 shell 口令比较；
- **一切赋值**留在赋值路径；
- **裸引用豁免仅限算术复合赋值**（`+=` `-=` `*=` `/=` `%=`）——配置文件几乎不用这些算符装载机密，而真实 target 实测形态正是 `+=`；
- 纯 `=` / `:=` / mapping 对裸标识符**维持记档的"已知代价"**（`holiday.PtoToken = hours` 会被遮），因为它与 `password = letmein` 是同一段文本。

判定右操作数前先裁掉条件的收尾语法（`{`、`]; then`），否则每个比较都像密钥材料。

另修一处同源缺陷：`==` 的**第二个** `=` 曾被当赋值，把 `if x == "…" {` 从自身运算符中间切开、连右花括号一起遮掉。

**第四轮：评审构造出 16 条漏遮 / 四族，并给出了这一系列错误的统一诊断**——

> **豁免按语法形状发放，而「机密 vs 引用」是内容/语境属性。**

四族与修法（每族评审都做过原型实测）：**A/B/C** shell 测试语境（`]` 收尾）里无引号操作数就是字面量词，撤销该语境下一切值形豁免、只放行 `$` 变量引用；**D** `=~` 整类跳过使 Perl/bash 的口令正则核对全漏——改为按语境判定「词形正则遮、真正则与 `s///` 留」；**E** `SECRET += changeme` 由 **ALL-CAPS 左值**（配置装载惯例）与业务算术（`holiday.PtoToken += consumption`）区分；**F** 首算符独占——比较放行后须对余串重扫，否则 `[ … ] && PASSWORD=news3cr3t99` 的真赋值永不被判。

**我自己的测试把漏遮钉成了期望行为**：`if ($password =~ /^abc/)` 被我断言「保持原样」，而那是口令前缀核对。**逐条 pin 只能钉住看过的角落**，所以本轮改为固化 **24 条漏遮语料 + 13 条可读语料**的常驻反泄漏测试——钉的是性质不是个案，第五轮不能在自己测试全绿的情况下重开第四轮的洞。

**豁免准入原则已写进 `shouldRedactValue` 的文档注释**：**按语境发放，绝不按形状**。存活下来的豁免都点名了语境（调用、shell 测试里的 `$` 操作数、代码大小写目标上的算术、置换）。

**记档不修的一条已知限制（钉成测试）**：**行级判定使格式影响结果**。脱敏逐行判断，字面量所在行是否提到敏感名由格式决定：同一调用单行写时 `'pto'` 被遮、多行写时幸存。真实 target 上这条还有 4 处具体实例——`leaveService.js` 的 `addTokenHoursByType('pto', …)`，方法名含 `Token` 使整行敏感，于是**请假类型参数被当值遮掉**。

考虑过两个修法，**都不安全，故不修**：① 按长度豁免短字面量——这是个**放宽方向的旋钮**，与「收窄可以有旋钮、放宽不行」的纪律相反；② 仅当敏感名是被调函数时豁免——`setApiKey("sk-live-abc123")` 会直接泄漏。**真正的修法是看表达式而非看行的脱敏器，属另一种设计。**

**运营代价（必然，写下来免得有人踩）**：升 `REDACTION_VERSION` → 进 `ASSURANCE_VERSION` → **所有既有 run 立刻掉出「当前世代」**，包括刚跑完的 run#2（戳 `assurance-v8-redaction-v4`）。归档 run 因此 28/29 逐字相同（唯一差异是 404 那条已有 advisory，与脱敏无关）——严格检查被 grandfather 跳过，这正是世代闸的设计意图。**要让 run#2 吃到严格检查必须重新 prepare。**

**真实 target 复验**：`brdg_impl.go` 整文件 `<redacted>` 出现次数 **0**（修复前 `consumeByYear`/`withdrawHours` 各 10 个分支全遮）；`holiday.PtoToken += consumption` 等六条额度累加全部可读。

**第六、七轮记账（第七轮由我自查产生，不在评审清单里）**：

- **"上限"在安全扫描里等于绕过口**。逐算符判定原带 64 步上限，70 个 `a=1 &&` 段之后的赋值直接走过去。上限的存在是因为逐段重新切片让扫描退化成 O(n²)——**改成按偏移扫描后全程线性，于是上限被删除而不是调大**。教训一般化：给安全判定加计数上限前，先问这个上限是不是可由输入构造抵达的；能抵达就是可绕过。
- **交替是字面量的集合**。`/^(changeme|letmein)$/` 曾漏遮而基线会遮。把单词形当字面量、把两词形当代码，这条界线由攻击者选。
- **逐段迭代会踩进"本该整体判定"的东西里**，代价一律是误遮而非漏遮，但打的正是本片要保护的证据：`s/password=\w+/password=***/`（一条**脱敏例程**本身）、`Where("token = ?", token)`（SQL）、`<input id="password" name=…>`（第二目标越过字符串取到上一个属性的值）。三条修法都点名语境：模式整体跳过、字符串内算符不绑定、第二目标不跨字符串。

**记档不修（本轮新增）**：JSX 里 `<Form.Item className={styles.passwordFormItem} label="Password:">` 仍被兜底整串遮——`passwordFormItem` 使整行敏感，于是**同行的 UI 文案被当值遮掉**。与上面「行级判定使格式影响结果」是同一个根：兜底看行不看表达式。方向安全（误遮），真实 target 上仅此 1 处，故不为它再动兜底。

**记档不修（词表边界，与基线同）**：`isSensitiveIdentifier` 按**分段**匹配（`_` 分隔或 camelCase 拆分），所以 `x-password`、`db.password`、`PASSWORD_2`、`myPassword` 都识别，但**无边界的连写** `mypassword=changeme` 与**未列词** `pass=changeme` 两版都漏。改法各有代价：改成子串匹配会让 `passwordless`/`passwordPolicy` 变敏感（方向安全但噪声未测），把 `pass` 入表会命中 `passed`/`passing`/`bypass`。**这是词表设计问题，不是判定路径问题**，与本片的算符/字面量修复正交，单独评估。

**记档不修（第 8–10 轮评审穷尽后剩下的三类，均已双向实测）**：

- **新增误遮：C# 可选参数签名**（cebreo 21 条全属此族）。`CancellationToken cancellationToken = default(...)`、`string provisionKey = null` 被遮掉行尾默认值——逐算符循环判到了基线只判首算符时够不着的那个 `=`，而 `CancellationToken` 按分段命中词表。方向安全，丢的是 API 签名的默认值部分，与已记的 `PtoToken` 同类代价。
- **继承相等（两版同放，非本片引入）**：① URL userinfo 形 `user:s3cret@host`——凭据由 `:` 绑定，而 `LITERAL_PAIR` 只认 `=`；② 模板串内的散文式机密 `` `the password is changeme` ``；③ 字面量内 `!` 开头且不含数字的值 `"password=!changeme"`——`!` 豁免是为 Vue 开关买的，这是它的已知代价面。
- **`isSensitiveIdentifier` 词表边界**（详见上条）：连写 `mypassword=` 与未列词 `pass=` 两版同漏。

**净安全面口径（评审判据，留给下次改脱敏的人）**：不看单条构造，看**相对基线的双向漂移**——真实仓逐行跑两版并分类为「新增遮盖 / 新增放行」。wcp（1714 文件、30 万行）实测新增遮盖 1、新增放行 113，放行抽样全为调用豁免。**差分工具无法区分"改进"与"泄漏"，只有记录下来的意图能**，所以放行侧必须逐类给出有意放宽的理由，否则视同泄漏。

## 批次 57B-405（对账诚实化）产生（2026-08-16）

**`collectClaims` 改键控暴露了一处测试盲区（我改完才发现，记为教训）**：把 Map 键从 `claim.id` 改成 `${documentId}#${section}#${claim.id}` 后，**812 个测试全绿**——而 `auditTraces` 拿的正是 `new Set(allClaims.keys())`，去和 trace 里的**裸 claim id**（`claim-3`）比对。若不特判，每条合法的 trace 引用都会被报成 "references missing claim id"。**全绿本身就是证据：这条路径没有任何测试覆盖。** 已在调用点转换为裸 id 集，并补测试把这个洞钉住（同时断言「传复合键会破」）。

**`auditTraces` 的诚实边界（记档，不修）**：裸 claim id 跨 section 不唯一，所以它只能验证「某个 section 定义了这个 id」，永远无法验证「是对的那个 section」。收紧需要 trace step 携带 section——那是合同变更，不在本片。

**归档 run 重审新增一条 advisory（预期，非退化）**：57B-404 返工加的「排除计数独立于残差始终上报」使 `run-2026_08_15_17_36` 重审多出一条 warning（7 条协议值被分类排除）。实测 **audit exit=0、差异只有 1 条新增 0 条丢失**。这是纯加法的可见性修复，正是评审要求的。

**评审在 405 抓到的唯一一条，正是本片自己教的那一课在修复里复现**：我给 `auditTraces` 加了裸 id 转换并写了测试，但测试直接调 `auditTraces` 构造集合——**钉住的是被调方合同，不是调用点行为**。评审的变异（把 `run.ts` 那行转换删掉）**820 全绿存活**。已在既有集成 fixture 里让 trace 真的引用一条 claim（5 行），M4 现在变红。

**「绿不等于覆盖」四连（402/403/404/405 每片一次，值得固化为纪律）**：① 402 绊线与结构判定共享前提 → 一族形态双网皆盲；② 403 发货代码零覆盖、测试手抄镜像 → 拔掉整条线仍全绿；③ 404 packet 两条渲染路径只测了一条；④ 405 调用点转换零覆盖。**每次改动都要问「删掉这个机制，哪条测试会红」，答不上就是缺口。**

**`@` 编码歧义（评审构造，记档不修）**：`name:"a"+path:"b@x.js"` 与 `name:"a@b"+path:"x.js"` 生成**字节相同**的 logic 项 id——但评审同时证明 `logicWorkItems` **上游就把这两个不同项生成为同一个 id**，plan/freeze/checklist 全链路已当作一个项。本检查不可能比它绑定的 id 系统更精确。属上游 id 格式的固有歧义，非本片引入。

**文本回退保留的理由（评审裁定，比我原来的更强）**：作者合同显示**连 n/a 处置也走 claim 的 `workItemIds`**，所以绑定路径总是可用且比塞标识符更省事——**Goodhart 压力方向已经反转**（塞标识符从「消误报的唯一手段」变成多余动作）。删除或世代门控反而会在绑定因上游 id 歧义等作者不可控原因 miss 时，重新惩罚合规作者。残余半通道（纯散文提名即可消警告）记档。

## 外部项目调研裁定 · Graphify（2026-08-16，规划层裁定）

用户提供 Graphify（github.com/Graphify-Labs/graphify，v8）+ 另一位开发者的分析，要求评估是否改方向。**裁定：不改序列。Graphify 是一面好镜子和一个便宜的对照臂，不是方向变更的理由。**

### 一、事实核查（分析里四条未证实/矛盾，两条我自己也错了）

官方材料**实有**：Leiden 社区检测、`--exclude-hubs 99`（p99 度数排除出 partitioning）、`--resolution` 可调、tree-sitter 本地抽取 37 语法、`--code-only` 完全离线无需 API key、Apache-2.0 + MIT 双许可、扁平节点 schema、`merge-graphs`/`check-update`/`update`/`query`/`path`/`explain`/`prs --conflicts`。

分析里**未证实或与官方矛盾**：① `affected`/`graph_diff` **不在命令表中**（分析把它列为四大可借之一）；② 25% 再拆分 / cohesion 再拆 / super-hub majority-vote **均未文档化**；③ tsconfig paths / baseUrl / package exports / pnpm workspace **官方完全没提**（分析列为「非常值得研究」第二项）；④ 「每文件 SHA256 cache」无据——**但我说的 mtime 同样无据**，官方只写「re-extract only changed files」，机制根本没写。**这条是我把未证实的说法当事实转述，记为测量纪律的反例。**

分析对我们的**硬错误**：称「Excavator 是 Node 22 + no runtime npm dependencies」——2026-08-13 起「零依赖绝对约束」已被**审计白名单**取代（现有四个运行时依赖）。它用这条过时前提论证「不要 embed、只做外部索引器」，**结论对但理由是死的**。

### 二、核心裁定

1. **不改序列**。三个实测桶（strong read-miss 48 / openedNotConsumed 34 / 未进账的 719 行分母洞）**没有一个是图拓扑问题**。用社区检测去「发现」`filesWithoutCandidates` 已经点名的文件是荒谬的。
2. **真正有价值的只有一条架构洞察**：「Community 是长期结构、Feature Scope 是临时查询」。但它**没有开新问题**——`docs/investigation-engine.md` §九-4 早已预注册重启条件（「模块树在 ≥2 个真实目标上作为分母来源的 gold 漏报率实测低于 feature scope」）。Graphify 只是给同一槽位添了第二个候选。
3. **一条我没想到的不对称性（规划层补充）**：**分母的确定性是硬门，召回只是比较项**——「你没碰模块 X」可执行，「你没碰 Community 7」不可执行。即使聚类赢了召回，若分区不能确定复现，也只配「用确定性手段复刻其拓扑思想」，不配接入工具。
4. **不采纳 Semantic Graph**（§九-1 重启条件未触及）。且分析**内在矛盾**：一边把「Graphify 的图太扁平、没有语义层」列为不要照搬的第一条，一边拿它的存在提议我们建本体。**一个自身没有语义层的工具，不能构成「实测需要语义层」的任何证据。** 新信息可以重开已裁定问题，但必须与该问题相关。
5. **只做 optional external index builder**，走**外部工具阶梯**（Benchmark Candidate → Experimental → Supported）而非 npm 白名单五条——它是 Python 工具，白名单管不到。真正会疼的一条：**Python 传递依赖树比 CodeGraph 重得多，而 Excavator 跑在他人机密代码上**。永不消费 LLM 社区标签（零模型调用），永不消费其内部增量/缓存路径作审计输入（故 mtime 之争与任何决定无关）。

### 三、三臂对照实验（预注册，离线零模型零 token，跑前钉死）

**问题**：作为 S3 模块级分母来源，拓扑社区是否在边界召回上优于确定性模块树与现役 pruned-FG。

**尺**：57B-370 的 boundary gold —— `eval/fixtures/wcp-leave/boundary-gold.json`（28 项 / 13 mustFind）+ `boundary-gold-frontend.json`（31 项 / 16 mustFind），**合计 59 项 / 29 mustFind**，测 FG 节点集边界。

> **测量纪律（我这次混过一次，记档防再犯）**：57B-320 的 **84 项**是 **claim 层召回 gold**，与上面这把尺**不是一回事**，不可混用。

**三臂**：A = 现役 pruned-FG（fixture 现成）；B = 确定性模块树近似（含种子文件的 module 下全部文件）；C = Graphify 社区（`--code-only --no-label`）。

**社区选取规则（跑前钉死，禁止事后挑）**：取包含三个种子文件（`wcp-service-v2/internal/handlers/leave/service.go`、`wcp-ui/src/pages/leave/ApplyLeave.tsx`、v1 `routes/leave.js`）中至少一个的社区之并集；另记「仅含 service.go 的单社区」作对照变体。仅此两种。

**指标**：mustFind 召回（主）+ **nodeCount/fileCount（同等重要——靠把边界吹大 3 倍换来的召回不是赢）** + T3「neither」桶 12 个已知难例的捕获（诊断）+ 双跑字节一致（硬门）。

**判据**：**C 更好** = C 的 mustFind 比 A、B 都多 ≥3 项（约 10pp）且 fileCount ≤ 1.5×B 且分区确定性过关 → 开 Benchmark Candidate 线 + 启动第二目标（provital）；**B 更好或打平** = B ≥ C 或 C 确定性失格 → S3 照原案，Graphify 关闭归档；**问题不重要** = 三臂互差 ≤1 项 → S3 分母来源按最便宜的确定性方案定案。

**前置终止条件**：先跑两遍 diff 产物，分区不确定且不可 seed → 实验直接终止，记「分母角色失格」。

**排期**：**队列之外的 bench 测量，不占切片位**。零 token、读 fixture，与 403/404/405 零冲突可并行。硬约束只有一条：**S3 方案落笔前必须有结果**（它决定 S3 分母来源）。

### 四、值得单独学的（分析没提到）

- **`--exclude-hubs`（p99 度数预排除）**：我们的剪枝有桥信号方向性排 hub（57B-371），但**没有池级度数预过滤**。可在 `eval/prune-replay.ts` 离线试，churn 门照旧。诚实边界：治不了 application 别名污染（那是词项问题不是度数问题）。
- **Aider RepoMap 的 PageRank + token-budget 排序**：与上一条同批离线试，共用 churn 门（我补充的候选）。
- 反面教材两条（分析说对了）：watch/hook 的常青更新与我们的不可变 run + freeze 正面冲突；其 `path.split("/")[0]` 式 cross-repo 印证 SnapshotRoot 层不应退化。

### 五、明确不做

不改序列；不建语义层/本体；不 embed Python；不在 bench 出数据 + 有真实消费者前建 GraphifyProvider；不消费 LLM 标签；不依赖未文档化的 affected/graph_diff（Impact 线自建）；不做常青/watch 形态。

## 批次 57B-402（仪表诚实）评审产生（2026-08-15）

**评审判定返工，两条 must-fix 都是构造出来实测的，且都击穿了我明确宣称过的性质**：

- **第四态在一整族形态上复活**：我的绊线与结构判定**共享同一个相邻性假设**（client 标识符必须紧跟 `.` 或 `[`），所以 `client?.post`、`client!.post`、`(client).post`、`(client as X).post`、`client.post.call(…)` 一族**双网皆盲、零告警**。教训：**绊线的文本独立性只独立于 AST，不独立于共享前提**——设计绊线时必须逐条列出主实现的前提，并确认绊线一个都不共享。修法：结构侧解包接收者（`!`/括号/`as`/`satisfies`，但**不解包**改变被调对象的 `.call`/逗号表达式），绊线放弃相邻性。
- **截断两情形在边界重合处互相冒充**：文件末尾恰好落在 `start+239` 时，纯算术判定无法区分，于是对**不存在的行**宣称「仍未读」，并让调用方白花一个窗口预算去发现。修法：短返回时读一次文件行数按证据判定（`SourceReader.lineCount`，不动 SourceWindow schema/缓存版本）。

**保留的取舍（记档，非缺陷）**：绊线放弃相邻性后更宽松。**决定不加「排除属性链」的收窄**——那会重新引入「包裹的接收者 + 结构读不出的访问方式」这一类双盲形态，而原则是「过度报警可接受、假缺席才是失败」。**块边界收窄（间隔不跨 `{`/`}`）已采纳，但代价非零**——我最初记成「白拿的」，第三轮评审构造并用旧 commit 复测证伪：`(client as { post(u: string): Promise<T> }).post(url)` 与其 `satisfies` 孪生形态、以及注释含 `{` 的形态，在收窄前**可见**、收窄后**双网静默**。前两者按本模块自己的接收者解包契约**本应 resolve**（结构侧的 as-peel 字符类同样不跨 `{}`）。收益一侧同样是实测：cebreo 11→2（那 9 条全是 Angular `constructor(private http: HttpClient) {` 跨到下方方法）。**裁定保留收窄**——Angular 构造函数族常见、内联对象类型断言在 client 接收者上罕见——但代价已写进前提 3 的例子里。**教训**：在一条以「可辩护记档」为全部卖点的产品线里，一条「代价：零」的失实记录本身就是本片要消灭的缺陷类；「评审构造的 12 个形态全部仍通过」是真的，但那 12 个不含这一族，**没测到不等于没代价**。最终噪声：真实 target（wcp-ui，744 文件，真实 client 名单）**0 条**；cebreo 2、openmrs 1，均来自探针塞的过宽 client 名。字符串字面量里的示例代码仍会被报（本仓 tests 目录），是刻意保留的过度报警方向。

**绊线自身的前提已列明（评审的元批评，已接受）**：第一版声称「makes silence impossible」而实际不成立——它共享了结构判定的相邻性前提。教训**同样施加于绊线自身**：前提必须逐条枚举，否则「独立」只是错觉。现已在 `unmatchedCallSites` 头部列出四条前提（client 标识符字面出现／verb 在 `MAX_TRIPWIRE_GAP` 内或走 destructure 形式／间隔不跨 `;{}`／非注释行），并把宣称改为「**在列明前提内不可能静默，前提外的盲区就是这四条，记档而非关闭**」。评审裁定 `client.withHeaders({h:"a;b"}).post(url)` 与 `client /* x; */ .post(url)` 两条对正则不可约，**记档不修**。

**范围外记录**：`source` 请求 `end < start`（如 100..50）会静默矫正为 100..100 且无任何提示。既有行为、非本片引入。

**评审确认无需动作的两条**：gold 地板 395/355 的检出力与重钉前边界相同（appRunnerApi=321、performanceReviewMainApi=70 消失必跳闸；mainApi=26 等小 client 在余量之下——57B-399 已记的已知边界）；`crossrepo-links.json` 只在 prepare 时写入，不追溯改写归档 run，且 `eval crossrepo` 不校验 reason 枚举，旧工件（411/365，reason 仅 `no-route`）过新 gold 10/10、无地板告警。

## 批次 57B-401（阅读残差曝光）产生（2026-08-15）

**`metrics.claims` 少算 5.8 倍（顺带查出的既有缺陷，范围外未修）**：真实 run 有 **472 条 claim**（12 个 section 文件），而 `metrics.claims` 记的是 **81**。根因在 `assurance-artifacts.ts` 的 `collectClaims`：它按 `claims.set(claim.id, claim)` 建 Map，而 **claim id 只在 section 内唯一**（`claim-1`…），跨 section 直接互相覆盖——实测 74 个 id 各出现 12 次。两个后果：① `metrics.claims` 是「最大单 section claim 数」而非总数，而 `eval compare` 正是拿这个数做跨 run 比较（`run-stats.ts` → `compare-runs.ts`），**用它判断切片好坏会被系统性误导**；② `auditTraces` 收到的是 `new Set(allClaims.keys())`（81 个 id），所以 trace 的 claimIds 校验**分不清是哪个 section 的同名 claim**——方向是变松而非误报。修法：Map 改按 `${documentId}#${sectionIndex}#${claim.id}` 键控，或让 claim id 全局唯一。**前置核查已完成（2026-08-16，影响面为零，可直接修）**：

- `eval/compare-runs.ts:164` —— **assessment 只对时间类指标断言，计数类恒为 `neutral`**（:44 有明文注释「improvement/regression is asserted ONLY for lower-is-better time metrics」）。所以工具**从未**用 claims 数下过「改善/退化」判定。
- 但 `:165` 的 `notable` 对计数类在 `|pct| ≥ 25%` 时仍会点亮——**存在被高亮误导的通道**，只是没被走到。
- 历史记录逐条查过：**没有任何一条结论出自 `eval compare`**。文档里的 472 / 560 全部是直接遍历 section 文件数出来的（`run-stats` 的口径从未进过结论）。

**口径修正**：上文「最大单 section claim 数」不够准确。实测 `metrics.claims` = **distinct claim id 数**（两个真实 run 分别 81 / 92），在 `claim-1..claim-N` 这种顺序命名下**恰好**等于最大 section 的 claim 数——两者相等是命名方案的巧合，不是定义。

结论：57B-405 可以直接修键控，**不需要回溯重审任何已下的切片结论**。

**从 `read-residual.json` 读 `kind` 会静默降级（测量纪律，已在代码里钉住）**：S1.5 为保住旧 run 字节恒等，让 `ReadCoverageItem.kind` **只在标注过的 run 上输出**。于是对未标注的 run，从残差读 `kind` 得到的 strong 分区是 anchor-only 的**降级读数**——实测同一个 run 上 84/24 vs 正确的 99/25。正确口径是**从冻结的 `read-obligations.json` 取 `kind`** 再按 id join（`read-residual-exposure.ts` 已按此实现并写明理由）。这与 57B-400 那次「临时脚本算出的数进了永久记录」是同型风险，故此处记档。

**`excavator audit` 会改写归档 run 的 `coverage/read-residual.json`（行为记录，非缺陷）**：`run.ts` 的 full-run audit 会重算并落盘残差。对基线测量的影响：**先量后审**，否则量到的是审计重算后的版本。本片的归档基线因此按 findings 比对（29/29 逐字相同），不按文件字节比对（时间戳与 audit 自增的 `timelineEvents` 必然变）。

**本片明确不做（规划层裁定，列为候选）**：

- **补充闸文案与「引擎自指漏读」的预授权通道**：曝光前移之后，走补充通道的应当只剩真正的写作期发现，劝退文案对那种情形是恰当摩擦。等真实 run 显示确有正当补窗被劝退再议。
- **任何对曝光消费的审计计数**（含「是否跑过 `reading`」）：审计它就是把曝光变义务，Goodhart 第二次上演。检测器已存在且正为此设计——`openedNotConsumed` 在曝光诱发刷窗时会涨。
- unclassified 的**函数级**渲染（两个面都不做）；overview 文档曝光（strong 分区按构造是 feature 域的，overview 无 featureKey 可作用域）；跨 feature 汇总视图。
- supplement 之后重新生成 packet（开窗命令本身回显内容，陈旧块可接受）；`runStatus` 加阅读维度（被 `reading` 取代，不做两个入口）。

**规模观察（真实数据，留给下一次 run 判定）**：strong 分区头部文件 `notification.go` 的 28 条义务里，函数名高度重复（`handleSES`×5、`subject`×6、`BuildCpst`×6）——那是按通知类型复制的模板文件。console 侧不截断函数行（规划层裁定：冻结前盘上无 `read-residual.json` 可指，remainder 无处可指），所以这 28 行会照实列出。**重复本身是否构成信息**（读者据此判断该文件是模板、决策价值低）还是噪声，等第一次真实 run 的行为数据再定，不预先加规则。

## 批次：S0–S2 落地后的首次真实撰写 run（2026-08-15，验收测量）

Run：`.work/wcp-bf72b0/runs/run-2026_08_15_17_36-请假管理-e7b7fd1a-5fbd4975-be85c5d5`（12 章 / 472 claims / audit 0 error）。这是 S1、S2 落地后第一次读到完整漏斗账，以下按重要性排序。

**账目**：义务 total 391 / counted 375（decision-function 177 · boundary-decision-function 212 · route-handler 2）；残差 covered 114 / partial 36 / **notOpened 225** / cannotDetermine 0；`openedNotConsumed` 冻结时 150 → 撰写后 13；条件 43 条中 consumed 42；audit 最终 0 error / 11 warning。

### 一、S1 在 express 路由文件上失效（与「正则对 Perl 无效」同型）

`boundary-functions.json` 的 `filesWithoutCandidates` 里有 **`wcp-service/routes/leave.js`（897 行）** 与 `report.js`——v1 遗留请假实现最核心的两个文件。CodeGraph 不把 `module.exports = passport => { router.post(..., wrapAsync(async (req,res)=>{...})) }` 暴露为函数节点，所以第二来源对它们**贡献 0 项**；加上第一来源也只有 **1 条**义务。v1 的创建校验、审批授权、`hours > 8`、`holiday_type === 2` 全部落在分母之外。同目录的 `services/*.js` 都有候选，所以这是 express 路由文件那个形状特有的盲区。

S1 声称枚举「边界文件内全部决策函数」，在这个文件形状上是**静默的零产出**。机制本身诚实（`filesWithoutCandidates` 如实记了），但没人看，直到这次真实 run 才暴露。

**修法（便宜且现成）**：S2 的 `recoverExpressRoutes` 已经解析出这些文件里每一条 `router.post('/x', handler)` 注册，内联闭包就是决策函数、span 可得。接成又一条义务来源即可闭合。

### 二、分母口径混淆了 read-miss 的归因（对仪表本身的质疑）

分母是「边界**文件**内全部决策函数」，不是「请假相关决策函数」。169 项 S1 新增的 not-opened 里，相当一部分是 `management/service.go`(47)、`management/utils.go`(27)、`management/export.go`(20) 这类**只是碰巧与请假代码同文件/同目录**的方法。

后果：`not-opened` 把「该读没读」与「在边界文件里但与本 feature 无关」混在一起，**S1 那 20% 的覆盖率不代表 80% 的漏读**。漏斗的 read-miss 桶因此不能直接当切片决策依据。要么给义务加相关性维度，要么在读数里把两者分列。**这条是对我们自己仪表的质疑，优先级高于继续加来源。**

### 三、条件清单诱导「为指标而写」的垃圾句（Goodhart 现场）

13 个字符串条件里有 3 个是 **UI 事件回调的协议值**：`info.type === "change"`（表单事件）、`action === "next"`（点下一条）、`file.status === "error"`（上传失败）。它们不是业务规则，但为了把 unaccounted 从 18 压到 1，作者**不得不**把这些字面量硬塞进句子（「按提交时的动作值是否为 `next` 决定跳到下一单」）——**这句话对读者价值接近零，是为指标写的**。

这正是基准文档预言的形式闸门 Goodhart 迁移，第一次在真实撰写中被观察到。**修法**：对 UI 事件回调的字符串比较加过滤（与已有的空串守卫、`typeof` 守卫同类）。

### 四、枚举族的单值族是噪声

8 个族里 **7 个是单值族**（`{next}`、`{change}`、`{error}`、`{Submit Cancel Request}`、`{0}`）。单值族不构成「取值集合」，价值等同于单条条件。audit 的 family advisory 已按 `values.length > 1` 过滤，但 **packet 里仍全列**——口径不一致，一行修。

真正有价值的那个族是 `toLower(item.name) ∈ {bto, pto, special leave}`——它让作者发现申请页对三种类型各做一次余额过滤而非统一逻辑，这条原本会漏。

### 五、引擎与文档的口径差（逐条）

- **`cannot-determine` 的 `settledBy` 字段未在 SKILL 中点名**：SKILL 只说「记录什么能解决它」，实现要求字段名 `settledBy`，freeze 因此报 error。
- **rescued logic 的匹配规则与 writing-rules 冲突**：全量 audit 的 `report does not represent N rescued logic fact(s)` 要求正文出现**标识符名或 `path:line`**，而 writing-rules 明说「散文不必包含标识符」。证据块写的是 `path:start-end`，匹配不上。
- **scoped audit 不刷新 coverage 工件**：`audit --run X --document Y` 只在 finding 文本里报真实值，磁盘上的 `condition-inventory.json` 仍是 freeze 时的数。
- **本地化 marker 词表未文档化**：只有 `事实/验证/推断/不可得` 会被剥离，写 `已验证`/`无法获取` 会把 marker 词留在 claim 里。
- **`--query` + `--regex` 疑似失效**：`search --query "func Test|describe\(" --regex` 返回 0，而 `--terms "func Test"` 返回 34。待查。
- **工作项跨章链接易踩**：散文可跨章讲，但 claim 链接的 work item 必须回到其 pinned 章节，否则报 error。

### 六、正面结论：跨仓链路的价值在它的反面

20 条 claim 引用了 `XR-` 证据（28 个 distinct id）。但最有价值的不是链路本身，而是**没有链路**：365 条解析结果里落到 `wcp-service` 的 25 条**没有一条指向 `/leaves` 前缀**，这让「v1 遗留请假端点仍挂载但工作区内无调用方」从猜测变成可引证的**验证**级结论——纯靠读代码给不出来。

`derived` 纪律被遵守：凡陈述 handler 行为处（`leave.Approve` 的 16/40 阈值、`Export` 的角色闸）都另开了 `S-*` 源码窗口，XR 只用于「谁调了谁」。

## 批次 57B-398（S2 跨仓链路）产生（2026-08-15）

**57B-399 计数地板的诚实边界（评审构造并实测，本片明确不防）**：

- **地板值未钉被测 target 的版本（待单独确认）**：calls/routes/linked 三个数绑死在对 `excavator-test-repos/wcp` 的一次测量上，而那个仓不由我们控制。不钉住被测版本，地板值就不可辩护、不可复现。**形态事实（评审实测）**：wcp workspace 根**不是 git 仓**，但五个模块各自是，HEAD 均可读（wcp-ui b86dfa27 / wcp-auth 76e958d / wcp-service 9df6897 / wcp-service-v2 7db2ee8d / wcp_review_service 272bbe7）——所以「钉 hash」的形态是**五枚而非一枚**。待确认：这五个仓有无远端、hash 是否稳定、五枚 hash 进 gold 是否值得（维护成本 vs 可辩护性）。

- **余量以下的侵蚀**：实测砍掉 7 个非 gold 文件共 18 条链路，地板仍绿。所以「整个 client 消失会被抓住」这个说法对**链路数 ≤25 条的小 client 不成立**。后端侧无此问题——gold 恰好覆盖全部 4 个后端，任一后端路由表消失会先被对应 gold 条目抓住。缓解只能靠缩小余量（会换来误红）或给每个前端 client 各钉一条 gold。
- **计数中性的精度塌方**：把 329 条非 gold 链路全部改指向同一条错误路由，计数不变、gold 完好、闸门 exit 0。地板按定义防不住这个（它数的是数量不是正确性）。现有缓解只有 `mustUnresolved`（1 条）与人工抽样 20 条。若要机检，需要另一类断言（例如「同一后端路由被 N 条以上前端调用指向」的异常检测），本片不做。

**评审记账（Fable 最终评审，判可合前的 should-fix）**：

- **handler 解析率没有做成 floor（本片明确的非目标，附理由）**：它是 freeze 时才算出的数、且**按 feature 计**（实测 leave 特征下为 13），不同 feature 请求会让它剧烈变化，做成固定 floor 会脆到没人敢信。scan 层的三个数（calls/routes/linked）与 feature 无关，才适合当 floor。若要给 handler 解析率设 floor，正确修法是**把 handler 解析移进 scan 阶段**（它本就是链路的属性而非 feature 的属性），让工件自带 `handlersResolved/handlersTotal`——那是一次跨 prepare/freeze 的重构，单独一片。
- **三处残余的访问/脱敏面（评审穷尽后列出，均低危不阻塞）**：① `crossrepo-scan.ts:90` 的 `readSource(join(moduleRoot, relative))`，`relative` 来自 codegraph db 而 db 可由 `--codegraph` 外部供给，路径无收口（同款前缀校验一行可修）；② `run.ts` 的 `readFile(join(target, aliasKey))`，`aliasKey` 来自 links 工件，而该工件在 prepare 与 freeze 之间尚未被 digest 钉住，篡改可导向任意读（仅进 alias 解析、不外泄内容）；③ `context/crossrepo-links.json` 与 CLI 输出工件仍带**原文** `expression`/`handlerExpression`——给 evidence 做脱敏的理由（持久产物 + URL 可携 token）对这两个文件同样成立。**口径应统一**：要么在 scan/artifact 边界统一脱敏，要么把「context/ 与 snapshot 同信任域」记为明示假设。

- **freeze 时硬猜 CodeGraph db 路径且静默**：`routeHandlerDenominator` 按 `join(target, moduleId, ".codegraph", "codegraph.db")` 拼路径，catch 后静默。db 若建在 workdir 缓存（`resolveCodeGraphDatabase` 支持这种形态）或 `dir !== id` 的 target 上，**第三义务来源会无警告地归零**——方向诚实（少算义务）但违背本模块自己的 never-silent 纪律。修法：把 prepare 已有的 `codegraphModules` 路径穿透到 freeze，或至少 openIndex 失败时 push warning。
- **闸门无计数地板**：`eval/crossrepo.ts` 只验 gold 10 条与 mustUnresolved。若 `discoverClients` 回归丢掉整个 client、或 `handler-resolve` 回归到 0，`summary.calls`/`routes`/handler 解析率塌方而 gold 幸存时闸门**仍绿**。修法：gold 文件里加 target 专属 floor（如 calls ≥ 380、routes ≥ 480、handler 解析率 ≥ 85%）。
- **`linkId` 可碰撞**：只含 from 侧 `module:path:line:method`。同一行两个同方法不同 URL 的调用（如签入的 bundle）会撞 id → 重复 evidence id → audit error。修法：id 掺入 expression 摘要。
- **`parseHandlerTarget` 的 inline 判定过宽**：对整个 handler 实参串判 `{`/`;`，导致「具名 handler 跟在带 options 对象的中间件之后」（`passport.authenticate('jwt', { session: false }), ctrl.create`）被误判 inline 而漏配。方向诚实（漏不是错）。修法：按顶层逗号拆参，只看最后一个实参。
- **`searchNodes` 的 LIKE 子串搜索 + cap 60**：短名可被 route/component 占满 60 条把真函数截断；叠加两个同名目录 + 同名函数可构造「唯一但错」。实测不唯一 0，风险低。修法：换 exact-name 查询或提高 cap。
- **`eval/knowledge.ts:123` 按 `S-` 前缀收窗口而非按 kind**（既有代码，与其自身注释不符）：`XR-` 证据天然被排除，行为正确但理由是巧合。


- **测试套件存在间歇性失败（本轮观察到两次，未定位）**：`npm test` 偶发 1 条失败，紧接着重跑两次均 698/698 全绿，且失败输出未捕获到具体用例名。两次发生在不同批次改动之后，故不像是某次改动引入。**这类抖动比稳定失败更危险**——它会训练人忽略红灯。修法：在 CI 里保留失败时的完整 TAP 输出、或给 `node:test` 加 `--test-reporter=spec` 落盘，先把是哪条测试抓出来再谈修。**先量再定**，不要盲改。
- **Go 内联 handler 无具名函数可指（诚实边界，非缺陷）**：express 的 25 个注册点用内联闭包做 handler，`parseHandlerTarget` 如实返回 null。此前的启发式会从闭包体里抓出 `res.json` 当 handler——**错配比漏配糟**，已改为遇到 `=>`/`function`/`{` 即判定内联。这 25 个注册点因此不进阅读义务，计数可见。

## 批次 57B-396（S1 义务分母第二来源）产生（2026-08-15，Fable 评审）

- **`boundary-functions.json` 无 digest（下一片一行活）**：fact pack 有 `factPackDigests`，这个工件没有任何 digest 记录。**闸门本身无洞**——`knowledge.readObligationsDigest` 覆盖的是合并**之后**的分母，audit 对账冻结的 `read-obligations.json`（`src/core/run.ts:709-711`），所以篡改边界工件不会让分母悄悄变。但两个后果真实存在：冻结后篡改该工件**无法事后取证**；`eval read-denominator` 会从被篡改的工件重算出与冻结分母不同的数**而不报警**。修法：`buildKnowledge` 加 `boundaryFunctionsDigest`，audit 端镜像核验（缺文件/改文件两个方向都 error），与 `readObligationsDigest` 同款。
- **JSX `cond && <X/>` 盲区已量化（评审实测，规模小但真实）**：决策探针认 if/三元/switch/循环节点，只用 `&&` 短路渲染的组件会被判 `no-decision`。真实 run 上 4 个 `no-decision` 的 `.tsx/.jsx` 候选里**恰好 1 个是真规则载体**——`wcp-ui/src/pages/PersonalOutlet.tsx:26-81`（`accessible && <Route/>` 权限路由门控，3 处）；ApplyLeave/LeaveDetail 这类规则密集组件因兼有 if/三元而正确判 `decision`。故「前端组件已覆盖」的说法需收窄为「**if/三元/switch 承载的组件已覆盖，`&&`-only 组件在候选中可数**」。修法：把 JSX 逻辑与表达式纳入决策 kind 集合，但需先量误报（`a && b` 在普通表达式里极常见，不是所有 `&&` 都是渲染分支）。
- **`gapsClosed` 是「被穿透」而非「已闭合」**：读数已改为同时报实际覆盖行数与百分比（实测前四大空洞覆盖 89%–98%），口径不再依赖命名。

## 批次 57B-395（V1.3 条件提取换 AST）产生（2026-08-15）

上一条"候选下一片（V1.3）"的三项已落地：① 字符串字面量比较（AST 路径产出，正则永不产字符串）② Perl 走 tree-sitter（`eq/ne/lt/gt/le/ge` 与哈希元素左值）③ 降噪过滤器补字符串侧（空串守卫、`typeof`）。实测：WCP 24→78 site（22 数值 + 56 字符串）、30 个枚举族、`regexOnlySites` 0；provital 5(全 regex)→11 site + 5 族，37/37 个 `.pm` 窗口走 AST。剩余记账：

- **枚举成员比较未捕获（已知边界，未排期）**：`categoryStyle === CategoryStyle.Continuous` 这类右值是**标识符而非字面量**的比较，按"只认字面量"的定义被拒。它在 TS/Go/C# 的枚举密集代码里是主流写法，可能是当前字符串枚举族的主要遗漏源。修法需要符号解析（把枚举成员解析回其字面值），跨出了当前纯语法层的边界；也可退而求其次记为"值集未知的枚举族"。**先量再定**：应先在真实 run 上数一数这类 site 的数量级，再决定是否值得引入解析。
- **`switch` / `case` 字面量分派完全不可见（评审实测，可能比枚举成员那条更严重）**：8 个算符模式对 Go 的 `case "open":` 全部无命中——`case` 不是比较表达式。**Go 是 WCP 主后端，而 switch 正是 Go 惯用的枚举分派写法**，所以这个洞对"枚举族"的杀伤面可能大于上一条。修法与上一条不同：不需要符号解析，只需要按 `switch` 语句聚合其 `case` 字面量成一个族（`expression_switch_statement` + `expression_case` 已在 AST 里）。**先量**：数一数真实 run 里 switch 分派的规模，再决定是否本片外单开。
- **非 C 家族算符仍漏（收窄但未消除）**：Perl 已补；SQL `=`/`<>`、shell `-ne`/`-gt`（provital `.sh` 实测存在）、Erlang `=:=`、Lisp 前缀式仍不覆盖。策略同上：按目标语言的真实占比决定是否加后端，不预先铺开。
- **`AST_LANGUAGES` 是能力清单而非当次事实**：Perl 只有在 `warmExtractors()` 跑过之后才是结构化路径，未预热则诚实降级为 `via: "regex"`。调用方（`run.ts` 的 freeze 与 audit 两处）已各自预热；将来新增调用点若忘记预热，会静默退回正则——这正是 V1.3 早期 ESM `require` 事故的同型风险，靠每 site 的 `via` 字段可见。

## 批次 57B-393（条件清单）评审产生（Fable 复核，2026-08-14；判定通过，无 must-fix）

四条 should-fix 全部在本片修复（`mentionsLiteral` 小数/分数假绿、STRUCTURAL_LHS camelCase 锚定放行 `discount`/`priceIndex`、magnitude 阈值 1e5→1e8 保住金额上限、去重 consumedBy 取并集），nit 中的测试 fixture 空断言与模块头偏差说明亦已修。剩余记账：

- **字面量保真的"跨窗口错配"收窄变体（未评估候选，Fable 提出）**：原字面量保真被校准否决（误报 5.6%~56%，含行号引用/自算计数/常量名vs值/redaction 冲突等结构性合法缺失）。但有一个子类未被测过：**字面量不在任何被引窗口、却逐字节出现在另一个已打开窗口**——即"结论对但 grounding 错"。它在结构上躲开大部分合法缺失类（那些值在任何窗口都不存在，故不触发）。已知坑：文件名可能出现在 `window.path`/`title` 元数据而非 content，需把 path/title 纳入搜索面。**待评估，未排期。**
- **提取率指标的语义边界（汇报纪律，非代码）**：`condition-inventory` 的 unaccounted 同时含"从未提取"与"陈述了但回引了别的窗口"，故其比率是 **P(提取∧正确回引|打开) 的下界**，不是干净的提取率。用"任何 claim 是否提到该字面量"来拆分**已实测不可行**（3896 条 claim 里小序数必然巧合命中）。若要干净拆分，需限定到同 feature/同文件的 claim，或给单位数字面量单列 weak-mention——待议。
- **分母欠计（已写入模块头，不另行修）**：`switch`/`case 3:` 形式的规则、配置文件里的阈值、以及**声明式规则对象**（前端 `Form.Item rules={[{required:true}]}`、schema 字面量、常量目录）都不是比较表达式，不进条件清单。声明式规则那条与上文"前端表单规则"条目是同一件事，是下一片的输入。

## 批次 57B-392 评审产生（Fable 复核，2026-08-14；判定通过，无 must-fix）

四条 should-fix 中三条已在本片修复（scoped audit 不再改写 residual、freeze 阶段抑制必然为真的消费侧 advisory、audit 校验冻结分母 digest）、两条 nit 已修（contained 义务仍受硬门约束、partial 措辞）。剩余记账：

- **`mergeWorkItems` 不保护 `material` 字段（既有面，非本片引入）**：`src/assurance/assurance.ts` 的 `...update` 未钉 `material`，作者把 origin-default 的 logic 项改 `material:false` 即可绕过读问责硬门（处置本身仍被强制、timeline 记账，故非静默跳过）。候选：硬门对 `origin: "default"` 的 logic 项无视 material 标志，或 `auditWorkItems` 比对 default 项的 material 漂移。与 57B-375 已记的同类残差合并处理。
- **`factPackDigests` 同样不复核磁盘 fact pack**（57B-375 已记）：本片给 `readObligationsDigest` 补了 audit 侧比对，fact pack 侧仍缺；两者口径统一时一并做。

## 删章必扫交叉引用（教训，2026-08-13）
从报告删除某章（如 provital 删 §13 DB）后，正文里对该章的**交叉引用会悬挂**（provital §7 残留 "see section 13 for the pointer"，指向已删章）。删章不是只切那一段——**必须 grep 全文 `section N`/`§N`/`chapter N`/章名 交叉引用并一并修**。将来做 57B-382 收尾（从 engineering-overview 模板移除 §13）时，模板/写作规则里若有对 DB 章的交叉引用也要同步清；自动化删章逻辑应内建"扫并修交叉引用"。
