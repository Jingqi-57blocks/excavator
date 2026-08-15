# Investigation Engine 基准文档（架构方向裁定）

> **日期**：2026-08-15　**性质**：57B-391 这条线的基准文档，后续切片从本文取方向。
> **裁定输入**：材料 A（自有实测，硬数据）、材料 B（外部调研，`docs/code-wiki-reference.md`）、材料 C（外部开发者的 Semantic Knowledge Layer 方案）、材料 D（Opus 评审意见）、材料 E（RepoDoc 论文 arXiv:2604.26523，**论文自报数字、未独立验证**）。
> **与 57B-391 的关系**：收编、不替换。本文细化其 Phase 0 后续与 Phase 1 首片，并给 Phase 2 增设前置条件（见 §八）。

---

## 一、诊断裁定：一等瓶颈是「没读到」，「没沉淀」是第二条线且单位不同

**裁定：当前一等失败模式是阅读层缺失（read-miss + prepare-miss），不是知识沉淀缺失。材料 C 的核心诊断句（"瓶颈不是模型没有看到足够多代码"）与硬数据直接冲突，不予采纳；但其指出的结构性盲区（跨仓边不可见、知识不跨 run 复用）真实存在，属另一条价值线（成本与复用），不是当前的正确性失败源。**

依据（全部实测）：

1. WCP「请假 16h/40h 阈值」漏报：`wcp-service-v2/internal/handlers/leave/service.go:510/557` 的窗口 505-612 在连续 5 次运行中一次都没被打开，而 work item `calculations-and-thresholds` 一直是 `found`；40 条阅读义务 16 条静默未读。模型**根本没看到**这段代码——"沉淀"无从谈起。
2. 增量 3（authoring packet）复盘结论：该漏报根因是调查深度不足、非运输/结构问题（`docs/pending-decisions.md` 57B-359 增量 3 批次）；packet 只能运输已冻结的知识，"知识里没有的变不出来"（`src/assurance/authoring-packet.ts:26-29` 明文）。即"沉淀/运输层"已做过一次投入，实测不治此病。
3. 分母自身也漏（prepare-miss 实例，已在真实 run 上精确定位）：`service.go` 的 `Creation`（起于第 56 行，附件必填规则在第 73 行）与 `Demand`（第 136 行）都不在义务分母里——真实 run（wcp-bf72b0 / run-2026_08_14_17_29，实测）在 `wcp-service-v2/internal/handlers/leave/service.go` 上有 16 条义务（11 counted + 5 declaration-only），但义务区间存在 54–275 空洞，两个函数正落在其中：**文件在边界内、函数没被 prune 保留**。同名混淆警示：该 run 里名为 `Creation` 的义务是 `router.go:30-37` 的路由注册，不是这个附件规则函数，复核分母时勿据此误判"已覆盖"。`src/assurance/read-obligations.ts:12-15` 明文承认这一天花板。
4. 跨仓/跨模块边按设计不存在：`src/codegraph/codegraph-set.ts:9-13`（edge 只连同 module 内文件）、`src/context/cross-feature.ts:47-50`（仅 sharedFiles/Entities/ConfigKeys，graph edge deferred）。这既是 C 说的"没沉淀"，更准确的说法是**引擎在这一段结构上是盲的——同样属于"没看到"**。

**两者的优先级判定方法（可执行，非感觉）——漏斗常备规则**：

- 每一个 gold/rubric 漏报与用户报告的漏报，都过一遍 57B-392 已落地的归因漏斗，记入四桶之一：prepare-miss（分母/边界没含它）/ read-miss（在分母、窗口没开）/ consume-miss（开了窗、没进 claim）/ write-miss（进了知识、没进报告）。
- 判定以**同设置 ≥3 跑的均值**为准（单跑召回噪声主导：44/58/38，实测），下一个切片投最大的桶；切片落地后复测，该桶必须收缩。
- 目前已归因的实例：16h/40h → read-miss；`Creation` → prepare-miss；wcp-ui 整仓静默 → prepare-miss（模块级）。**consume 段已有测量器**（condition-inventory：WCP 上 unaccounted 比率是 P(提取∧正确回引|打开) 的下界，`src/assurance/condition-inventory.ts:24-30`），write 段由 packet 消费 advisory 看护。四段全部有仪表，缺的只是持续把漏报喂进去。

