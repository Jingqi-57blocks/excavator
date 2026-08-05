# Excavator 项目开发方向（定稿 v1.0，2026-08-05）

> 本文件与 Linear 项目文档《Excavator 项目开发方向（定稿 v1.0）》保持同步；两处内容不一致时先修复同步，再继续开发。

> **修订记录**（相对讨论中的最后一版）：
> ① §三：「只依赖统一 Provider 协议」改为「内部 Provider 接缝，协议由第二个结构化 Provider 实现赚得」，与 §十七 合同稳定纪律对齐（已确认）；
> ② 恢复「可复现性定义」整节（§十，上一版重组时丢失；已确认）；
> ③ 恢复战略复审的预注册数字「连续两个评测周期」与小样本判定规则（§十六；已确认）；
> ④ 恢复评测 Harness 的限定语「不等同于真实外部消费者」（§十五，来自更早版本，重组时丢失）；
> ⑤ 恢复 Provider 充分性不足时的四条强制行为（§四，来自更早版本，重组时丢失）；
> ⑥ §二 增加模型中立条款、§十八 增加原则 18；agent 形态与工具选型的具体决定见《开源工具与集成选型》（已确认）。

## 一、产品定位

Excavator 是一个由宿主 AI Agent 驱动、本地优先、跨工具中立的代码调查引擎。

它主要为以下高风险工程决策提供可辩护的调查结果：

- 遗留系统接手与技术尽调；
- 修改前的影响评估；
- PR 和 CI 中的工程判断；
- 模块拆分与现代化规划；
- 面向客户的正式产品和工程报告。

Excavator 的核心价值不是简单回答代码问题，而是让调查结果：

- 可追溯；
- 可复现；
- 可保存和比较；
- 覆盖范围可问责；
- 未知和限制明确可见。

交互问答用于探索目标、修正边界和逐步补充调查，是正式调查的控制界面，而不是独立聊天产品。

## 二、产品形态

近期采用：**宿主 AI Agent + Excavator Core + Provider Layer + 本地文件工件**

宿主 AI Agent 负责：理解自然语言问题；协助确认和修正调查目标；驱动查询和补充调查；起草需要语义解释的 Finding；将结构化结果组织成回答或正式报告。

Excavator Core 负责：源码边界和 Snapshot；Investigation Session；Investigation Plan；Evidence、Finding 和 Coverage 的存储与校验；预算、缓存、恢复和 Audit；JSON、Markdown 和 CI 工件。

Provider Layer 负责：提供代码实体和关系；提供索引覆盖、解析错误和未解析关系；帮助定位 Target；帮助扩大关系召回。

Excavator Core 不调用任何模型 API、不持有任何模型密钥；宿主 Agent 与模型由使用者自由选择。所有宿主打包（Claude Skill、AGENTS.md、MCP 等）均为同一份中立指令源的薄包装。

近期不建设：独立聊天服务器；模型代理平台；多租户系统；托管式知识图服务。

## 三、Excavator 与 CodeGraph 的边界

### CodeGraph 的产品身份

CodeGraph 是 Excavator 当前默认且优先验证的结构化 Provider。

CodeGraph：

- 不是 Excavator 的产品核心；
- 不是所有功能的必需依赖；
- 不是最终事实来源；
- 不负责会话、调查计划、证据账本、报告或审计；
- 可以被其他结构化 Provider 替换或补充。

Excavator Core 不应依赖 CodeGraph 的 SQLite Schema、内部查询方式或具体实现。Core 只通过**内部 Provider 接缝**访问 CodeGraph；该接缝在第二个结构化 Provider 出现时硬化为公开协议（与 §十七 合同稳定纪律一致，不提前建全量协议）。

### Excavator Core 负责什么

定义如何调查；管理 Inquiry 和 Target；生成 Investigation Plan；管理 Session 和 Snapshot；管理 Evidence、Finding、Claim 和 Coverage；执行 Assurance 和 Audit；处理缓存、恢复和刷新；生成聊天、JSON、报告和 CI 输出；管理 Benchmark 和质量评测。

### CodeGraph Provider 负责什么

文件、类、方法和其他 Symbol；调用、引用、继承、实现和实例化关系；路由等入口候选；跨文件和跨仓库关系候选；索引覆盖情况；解析错误；未解析引用；Provider 版本和索引身份。

CodeGraph 的结果用于导航、候选召回和缩小源码调查范围。权限、业务规则、状态变化、数据语义、路由组合和错误处理等结论仍需通过源码确认。

### Source Provider 负责什么

