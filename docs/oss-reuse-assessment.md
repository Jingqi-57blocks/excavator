# OSS 复用评估：哪些别自己造，哪些是护城河

> 目的：为下一步开发计划提供依据。回答"要让 skill 更可靠 / 做深度检测 / 扩度量时，有没有现成 OSS 不必从头造"。
> 结论基于 2026-08-11 联网核实（非训练记忆快照）。来源见文末。

## 0. 决定性约束（决定 OSS 能用在哪）

**Core（`src/`）零 npm 运行时依赖、零模型调用、供应商中立**（CLAUDE.md 硬约束）。因此 OSS 只能活在两处：
1. **`eval/`**（测量层，Core 外）；
2. **可选外部 provider**（像 CodeGraph：不装也能 source-only 跑，通过 CLI 调用的独立二进制，不是 npm 依赖）。

**永远不进 `src/`。** 这把下面所有"要不要用 OSS"的答案框死了。

---

## 1. 度量/评测层（`eval/`）——结论：不换，我们的设计已被业界背书

**核实**：2026 主流 OSS eval 框架 = DeepEval / Promptfoo / Ragas / Inspect AI 等。业界最佳实践明确是**"用容差带不用精确阈值、钉住 judge 模型、采样稳定 golden 集"**——**正是我们已在做的**（见 [[recall-single-run-variance]]：单跑召回噪声主导、多跑取均值）。

**概念对应**：
| 业界指标（Ragas） | 我们的 eval | 
|---|---|
| Faithfulness（claim 有证据支撑） | forbidden pin |
| Context Recall（该检索的检索到没） | mustFind 召回 |
| Context Precision | coverage 维度 |

**判断**：
- Ragas 是"对代码做 RAG"这个域的概念同行——**它验证了我们的指标设计是对的，不是野路子**。
- **但不采用**：Ragas/DeepEval 用 **LLM-judge + Python 依赖**，违背我们 `eval/` **零模型 + 零依赖**的刻意选择。我们的 golden harness（57B-358/363/365）零依赖、贴着 Excavator 工件模型定制（按 source-anchor 对齐 knowledge），且已验证有效（57B-365 判别器真抓出深度失败）。换 OSS 是净负。
- **唯一例外**：若将来要做 LLM-as-judge 那条路（SKILL 自评），用 DeepEval 的 G-Eval / Promptfoo 的 llm-rubric，别从头搭。但那条路的固有弱点（同模型自我盖章）未变。

**行动**：eval 层维持现状；把"扩 golden 度量"（leave-midi 等）当可靠性主线（见 [[investigation-depth-line]]）。

---

## 2. 深度检测层——结论：Semgrep CE 值得做原型，材料优于自建 grep（否决过的候选 c）

**背景**：候选 c（fact-pack thresholds，扫全库 `>\d+`）因**噪声墙**被否决——`Hours > 16`（业务阈值）和 `Font.Size = 16`（样式常量）纯文本扫描分不开。

**核实（Semgrep Community Edition，免费 OSS）**：
- **`metavariable-comparison` + `pattern-inside` 都在免费 OSS 引擎**（非 Pro）。→ 能写免费规则匹配"**if 分支条件里**的数值比较 `$X > $N`"，并与普通赋值 `size = 16` **区分开**。**这正好绕开候选 c 的噪声墙**——不再扫裸 `>\d+`，而是"分支条件里的阈值"。
- **单文件/单函数作用域**（跨文件数据流是 Pro）。→ 对我们够用：深度检测只需看**作者已 cite 的单个证据窗口**（本就文件级），不需要跨文件。
- 免费、离线（`--metrics=off`、code 不上传）、支持 Go + TypeScript（30+ 语言）。

**可行的架构（"引用窗口未说分支"advisory）**：
1. Semgrep（作**可选外部 provider**，同 CodeGraph 模式，CLI 调用、不进 Core）在**作者 cite 的证据窗口**里找"分支条件 / 数值阈值"决策点；
2. 我们的**确定性检查**（Core 内、零模型）交叉比对：该决策点有没有对应 claim 描述其结果 → 无则 advisory warning。
3. 分工：Semgrep 出"哪里有决策点"（它已解决的语义匹配难题），我们出"决策点 vs claims 的对账"（确定性、我们的强项）。

