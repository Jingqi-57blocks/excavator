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