Source Provider 是所有语言的基础能力，并承担最终语义确认。它负责：文件枚举；文本和正则搜索；受限源码窗口读取；Git-aware 源码边界；Secret 排除和脱敏；源码 Evidence 和摘要校验。

没有 CodeGraph 时，Excavator 仍可通过 Source Provider 工作，但部分调查的速度、范围和置信度会下降。

### Provider 协议（接缝能力面）

Excavator 面向以下通用能力，而不是面向 CodeGraph 的具体数据库：查询 Symbol；解析实体；扩展关系；查找入口；返回未解析关系；返回能力声明；返回目标范围覆盖；返回 Provider 版本和索引身份。

未来可以接入：CodeGraph；Source-only Provider；LSP；Tree-sitter；宿主 Agent 原生代码索引；特定语言或框架插件。

## 四、不同能力对结构化 Provider 的依赖

| 能力 | 对 CodeGraph 的要求 | 对结构化 Provider 的实际依赖 |
| -- | -- | -- |
| Session、Finding、Coverage、Audit | 不需要 | 很低 |
| 现有正式报告 | 可选 | 中等，可通过源码补偿 |
| 功能解释 | 可选 | 中等 |
| 功能关联分析 | 可选 | 中高 |
| Target Resolution | 非必需 | 高度影响准确性 |
| What-if Impact | 非必需 | 高 |
| Diff Target 影响分析 | 非必需 | 高 |
| 双快照比较 | 非必需 | 中高 |
| 模块拆分与迁移 | 非必需 | 很高 |
| CI 审计和门禁 | 不需要 CodeGraph 本身 | 取决于被审计结论所需能力 |

因此：

- Phase 0–1 不应被 CodeGraph 改造阻塞；
- Phase 2 开始需要正式评测 CodeGraph 的 Target Resolution 能力；
- Impact 和 Extraction 产品化前，必须验证至少一个足够强的结构化 Provider；
- 如果 Provider 不足，系统必须降低置信度，而不是伪装成完整分析。

充分性不足时，系统必须：

- 限制 Finding 最高置信度；
- 显示降级提示；
- 强制输出 Unresolved 和 External Unknown；
- 阻止 Formal Audit 接受不符合保证条件的高置信结论。

## 五、调查会话

除现有正式 Report Run 外，增加轻量 Investigation Session。

Session 支持：一次准备，多轮查询；Target 持续修正；Evidence、Finding 和 Coverage 增量累积；不要求报告 Documents；使用独立的秒级交互预算；可升级为 Formal Report 或 Formal Impact Run。

### Session 升级为 Formal Run

1. 确认使用当前 Snapshot 或先刷新；
2. Evidence 可以带入，但必须重新验证；
3. Findings 可以带入，但按 Formal Profile 重新校验；
4. 根据正式调查类型创建完整 WorkItem Plan；
5. Formal Timeline 从升级时新建 Hash Chain；
6. Formal Run 记录父 Session 和带入工件摘要；
7. Session 的非正式操作不直接进入 Formal Hash Chain；
8. Formal Audit 只接受满足正式要求的工件。

## 六、快照漂移

每个交互回答应显示：Snapshot ID；创建时间；Git HEAD；Dirty 状态。

会话期间源码发生变化时，分三层处理：

- **轻量检测**：常规检查 Git HEAD、Git status、相关文件 mtime 或 size；
- **引用前校验**：回答引用某条源码 Evidence 前，重新验证对应源码摘要。未变化：继续使用；已变化：标记 stale；不静默引用过期 Evidence；
- **完整刷新**：只有用户选择刷新、升级正式调查或重新建立范围时，才完整重建 Snapshot。

单会话漂移处理与 before/after 双快照比较属于不同能力。

## 七、统一调查模型

**Inquiry**：`explain` / `relate` / `impact` / `compare` / `extract`

**Target**：项目；功能或模块；文件；类、方法或其他 Symbol；页面、API 或后台任务；数据实体；Git Diff 或 PR。

**Investigation Plan** 根据 Inquiry 和 Target 决定必须调查：页面、API、命令和后台任务入口；调用、引用和实现关系；数据读写和共享存储；权限和数据范围；状态流转和业务规则；配置和功能开关；通知、文件和外部集成；测试和文档；跨仓库和重复实现；未解析和运行时未知项。

## 八、核心工件

### Evidence

绑定单一 Snapshot 的源码或结构化观察：Snapshot ID；路径和范围；内容摘要；Provider；产生原因。

### Finding

统一信封 + 分类 Payload，不建立万能三元组模型。

统一信封：Finding ID；Finding 类型；Snapshot IDs；Evidence IDs；Confidence；Limitations；Creation Method；Source Providers。