## 二、语义层裁定：不建统一本体层；「边」以确定性 Finding 的形态长出来

**裁定：不做 semantic-graph-v1 的完整本体（12 类节点 + 13 类边的预先建模）。语义层按"先量后建"从真实解析里长：每一条跨仓/跨模块关系落地为一条确定性 Finding（携带两端 evidence），"图"是这些 Finding 之上的可再生派生视图，永远不是新的事实源。**

理由：

- 预建全量本体两次违反已付过学费的纪律：字面量保真与声明式规则残差都是"先建后量"被真实数据否决的先例（材料 A-4，实测）；`docs/direction.md` §十七 明文"稳定合同由真实消费者赚得""不提前建全量协议"（原则 14）。C 的 13 类边里，今天有确定性产出能力的只有少数几类（HTTP 路由、DB model↔table、import/package）；`PUBLISHES/CONSUMES/IMPLEMENTS/...` 应在各自 resolver 落地时各自赚得自己的 payload 形状。
- C 自己说"不要拿 Semantic Graph 替代 Evidence"——采纳，并且把它落成机制而不是口号：**Finding 信封已经是这个机制**。`direction.md` §八 的 deterministic Finding（Evidence IDs + Payload + creationMethod）正是"带证据的边"的合同；不需要新的顶层工件，需要的是新的 payload 种类（§四给出形状）。这同时回答审计边界问题：边的可信度由两端 evidence 的 snapshot 绑定 + digest 保证，audit 用现有 evidence 机制校验，零新增审计面。
- 现行 Claim 合同只指向 Evidence/Trace（`docs/architecture.md`「Evidence, claims and traces」），**不存在 claim→claim 引用**：报告句绑定"知识节点/模块摘要"在今天的合同里根本不可表达。这坐实了材料 D-3 担忧的实底，但也修正它的量级：让摘要可审计不是"assurance 模型重写"，而是**新增一段现有机制未覆盖的链节**（claim 引用中间文档 + 两跳忠实性），代价真实但形态是加法。是否加这段链节的裁定见 §三。

**广度/架构感失败模式的替代覆盖**（不建叙述 KB 时靠什么）：

1. **E1 rubric 覆盖率评测**（抄材料 B 的已验证评测法）：拿目标项目自己的官方文档解析成叶级 rubric，量我们报告的架构级覆盖率。它先回答"我们究竟有没有广度失败"——在有数字之前不为广度建层。CodeWikiBench 显示业界最好系统也漏 10%–50% 的官方文档要点（论文数字），说明广度是所有人的难题，而我们的差异化本来就不在广度（材料 B 定位表）。
2. **模块树工件（§六 S3）**：确定性的 workspace→repo→module 树给 authoring packet 的 project 块提供结构导航，同时充当模块级阅读义务的分母——架构感由确定性枚举兜底，不由模型综述兜底。
3. **cross-repo 链路直接充实 cross-feature 矩阵**：解除 `cross-feature.ts:47-50` 自我声明的"仅共享信号"限制。

## 三、有损压缩 vs 深度：冲突真实但可拆——KB 只做索引不做叙述，两者共存

**裁定：bottom-up 叙述合成与已知深度失败真冲突，但冲突住在"叙述"里，不住在"分层"里。采纳共存形态：知识层是索引（id、span、边、digest、条件点、枚举族——全部是我们已经在产的确定性工件），不是叙述（模型写的模块摘要）。索引失真的唯一方式是指错地方，而指错地方是机检的（digest/id 对账）；叙述失真的方式是复述走样，那是现有机制检不了的。**

