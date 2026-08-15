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

## 批次 57B-401（阅读残差曝光）产生（2026-08-15）

**`metrics.claims` 少算 5.8 倍（顺带查出的既有缺陷，范围外未修）**：真实 run 有 **472 条 claim**（12 个 section 文件），而 `metrics.claims` 记的是 **81**。根因在 `assurance-artifacts.ts` 的 `collectClaims`：它按 `claims.set(claim.id, claim)` 建 Map，而 **claim id 只在 section 内唯一**（`claim-1`…），跨 section 直接互相覆盖——实测 74 个 id 各出现 12 次。两个后果：① `metrics.claims` 是「最大单 section claim 数」而非总数，而 `eval compare` 正是拿这个数做跨 run 比较（`run-stats.ts` → `compare-runs.ts`），**用它判断切片好坏会被系统性误导**；② `auditTraces` 收到的是 `new Set(allClaims.keys())`（81 个 id），所以 trace 的 claimIds 校验**分不清是哪个 section 的同名 claim**——方向是变松而非误报。修法：Map 改按 `${documentId}#${sectionIndex}#${claim.id}` 键控，或让 claim id 全局唯一。**先确认 `eval compare` 的历史结论有没有被这个数误导过**，再改。

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