**诚实边界（不夸大）**：
- Semgrep 能判"这是分支条件里的阈值"（比 grep 强得多），但**仍不能判"16 小时是否业务重要"**——语义材料性是模型territory。所以它是 **advisory（warning）**，不是硬门。
- 它**降低**噪声、不消除。假阳率需真实 run 实证后才能定它值不值得进流水线。
- 引入外部工具依赖（作 provider，非 Core）——用户需自备 semgrep 二进制（同 codegraph 现状）。
- **替代**：只要"找分支条件"，理论上 tree-sitter 也能做，但 tree-sitter 走 npm 绑定=Core 运行时依赖（违约束）；Semgrep 作独立二进制 provider 更贴合架构。

**行动候选**：做一个**小原型** Semgrep 规则 + 拿真实 leave run 的 cited 窗口实测假阳率，再决定是否正式做这条 advisory。零模型、可离线。

---

## 3. 竞品/复用情报——结论：可辩护保证链是护城河，SCIP 是 provider 层复用候选

**核实到有 OSS 正在逼近 Excavator 的相邻域**：
- **SCIP**（Sourcegraph 的 Code Intelligence Protocol）：语言无关的源码索引协议，驱动 go-to-def / find-references。有各语言 indexer（scip-go / scip-typescript 等）。
- **"SCIP + citation linter → grounded lint-clean markdown wiki，无图数据库、无 SaaS"** 类工具：几乎是 Excavator 的 pitch。
- **Understand-Anything**（Claude Code 插件，~54.7k★）：Tree-sitter 确定性边 + LLM 语义标注建知识图 + 交互 dashboard。**不同价值主张**（交互探索，非可辩护报告）。

**战略判断**：
- 这些工具做到了 **grounded 引用 + citation lint**，但**大概率没有 Excavator 的可辩护保证链**——append-only 哈希链 timeline、freeze 硬门、ASSURANCE_VERSION 版本门控、对称删除检查、claim 逐句绑证据 + 硬 audit。**"可审计的引用" 是护城河，别人做的是"有引用"。** 这部分**自己造是对的，无 drop-in 替代。**
- **SCIP 是真正的 provider 层复用候选**：Excavator 的 CodeGraph 若基于 SCIP，可白捡多语言 indexer 覆盖（scip-go/scip-typescript/…）。但这是**较大的架构改动**（CodeGraph 已是可选 provider），非当前范围——记为长期候选。
- citation-lint 工具验证了"引用可解析"这个我们已做且做得更多的方向。

---

## 4. 汇总：用 / 造 / 参考

| 层 | 决定 | 具体 |
|---|---|---|
| eval 度量 | **不换，当背书** | 维持零依赖 golden；扩覆盖走 leave-midi，非换 OSS。想要 LLM-judge 再看 DeepEval G-Eval |
| 深度检测 advisory | **值得原型** | Semgrep CE 作可选 provider（免费/离线/Go+TS），躲开候选 c 噪声墙；先实测假阳率 |
| 解析/符号 | **长期复用候选** | SCIP 作 CodeGraph provider 基础（多语言白捡）；架构级，非当前范围 |
| 保证链核心 | **自己造（护城河）** | freeze/audit/assurance/版本门控——无 drop-in，是差异化 |

---

## 5. 待用户裁决 / 下一步候选

1. **Semgrep 深度检测 advisory 原型**：值不值得花一个小切片做原型（写规则 + 拿真实 leave run cited 窗口实测假阳率）？零模型。**优先级 vs leave-midi（golden 扩展）需权衡**——两者都攻深度可靠性，前者是"运行时检测"、后者是"回归度量"。
2. **SCIP 化 CodeGraph provider**：长期架构候选，记录待议，非近期。
3. **eval 现状维持**：无行动，仅确认设计被背书。

## 来源（2026-08-11 核实）
- LLM eval 框架现状：futureagi.com/blog/best-open-source-eval-frameworks-2026、aiml.qa/llm-evaluation-framework-benchmark-2026、deepeval.com/blog/top-5-llm-evaluation-frameworks
- Semgrep CE 能力：github.com/semgrep/semgrep、docs.semgrep.dev/writing-rules/rule-syntax（确认 metavariable-comparison + pattern-inside 在免费 OSS 引擎；单文件作用域；跨文件数据流为 Pro）
- 竞品/SCIP：github.com/sourcegraph/scip、scip-code.org、codebase-understanding GitHub Topics、Understand-Anything（dev.to/arshtechpro）