- 现有 `knowledge.json` 正是索引形态的胚胎：只冻指纹、不建本体、不复制内容（`src/assurance/freeze.ts:77-102`；`docs/architecture.md` freeze 节明文）。方向是让索引更稠（加边、加树、加义务种类），不是在其上加一层叙述。
- 对材料 D-2"每层合成必然有损"的独立核查：**"必然"未被证明**。确定性逐字运输（authoring packet 的 verbatim 摘录）无损但实测不治深度病（根因在更早段）；模型叙述合成的损失率则从未被测过——RepoDoc（材料 E）测的是 API 覆盖（广度）和效率，恰好没测细节保真，既不证实也不证伪。**结论：反对叙述 KB 的现役理由是"两个未解风险（忠实性审计缺链节 + 损失率未测）"，不是"已证有损"。**
- 因此预注册一个度量，作为叙述 KB 的重启前置（不是现在做）：**差分字面量存活率**。绝对存活率阈值不可用——校准已证明真实报告里 5.6%–56% 的字面量不提及是合法的（实测，正是当初否决字面量保真的理由），一份完美无损的摘要同样会因合法不提及远低于任何高绝对阈值，等于把重启通道永久锁死，与设通道的本意相反。改为差分设计：同一批冻结知识跑两条写作路径（直接从 evidence 写作 vs 经摘要写作），比较两条路径**最终报告**的 business literal 存活率（复用 condition-inventory 与 `mentionsLiteral` 的 token 守卫；两臂共享同一合法不提及分布，差值才隔离出摘要层造成的损失），两臂各 ≥3 跑取均值（单跑方差纪律）。预注册判据：(a) 摘要路径均值不低于直接路径 **5 个百分点**；(b) eval golden 的深度 mustFind 项（16/40 类）在摘要路径的多跑命中次数不低于直接路径——均值可以打平，钉住的深度项一条不许丢。没有这两个数字之前，任何"模块摘要作写作输入"的提案不进切片。
- 材料 E 的正确用法：它把 C 方案的批评面收窄了——"无度量钩子"不再成立于**效率维度**（token −85%、增量 −73%，论文自报）。若我们的成本压力持续（个人 spend 受限、并行撰写实证不可用，57B-367/386），效率是叙述 KB 重新上桌的合法理由；但上桌顺序仍是：先测我们自己的摘要损失率与 token 节省，不引用论文数字替代实测。

## 四、cross-repo resolver：定位为 evidence producer，图是它的派生物

**裁定：采纳（与材料 D 一致），定位为证据生产者——每条链路是一条确定性 Finding，两端各绑一条 snapshot 内 evidence；解析不了的一端如实进 Coverage 的 unresolved（`direction.md` §十一），绝不产"可能存在"的裸边。先做 HTTP（前端 URL ↔ 后端路由）：WCP（Go 后端 + TS 前端）是主垂直，wcp-ui 静默漏是已记账的 prepare-miss，57B-391 Phase 1 原文已含"跨仓调用链接（前端↔后端按 URL/path 匹配路由）"——这是收编不是新增。**

数据形状（crossrepo-link-v1，deterministic Finding 的 payload）：

```json
{
  "kind": "http-route",
  "from": { "repo": "wcp-ui", "path": "src/pages/leave/ApplyLeave.tsx", "line": 214,
            "symbol": "submitLeave", "expression": "POST /api/v2/leave" },
  "to":   { "repo": "wcp-service-v2", "path": "internal/handlers/leave/service.go", "line": 73,
            "symbol": "Creation", "route": "POST /api/v2/leave" },
  "resolution": "static | framework | inferred",
  "confidence": "confirmed | probable | possible",
  "evidenceIds": ["S-<frontend-window>", "S-<backend-window>"],
  "contractEvidenceId": "S-<openapi-or-proto>（可选）"
}
```

与现有链的精确对接：

- **Evidence**：`from`/`to` 两端各须一条 source evidence（现有 `source` 命令产物，snapshot 绑定 + digest）；`resolution: framework` 时可另引 framework pack 产物（Catalyst 先例，`src/framework/`）。
- **Finding**：`creationMethod: deterministic`；同 snapshot、同 Provider 版本下 payload 与 evidence 集必须逐字节可复现（`direction.md` §十 可复现性定义直接适用）。
- **Coverage**：单端解析失败 → `unresolved` 行（"前端调了 `POST /api/v2/leave`，后端路由未找到"本身是有价值的调查结果）。
- **Trace**：跨仓链路天然是一条 cross-repository trace step 的素材，`found` 的跨仓 material 流程可直接携带。
- **读义务分母**：被解析出的后端 handler 落进阅读义务，新增 `ObligationKind` 成员——义务枚举从第一天就为此设计（`src/assurance/read-obligations.ts:34-36`："a later denominator adds a member, never a new artifact shape"）。
- **先图后边，否**：不先建图容器。链路 Finding 攒够两类以上、出现跨 resolver 查询需求时，再派生 `semantic/graph.json` 只读视图（对齐 §十七"第二个消费者赚得合同"）。