`creationMethod` 区分：

- `deterministic`：由 Core 根据图、Diff 或结构化数据生成；
- `agent-interpreted`：由宿主 Agent 根据 Evidence 解释生成，Core 校验后入账。

Payload 可以表达：关系；业务规则；状态迁移；数据访问；权限；影响；比较；Provider 充分性；Coverage。

### Provider Sufficiency Finding

Provider 充分性裁决本身必须成为可解释、可审计的 Finding，记录：调查所需能力；实际可用能力；Target 范围覆盖；未解析关系；Source fallback 使用情况；关键关系是否经过源码确认；置信度被限制的具体原因；支撑裁决的 Evidence。

不使用无法解释的单一总分决定置信度。

### Claim

正式文本中的句子或表格行，绑定 Finding 或 Evidence。Claim 属于 Formal Profile，不是交互模式的基础数据模型。

### Coverage

记录：已调查维度；找到结果的维度；searched-not-found；Provider 不支持项；未解析关系；工作区外和运行时未知项。

## 九、保证等级

### Interactive Profile

强制要求：Evidence ID 存在；Finding 和 Evidence 的 Snapshot 一致；Finding 通过 Schema 校验；Creation Method 明确；inference 和 unavailable 有原因；引用前执行轻量 Evidence 校验；展示 Coverage、限制和未知项。

不要求：每句话建立 Claim；WorkItem 全量处置；完整 Timeline；Formal Audit。

宿主 Agent 的最终回答是否完全忠实于 Findings，无法被机器完全证明。缓解方式是让 JSON 易引用、减少自由转述，并将高风险结论升级为 Formal Profile。

### Formal Profile

要求：逐句或逐表格行 Claim；WorkItem 完整处置；关键流程 Trace；独立 Formal Timeline；完整 Audit；审计失败时不能标记完成。

## 十、可复现性定义

可复现性不要求所有自然语言输出逐字一致。

**Deterministic Finding**：相同 Snapshot、Target、Provider 版本和查询参数下，应保持 Finding 类型一致；Payload 一致；Evidence 集一致；Confidence 和 Limitations 一致。

**Agent-interpreted Finding**：相同条件下要求证据等价，而不是文本完全相同：由相同或语义等价的 Evidence 集支撑；关键事实不互相矛盾；Confidence 等级不无依据变化；Limitations 不被静默删除。

**Formal Report**：不要求正文逐字一致，但要求关键 Claim 集一致；Evidence 覆盖等价；WorkItem 处置不矛盾；审计结果一致。

## 十一、影响结果分类

- Confirmed Direct
- Confirmed Indirect
- Possible
- Unresolved
- External Unknown

Possible 结果必须：按证据强度排序；合并重复候选；设置数量预算；默认折叠低优先级内容；支持继续调查指定候选。

Excavator 不承诺绝对没有遗漏，而是确保未知不会被表示为无影响。

## 十二、双快照兼容

基础合同必须满足：

1. 每个 Evidence 属于单一 Snapshot；
2. Finding 可以引用多个 Snapshot；
3. Comparison Finding 明确表达 before 和 after；
4. 缓存键和实体身份不默认单 Snapshot；
5. Claim 可以引用 Comparison Finding。

单快照 Impact 可以使用 Diff 或 PR 选择 Target，但不进行真正的行为前后比较。真正的 before/after 比较在双快照阶段实现。

## 十三、阶段性开发方向

- **Phase 0：最小合同与评测**——Assurance Profiles；Evidence、Finding、Claim 和 Coverage 合同；Finding Creation Method；Session 升级语义；双快照兼容要求；Provider Sufficiency Finding；可复现性定义；最小 Benchmark；裸宿主 Agent 对照；战略复审规则；首个技术栈选定。只定义当前垂直薄片需要的最小合同。
- **Phase 1A：Findings 派生视图**——从现有报告工件派生 Findings JSON。不改变现有报告流程和行为。
- **Phase 1B：Investigation Session**——多轮调查；交互预算；Evidence 增量累积；漂移检测；Session 升级。
- **Phase 1C：第一个交互消费者**——有限范围的 `explain feature` 或 `relate feature`。
- **Phase 2：Target Resolution**——定位、候选排序和置信度、include/exclude、跨仓库、会话内边界修正、Gold Set 评测、范围修正率记录。
- **Phase 3：功能理解与关联**——功能解释；执行流程；关联功能；API、数据实体和 Symbol 使用范围；跨仓库和重复实现。
- **Phase 4：计划变更与单快照影响**——What-if 变更；文件、Symbol 和路由影响；影响分桶；测试、配置、文档和共享数据影响；Diff 或 PR 作为 Target 输入；Provider Confidence Ceiling。
- **Phase 5：双快照、比较与刷新**——before/after Snapshot；Comparison Finding；PR 行为变化；Evidence stale；结果过期判断；调查重跑；缓存复用；CI 触发。
- **Phase 6：模块拆分与迁移**——模块边界；内外依赖；共享数据和多写入方；循环依赖；权限、配置和外部集成；共同迁移范围；运行时未知项。