## 五、目标架构（含审计边界线）

```text
Providers（CodeGraph / native-graph / framework pack / source）
        │  确定性枚举与解析
        ▼
分母层（阅读义务：决策函数 + 边界文件函数 + 模块 + 路由handler + …逐片加成员）
        │                                    ┌────────────────────────────┐
        ▼                                    │ 知识索引（只指不述）：        │
调查（search/source/trace 处置 work items）→  │ knowledge.json 指纹 + 义务 + │
        │                                    │ 条件清单 + 枚举族 + 链路边 + │
        ▼                                    │ 模块树（全部确定性、可再生） │
freeze（完整度门 + 分母/覆盖对账）             └────────────────────────────┘
        │                                            │ 作者用它找证据
        ▼                                            ▼
authoring（claim 只绑 leaf evidence ←──────── 审计边界线：报告句的引用终点
        │                                     永远是 evidence，不是知识节点）
        ▼
audit（读问责硬门 + 冻结对账 + 条件 advisory + preset 持续 PASS）
```

边界规则一句话：**知识层可以帮作者找到证据，不能成为引用终点。** 任何未来的模型产知识节点必须按 57B-391 Phase 2 原文走 agent-interpreted Finding 的冻结 + grounding + 校验，且在 claim→claim 链节与摘要损失率度量（§三）落地之前，不获准进入写作输入。

## 六、切片序列与验收闸门

原则：每片独立可测可交付；advisory 先行、硬化走世代版本闸（`assuranceGenerationAtLeast`，57B-392 成例）；每片闸门必含「16 个 v5 前 run 0 新 finding + preset 报告 audit PASS + 同 snapshot 双跑字节一致」三件套。S0-S3 全部零模型、确定性——不加 token 成本（spend 约束下的关键性质）。

**S0（在途收尾）— 57B-395 V1.3：条件提取补 Perl AST 路径。**
现状：ast-grep 换正则已落（WCP 24→78 条件点、regexOnlySites 0、535 窗口 0 解析失败，实测）；Perl 仍走正则回退且回退对 Perl 实际无效（`$`/`->`/`{}` 不在 LHS 字符类，`src/assurance/condition-extract.ts:65`），已探明接 tree-sitter-perl 的 `relational_expression`/`equality_expression`。
**闸门**：provital 真实 run 的 `.pm` 窗口出现 `via: "ast"` 的 hash-element/scalar 比较 site（不预设具体表达式——此前流传的 `$lv->{hours} > 16` 是测试样例，非 provital 真实代码，闸门不得钉在编造的样例上）；WCP 78 sites 不回退；535 窗口 0 解析失败保持。**依赖**：S0 的 Perl 增量本身不引入新依赖（tree-sitter-perl 已随 57B-385 过白名单并在 native-graph 使用，不重走准入）；但 V1.3 整片确实新增了 `@ast-grep/napi` + `@ast-grep/lang-go`，已于 2026-08-15 补入白名单并记录五条准入的审计结论（`docs/tool-selection.md` §四）。

**S1 — 义务分母第二来源：边界文件内的全部决策函数。**
现分母 = pruned-FG 保留节点的 complement（`src/context/factpack.ts:152-161` 的 `logic` 类目），`Creation` 类漏报的文件其实**已在边界内**、只是函数没被 prune 保留。S1 用已有解析面（ast-grep/native-graph 函数 span）枚举边界文件里全部含决策点的函数 span，作为第二义务来源并入分母（打来源标记，advisory 计入残差、暂不进硬门）。
**闸门（防回归）**：新义务集 ⊇ 旧义务集（机检超集；并集形态下近乎恒真，只防丢失、不证有效）；三件套。**闸门（有效性）**：WCP 真实 run 离线重放中 `Creation@service.go:56` 与 `Demand@service.go:136` **同时**进入分母且状态如实（not-opened/partial）——双例判据，单例可被巧合满足；`service.go` 义务区间的 54–275 空洞消失或显式收窄。**读数**：新增义务数、not-opened 残差变化（预期升——诚实变差是本片的正确方向）。

**S2 — cross-repo HTTP resolver v0.1（§四合同）。**
范围：前端 fetch/axios/客户端封装的 URL 字面量与模板 ↔ 后端路由表（CodeGraph route 节点 + framework pack）。静态匹配 → `static`；框架约定恢复 → `framework`；规则化近似（path 参数展开等）→ `inferred` 降 confidence。
**闸门**：一次性手工固化 10 对已知前后端链路做 gold（leave 提交/审批/撤销等，leave-mini gold 成例）；mustFind 10/10 或逐条记录缺口原因；gold 集上假边 0（与 gold 路由表冲突的链路 = error）；**gold 之外**随机抽 20 条已产出链路人工判真伪（不足 20 全查），假边 ≤1/20（5%），并按 resolution 类别分列——若假边集中于 `inferred`，该类降级为 Coverage 候选而非 Finding（gold 只约束子集内精度，真实调用点数十上百，抽样闸门堵"合成 fixture 系统性漏真实措辞"的老坑；人工核验为记录在案的验收步骤，不进 CI，6-run bench 成例）；每条链路两端 evidence 齐备（机检）；三件套。**读数**：resolved/unresolved 计数入 Coverage；wcp-ui 相关 prepare-miss 实例的归因变化。

**S3 — 模块树 + 模块级阅读义务。**
确定性 workspace→repo→module 树（`module-detection` + native-graph census 已有素材），每个 leaf module 一条模块级义务：feature 调查触没触到该模块（触=有窗口/检索/图查询落在其中）。治 wcp-ui 类整仓静默——函数级义务治不了"整个仓不在边界"这一层。树同时进 authoring packet 的 project 块作导航。**用途裁定：分母来源 + 导航，不采纳 C 的"feature scope 降级为 retrieval 算法"**（重启条件见 §九-4）。
**闸门**：树对 snapshot roots census 对账（每个 leaf module 都在树中，机检）；WCP leave 旧 run 重放中 wcp-ui 被标模块级 not-touched；三件套。

**S4 — E1：rubric 覆盖率评测挂具（eval 线，不进产品闸门）。**
按材料 B §三的方法：官方文档 → 叶级 rubric → 多 judge → 方差传播。目标选有官方文档的 OSS（WCP 无官方文档，这正是该方法的边界——材料 B 4.3#2）。
**闸门**：对 1 个目标跑通，输出叶级覆盖率 ± 方差；产出"广度失败是否实质存在"的第一个数字，作为 §九-2 重启条件的判据。

**S5 之后**：由漏斗数据裁定——prepare 桶仍大 → 继续 resolver 种类（GraphQL/proto/DB/messaging，逐类各带 gold）与 57B-371/320 剪枝改进；read 桶大 → 读残差 advisory 硬化（世代闸）；consume 桶大 → 条件清单进硬门的校准；write 桶大 → packet 消费 advisory 升级。tests-as-oracle 分母（57B-391 原文成员）列为候选，排在 funnel 数据要它的时候。

## 七、常青 vs 可引用：保不可变 run，「常青」= 不可变 run 链 + digest 复用

**裁定：不牺牲 run 不可变性与 freeze。放弃的是"单一常青可变 KB"这个形态，不放弃"持续维护的知识"这个能力——后者由三件已有/可加的机制合成：**

1. **run 链 + 跨 run compare**（57B-360 已落地：metrics + knowledge A→B delta）——"知识的演进"以两个不可变 run 的 diff 呈现，可引用、可审计。
2. **digest-keyed 增量准备**（未来片）：新 run 的 prepare 对文件 digest 未变的部分复用上一 run 的已验证工件（evidence 重验而非重挖，对齐 `direction.md` §五升级语义"Evidence 可以带入，但必须重新验证"）。RepoDoc 的增量 −73%（论文自报）说明这条路的收益天花板值得追，但我们的实现形态是"更便宜的新不可变 run"，不是原地变更。
3. **引用稳定性是护城河**：Code Wiki 用户抱怨"今天读一半明天全变了"（材料 B 4.4）；我们卖的恰是"这份报告的每句话永远可以对回它的 snapshot"。
**代价（明说）**：要"始终最新页面"的用户必须重跑；缓解靠 2 把重跑做便宜，不靠放弃不可变性。

## 八、与 57B-391 的关系及 issue 层级建议（不建 issue，仅建议）