## 十四、第一个垂直里程碑

选择一个内部需求最密集的语言、框架和仓库形态。

选择依据：57blocks 内部项目分布；客户接手和评估需求；现代化和拆分需求；当前 CodeGraph 或其他 Provider 质量；可获得的真实验证项目。

首个里程碑完成：最小 Benchmark；裸 Agent 对照；Findings 视图；Investigation Session；Target Resolution；explain / relate；有限 What-if Impact；现有 Formal Report 保持可用。

## 十五、评测体系

**Baseline Arm**：同一宿主模型，不使用 Excavator，直接调查和回答。

**Excavator Arm**：同一宿主模型，使用 Investigation Plan、Evidence、Findings 和 Coverage。

比较：Target 准确率；关系和影响召回率；错误关联率；未知项识别率；Evidence 正确率；可复现性；可验证性；时间和模型成本；人工修正次数；范围修正率和幅度。

评测 Harness 直接通过 CLI 和 JSON 合同驱动 Excavator，用于发现对特定宿主的隐式依赖。它是第二种执行环境，但不等同于真实外部消费者；公共兼容性承诺仍需真实消费者验证后获得。

## 十六、战略复审

对照评测必须能够改变产品方向。Phase 0 预先记录战略复审触发条件。

触发条件：在**连续两个评测周期**中，针对 Impact、Formal Report 或 Extraction 等高风险场景，Excavator 在准确性、未知识别、可复现性或可验证性上没有产生实质增益，同时延迟、成本或操作复杂度明显更高，且真实内部项目也未观察到决策质量或交付效率改善。

触发后必须进行战略复审，选项包括：收缩为正式报告和客户交付工具；并入 57blocks 内部服务工具链；聚焦少数强 Provider 技术栈；停止独立产品方向投入。

早期样本较小时，不单独依赖统计显著性，而采用预定义效果门槛、连续结果和真实项目反馈综合判断。

## 十七、合同稳定纪律

- Findings JSON 在出现第二个真实消费者后提供强稳定性承诺；
- Provider API 在出现真实第三方实现前保持内部可演进；
- CLI 标注实验性、稳定和废弃状态；
- 每个公开合同必须有明确消费者和兼容性测试；
- CodeGraph SQLite Schema 不作为 Excavator 公共合同。

## 十八、长期原则

1. 产品重心是可辩护调查，不是通用代码聊天。
2. 交互是高风险调查的范围控制机制。
3. 一个调查引擎，多种问题和输出。
4. CodeGraph 是 Provider，不是 Excavator 本身。
5. Source Provider 是通用回退和最终语义依据。
6. 从现有报告能力渐进提取统一模型。
7. Finding 区分确定性生成与 Agent 解释。
8. Provider 充分性必须影响置信度和 Assurance。
9. Provider 充分性裁决本身必须可解释和可审计。
10. Interactive 模式也执行最低 Evidence 校验。
11. 核心语言无关，Provider 决定结构化分析深度。
12. 不承诺绝对完整，让影响、覆盖和未知分级可见。
13. Target Resolution 是高风险能力的前置条件。
14. 稳定合同由真实消费者赚得。
15. 先完成单栈垂直闭环，再扩展语言和场景。
16. 持续通过裸 Agent 对照验证产品价值。
17. 优先本地 CLI 和文件工件，不建设重型平台。
18. Core 零模型调用；模型与宿主中立由架构保证，而非适配保证。

## 最终方向

Excavator 应从可信项目报告工具，渐进发展为：

**一个跨宿主、本地优先的可辩护代码调查引擎。**

它通过有立场的 Investigation Plan、Evidence、Finding、Coverage 和分级 Assurance，帮助团队在影响评估、遗留系统接手、模块拆分、正式报告和 CI 门禁等高风险场景中形成可追溯、可复现、可问责的工程判断。

CodeGraph 是当前优先使用和验证的结构化 Provider，但不是 Excavator 的产品核心，也不是唯一可用的实现。

"跨宿主"是需要通过合同和评测逐步验证的目标，不作为当前已经完全实现的能力声明。