**收编。** 57B-391 的北极星、三阶段与贯穿护栏全部维持；本文做三件事：给 Phase 0 排出后续片、把 Phase 1 的首片具体化、给 Phase 2 增设前置。

- **Phase 0 续片（57B-391 子 issue）**：S0=V1.3 收尾（在途）；S1=V1.4（分母第二来源）；S3=V1.5（模块树/模块义务）；tests-as-oracle=V1.x 候选。
- **Phase 1 首片**：S2=R1（cross-repo HTTP resolver）。原文"Phase 1 由 Phase 0 归因数据 gate"维持——现有归因数据（Creation、wcp-ui 两个 prepare-miss 实录）已部分满足该 gate 的边界段；检索面其余部分（FTS5/RRF）仍等漏斗数据。
- **Phase 2 前置增设**：动态报告/Findings View 不变；**叙述性知识节点进入写作输入，须先过 §三的摘要损失率度量 + claim 链节扩展方案（Fable 复核）**。
- **材料 C 方案的逐项归置**：P0-2 → R1/R2（采纳，改合同为 evidence producer）；P0-1 → 不做，本体从 resolver payload 长出（§二）；P1-1 → V1.5（采纳，改用途）；P1-2/P1-3 → 押后带重启条件（§九-2）；P2 增量 → 改形态为 digest 复用（§七）。

## 九、不做什么（排除清单 + 重启条件）

1. **semantic-graph-v1 统一本体（12 节点 + 13 边预建）**——违反先量后建与 §十七。**重启**：≥2 类 resolver 落地且 payload 形状开始重复/冲突，或出现需要跨 resolver 查询的第二个真实消费者。
2. **叙述性 Semantic KB / bottom-up wiki 页面作为写作输入**——两个未解风险：摘要忠实性无审计链节（claim→claim 不存在，§二）；摘要损失率未测（§三）。**重启**：§三的差分度量在 ≥2 个真实目标上过线（摘要路径均值差 ≤5pp 且深度 mustFind 零丢失）+ 链节扩展方案过 Fable 复核 + token 收益在自己 run 上实测。
3. **可变常青 wiki / 每 commit 原地重生成**——损害可引用性（§七）。**重启**：真实消费者明确要求"始终最新页面"，且即便那时也优先走"digest 复用的便宜重跑"。
4. **feature scope 从主干降级为纯 retrieval（C 的 P1-1 原案）**——现 scope 同时是边界与分母基础。**重启**：模块树在 ≥2 个真实目标上作为分母来源的 gold 漏报率实测低于 feature scope。
5. **语义检索（embedding）进 Core**——57B-391 原文已定为 optional/非权威/离线 provider。**重启**：词法+符号+结构检索落地后 prepare-miss 残余仍显著。
6. **Chat / 图表消费层、跨文档引用注册表、悬停定义**——非正确性问题（B 4.2#3/#5），且 `direction.md` §二 近期不建设清单覆盖。**重启**：进入产品打磨期。

## 十、证伪条件（推翻本文核心判断的观测）

1. **诊断被推翻**（主判据用确定性信号——gold 召回 sd≈10、n=3 时标准误 ≈5.8，只能检出很大的效应，不做主判据）：S1+S2 落地后，(a) 累计漏报账本的漏斗归因中 prepare-miss 占比未下降，且 (b) 深度 mustFind（16/40 类）多跑命中率无改善，且 (c) consume+write 两桶合计 ≥60%（预注册阈值）——"先读取后沉淀"排序错，转向 C 的知识/运输方向。gold 召回三跑均值只作辅证，其无改善**单独不构成证伪**。
2. **深度优先被推翻**：E1 rubric 评测显示架构级（广度）缺失是利益相关方可见失败的主体而细节缺失罕见——广度层（模块树叙述化、综述合成）提前。
3. **确定性 resolver 承诺失败**：R1 的链路多数只能 `inferred` 且 gold 外抽样假边率 >10%（gold 集内是零容忍，证伪信号看抽样面）——跨仓能力需要模型参与，改走 agent-interpreted Finding 路径重新裁定。
4. **索引 KB 经济性失败**：digest 复用实测 token/墙钟改善 <20% 而成本仍是主约束——叙述 KB 带着 §九-2 的前置重新上桌。
5. **有损担忧被证伪**：摘要损失率度量在真实 run 上显示 ~0 损失——反对叙述 KB 只剩审计链节一条，重启门槛显著降低。

## 十一、护栏一致性逐条对齐

- **Core 零模型调用**：S0-S4 全部确定性（解析、枚举、集合对账、树构建）；resolver 的 `inferred` 是规则化近似，仍无模型。任何模型参与的知识产物走 agent-interpreted Finding 合同，且不在 Core 内产生（`direction.md` 原则 18）。
- **依赖白名单**：`@ast-grep/napi`(+lang-go) 已于 2026-08-15 随 V1.3 **正式入列**（五条准入审计结论见 `docs/tool-selection.md` §四）；tree-sitter-perl 已随 57B-385 过白名单并在 native-graph 使用；S1-S3 无新依赖；未来检索索引用 `node:sqlite` FTS5（工具表已列，零新依赖）。
- **垂直中立**：resolver 按协议分类（HTTP/GraphQL/proto/DB/messaging），不按业务垂直；框架特定约定走 framework pack 机制（Catalyst 先例）；分母/树/义务全部框架无关派生。
- **后向兼容（preset 持续 PASS）**：所有分母扩张 advisory 先行，硬化走世代版本闸；已验证先例延续——16 个 v5 前 run 0 条 read-coverage finding（实测）；每片闸门强制三件套（§六）。
- **字节确定性**：每个新工件（义务、树、链路、清单）双跑字节一致纳入测试（read-obligations/read-coverage 成例：pure、zero I/O、byte-stable ordering）。

---

## 附：对材料 C 与材料 D 的采纳/偏离记录（公允性）

**材料 C 采纳**：四条代码事实全部核实属实且被本文引用为依据；cross-repo resolver 是本文 Phase 1 首片（其"前后端一起分析主要靠这个"的判断正确，且 `relate`/`impact` 两个 direction 阶段依赖它）；模块树采纳（改用途）；"不要替代 Evidence"采纳并落成 Finding 机制。**偏离**：诊断句不采纳（与 5-run 硬数据冲突）；本体预建、叙述 KB、可变增量不采纳（各带重启条件，非永久否决）。

**材料 D 采纳**：诊断分歧判定、resolver 优先采纳、KB 暂缓。**偏离三处**：(1) D-3 的"审计边界重写"量级判定过重——正确表述是"新增一段未覆盖链节"，但结论（报告句不得绑摘要）维持；(2) D-2 的"必然有损"未被证明，降级为"未测风险"，并预注册度量；(3) D-4 把模块树当作 `Creation` 类漏报的分母修复——实际 `Creation` 的文件已在边界内，最便宜的修复是 S1（边界文件函数枚举），模块树治的是 wcp-ui 类整仓静默，两者拆为两片各带各的闸门；另经材料 E 修正，"C 方案无度量钩子"的批评收窄到保真维度，效率维度已有（自报）数字。

**评审修订记录（2026-08-15，协调方复核后，裁定人落笔）**：

- §一-3 按真实 run 数据更正与加固：`Creation` 起于 `service.go:56`（规则行 73），`Demand@136` 为第二实例，`service.go` 27 条义务存在 54–275 空洞（实测，run-2026_08_14_17_29）；补 `router.go:30-37` 同名义务的混淆警示。D-4 分歧由该数据坐实。
- §三/§九-2 重启度量由绝对存活率（原预注册 ≥95%）改为**差分设计**：绝对阈值与字面量保真校准（5.6%–56% 合法不提及，实测）冲突——完美摘要也会因合法不提及被判死，等于永久锁死重启通道，与设通道的本意相反。差分（两臂共享合法不提及分布）才隔离出摘要层的损失。判据参数（≤5pp + 深度 mustFind 零丢失）由裁定人预注册。
- S1 闸门拆分防回归门与有效性门，并升级为双例判据（Creation@56 + Demand@136）。
- S2 增补 gold 外抽样假边率闸门（≤1/20），堵"gold 子集内精度不代表全量精度"的口子（e2e 验真实产物教训）。
- 证伪条件 #1 主判据改确定性信号：gold 召回 n=3 的统计功效不足（sd≈10 → SE≈5.8），降为辅证。
- S0 闸门去掉编造的 Perl 样例表达式；tree-sitter-perl 不重走准入（57B-385 已过白名单）。
- **切片排序不受影响**。
