# Excavator 开源工具与集成选型（定稿 v1.0，2026-08-05）

> 本文件与 Linear 项目文档《Excavator 开源工具与集成选型（定稿 v1.0）》保持同步；两处内容不一致时先修复同步，再继续开发。

> **修订记录**（相对讨论最后一版）：
> ① §七 拆分两类实验设计（宿主臂 / 模型臂），模型臂共享同一套确定性工具；
> ② §一 工具阶梯改为双向（Supported 可降级），CodeGraph 的追溯性检验 = Phase 2 正式评测；
> ③ §四 Benchmark 数据同时用于 Provider Sufficiency 模型标定；补 Tree-sitter 适用说明；
> ④ Core 零运行时 npm 依赖改为绝对约束（"尽量"只适用于周边包）；
> ⑤ §八 重构：指令层中立化提前进 M1（Phase 1C），MCP 保持 M1 后，独立 Agent 形态列为未来阶梯项。
> ⑥（2026-08-13，用户裁定 · 57B-385）**Core 零运行时 npm 依赖（绝对约束）→ 审计过的白名单依赖**：CodeGraph 覆盖不到的语言（Perl/Zope 等）需要成熟解析库补全，自维护每语言解析器不可持续。`tree-sitter` / `tree-sitter-*` 语法与 `universal-ctags` 升为 Core 可用（见 §一、§二工具表、§四）。零模型调用不变；放开不改变可辩护/无黑箱与供应链安全两条真正收益，白名单正为守住它们而设。
> ⑦（2026-08-15 · 57B-395）**`@ast-grep/napi` + `@ast-grep/lang-*` 进入 Core 审计白名单**（库形态；CLI 形态仍未采用）。用于把条件提取从手写正则换成 AST。五条准入的审计结论见 §四；遗留风险：native 二进制 + install script 面，建议单独做一次 supply-chain review。

## 一、选型原则

Excavator Core 保持：本地优先；无常驻服务；公共工件可移植；Provider 可替换；不绑定特定语言、宿主或代码索引。

**Core 运行时依赖限审计过的白名单（2026-08-13 起，替代原"零依赖绝对约束"）。** 每个 Core 运行时依赖须逐个过审计准入，全部满足方可进入 `src/`：

1. **不联网**——运行期不发起任何网络请求；
2. **不越界读写**——只在调用方声明的路径范围内读，除 `--out` 外不写目标；
3. **传递依赖可控**——传递依赖数量少、来源可信、可审阅；
4. **不破坏审计产物的字节确定性**——同输入同输出，不引入墙钟/随机/locale 敏感行为；
5. **有降级/移除路径**——依赖不可用时能优雅降级（如源码 fallback），不使产品瘫痪。

Core 仍**零模型调用**。放开的动机：CodeGraph 覆盖不到的语言（Perl/Zope 等）需要成熟解析库（`tree-sitter`）补全，自维护每语言解析器不可持续。放开**不改变**零依赖真正买到的两条——**可辩护、无黑箱**（依赖行为须可审计）与**供应链安全**（Excavator 跑在他人机密代码上）——白名单正是为守住这两条而设，不是放任任意依赖。周边包（`packages/*`）尽量轻量，可拥有自己的依赖。

工具分为三个状态：

1. **Benchmark Candidate**：可以在评测环境中试运行，不进入产品、不注册为正式 Provider。
2. **Experimental Integration**：已证明可能改善指标，但接口仍可演进。
3. **Supported Integration**：已有真实消费者、兼容性测试和明确支持边界。

任何候选工具都可以先在 Benchmark 中测量。产品接入必须由 Benchmark 和真实项目收益共同决定。

**阶梯是双向的**：Supported 工具同样接受周期性 Benchmark 复检，可降级或移除。CodeGraph 以现任身份直接进入 Supported，其追溯性检验就是方向文档 §四 规定的 Phase 2 正式评测。

## 二、最终工具表

| 层 | 最终选择 | 接入方式 | 进入时机 |
| -- | -- | -- | -- |
| 公共合同 | JSON Schema 2020-12 | `schemas/` 中的版本化文件 | Phase 0 |
| 运行时合同校验 | Ajv 构建期编译 + 自包含 validator bundle | Ajv 仅为开发依赖，Core 发布生成的 ESM 校验模块 | Phase 0 |
| 单元与集成测试 | `node:test` | 现有测试体系 | Phase 0 |
| 评测 | 宿主无关 Eval Harness | 直接驱动 CLI、JSON 工件及可选模型 Adapter | Phase 0 |
| 源码边界 | Git | Snapshot、Manifest、Diff、dirty 状态 | 已有 |
| 规范文本搜索 | 现有 Node Source Search | 定义统一搜索语义 | 已有 |
| 文本搜索加速 | ripgrep | 可选执行后端，只搜索 Manifest 明确列出的文件 | Benchmark 证明需要后 |
| 默认结构化 Provider | CodeGraph | Provider Adapter，不暴露 SQLite Schema | 已有 |
| 非支持语言符号+调用（补 CodeGraph 盲区） | `tree-sitter` + `tree-sitter-*` 语法（首个 Perl） | Core 内自建 AST 抽取器，产出可导航符号+调用图；只当导航层，claims 仍 grounding 到源码；动态分派诚实标 unresolved | 审计白名单，2026-08-13（57B-385） |
| 跨语言符号定义清单（补 CodeGraph 盲区） | `universal-ctags` | 可选外部二进制（同 CodeGraph 的外部工具定位），出定义 kind+file:line；缺失则降级 | 审计白名单，2026-08-13（57B-385） |
| 候选结构化 Provider | 选定技术栈的 SCIP Indexer | 先进入 Benchmark，证明收益后再接入 | Phase 2 |
| 源码内条件/模式的结构化提取 | `@ast-grep/napi` + `@ast-grep/lang-*` 语法包 | Core 内库调用（非 CLI）；一份模式文本跨 C 家族语法提取比较表达式，AST 天然排除注释与字符串体；无语法的语言诚实降级并按 site 标注路径 | 审计白名单，2026-08-15（57B-395） |
| 结构模式搜索（CLI 形态） | ast-grep CLI | 作为外部可执行文件的用法仍未采用；库形态见上一行 | 未采用 |
| 公共持久工件 | JSON / JSONL | Evidence、Finding、Coverage、Claim、Trace、Timeline | 已有并继续 |
| 内部查询加速 | `node:sqlite` | 可删除、可重建的派生索引 | Phase 1B，确有性能需求时 |
| Diff 事实来源 | Git Diff + 双侧 Provider 分析 | Core 输入 | Phase 4–5 |
| GitHub PR 适配 | 可选 `gh` Adapter | 外围包，不属于 Core | Phase 4 |
| 人类 Diff 展示 | 可选 difftastic | 只用于展示和诊断 | Phase 5 |
| 深度规则分析 | 可选 Semgrep CE / Joern | 先核对能力与许可证，再作为独立 Provider | 明确需求后 |
| 宿主指令打包 | 中立 driver 指令源 + Claude Skill / AGENTS.md 薄包装 | 共用一份中立指令源 | **Phase 1C（M1 内）** |
| 通用工具接口 | 可选 MCP Server | 独立包（`packages/excavator-mcp`）包装 CLI | M1 完成后 |
| 独立 Agent 形态 | API key 直连（OpenRouter 等 OpenAI-compatible 端点） | 未来阶梯项；胚胎 = Harness 的 OpenAI-compatible Adapter + 最小工具循环，产品化时晋升为 `packages/excavator-agent` | 真实需求出现后 |

## 三、JSON Schema 校验方案

JSON Schema 2020-12 是唯一公共合同。

构建流程：

```text
schemas/*.schema.json
→ Ajv 编译
→ 生成 validator 模块
→ bundle 为自包含 ESM
→ 提交或随发行包发布
```

运行时：Core 只调用生成的校验函数；不加载 Ajv；不动态编译 Schema；Interactive Profile 和 Formal Profile 都必须执行相应校验。

CI 必须检查：Schema 本身合法；validator 可以重新生成；生成结果与仓库内容一致；所有样例工件通过或按预期失败。

## 四、Benchmark 与正式接入分离

候选工具可以进入 Benchmark，而不进入产品。

例如 SCIP 的评估流程：

```text
同一 Target Gold Set
├── CodeGraph 结果
├── Source-only 结果
└── SCIP Indexer 结果
```

比较：Target 定位；Definition / Reference 召回；错误关系；未解析关系；构建耗时；索引大小；安装复杂度。

只有 SCIP 显著改善目标技术栈的实际指标后，才进入 Provider Registry。

**Benchmark 测量数据有双重用途**：既是准入裁决依据，也是 Provider Sufficiency 模型的标定数据（覆盖率、未解析密度与实际召回的对应关系需要多个 Provider 的数据点才能标定）。

同样规则适用于：ripgrep；ast-grep **CLI**（外部可执行文件形态）；Semgrep；Joern；其他 LSP 或索引器。

**Tree-sitter 已于 2026-08-13（57B-385）从 Benchmark-only 升为 Core 采用**：作为 CodeGraph 语言盲区（Perl/Zope 等）的补充符号+调用抽取器进入 `src/`（审计白名单）。其产物是导航层（等同 CodeGraph 的定位角色），报告事实仍 grounding 到源码窗口；静态不可解析的动态分派诚实标 `cannot-determine`，不臆造调用边。`universal-ctags` 以可选外部二进制同期进入，出跨语言定义清单。

**ast-grep 的库形态（`@ast-grep/napi`）已于 2026-08-15（57B-395）进入 Core（审计白名单）**，CLI 形态仍未采用。用途：把源码内的条件（比较表达式）从手写正则换成 AST 提取——正则是按语言计的漏检机器（实测 WCP 24 / provital 5 / cebreo 0 条件点），且会把注释与字符串体里的比较误当真条件。五条准入的审计结论：① **不联网**——运行期纯内存解析，无网络面；安装期 prebuild 随包发布，缺 prebuild 时才本地构建；② **不越界读写**——解析调用方传入的字符串，不自行读写文件；③ **传递依赖可控**——同 org 的平台二进制包 + `@ast-grep/setup-lang`；④ **字节确定性**——真实 run 双跑逐字节一致（WCP 78 site / provital 11 site 各验）；⑤ **降级路径**——native binding 缺失或语言无语法时降级为正则，且按 site 记录 `via` 字段使降级可见。**遗留风险（已记账）**：native 二进制 + install script 面，跑在他人机密代码上，建议单独做一次 supply-chain review。

## 五、文本搜索边界

现有 Node Source Search 是规范实现，定义：Snapshot 文件范围；Secret 排除；文本文件类型；正则和大小写语义；排序；截断；Coverage 统计。

ripgrep 只是加速后端。ripgrep Adapter 必须：只接收 Snapshot Manifest 中的文件；以显式文件路径分批调用，不自行递归整个仓库；归一化路径、行号和输出；与 Node 实现通过一致性测试；不改变 Coverage 和 searched-not-found 的语义。

若一致性无法保证，则保留 Node 搜索，不接入 ripgrep。

## 六、SQLite 边界

JSON / JSONL 是唯一持久事实来源。

SQLite 只能保存：Session 查询索引；搜索倒排；Finding 派生视图；临时排序与过滤数据；可重建缓存。

必须满足：

```text
删除 SQLite → 使用 JSON / JSONL + 源码 → 可以完整重建
```

因此：不做业务数据迁移；数据库版本不匹配时直接删除重建；数据损坏时直接删除重建；写冲突最坏只能丢失缓存，不能丢失调查工件；仅允许单写者，其他进程只读或等待；临时数据库原子替换正式数据库。

版本策略：写入型 SQLite 功能只在明确测试过的 Node LTS 版本启用；CI 固定 Node 大版本和测试矩阵；Node 版本或 SQLite 派生 Schema 变化时重建数据库；SQLite Schema 不属于公共兼容合同。

若 Phase 1B 的规模不需要持久索引，可以继续只用 JSON / JSONL，不必提前引入可写 SQLite。

## 七、宿主和模型 Adapter

评测体系包含三层。

### Deterministic Harness

不使用模型，负责：调用 CLI；构建测试仓库；校验 JSON Schema；读取公共工件；计算 Gold Set 指标；验证缓存、Snapshot 和 Audit。Harness 必须能在完全不接入任何模型的情况下独立完成确定性测试。

### Claude Host Adapter

用于当前真实宿主环境，负责：驱动多轮工具调查；生成 agent-interpreted Findings；记录模型配置和执行指标。

### OpenAI-compatible Model Adapter

实现一个受限兼容子集：Chat Completions 或 Responses；Tool calling；Structured JSON output；Streaming；明确的能力检测。

配置：`baseURL / model / API key environment variable / API mode / supported capabilities`。可用于兼容所需子集的远程或本地端点（含 OpenRouter、Ollama、vLLM），但不能假设所有 OpenAI-compatible 服务行为完全一致。

### 两类实验设计（不得混用）

- **宿主臂对比**：真实宿主环境 ± Excavator。回答"产品增益"问题——战略复审使用的数字。
- **模型臂对比**：Harness 提供同一套确定性工具实现（read / search 等），仅更换模型。回答"模型中立"问题。所有 Model Adapter 必须共享同一套工具实现，否则模型差异与工具环境差异混淆，结论不可用。

每次运行必须记录模型指纹：Adapter 类型；Provider 标签；Base URL 的非敏感标识；Model ID；API 模式；温度、top-p、seed 等参数；Tool calling 设置；Structured output 设置；Adapter 版本；服务端版本（如可靠获取）。API Key 不进入工件。

## 八、宿主集成与 Agent 形态

### 指令层中立化（M1 内，Phase 1C）

"怎么驱动 Excavator"的说明书是宿主锁定的真正风险源，必须在第一个交互消费者出现时就中立化：

- 建立一份中立 driver 指令源（英文，仅引用 CLI 命令与文件工件）；
- Claude Skill（`skills/excavator/SKILL.md`）降格为薄包装，引用中立指令源；
- 增加 AGENTS.md 薄包装（Cursor / opencode / Codex 等工具的事实标准）；
- 所有宿主打包由同一份中立指令源生成，避免不同宿主形成不同调查方法。

驱动 Excavator 的最低宿主要求只有两条：能执行 shell 命令、能读文件。Cursor、opencode、Codex CLI 等当前均满足。

### MCP Server（M1 完成后）

MCP 是可选集成面，不进入 Core（官方 TypeScript SDK 依赖 Zod peer dependency，会破坏 Core 零依赖）。

```text
packages/
├── excavator-core
├── excavator-html
└── excavator-mcp
```

`excavator-mcp`：使用官方 MCP SDK；通过 stdio 暴露本地工具；只包装稳定 CLI 和 JSON 合同；可以拥有自己的 npm 依赖；不改变 Core 的零运行时依赖约束。

进入时机：M1 垂直闭环完成；CLI 工具边界已经稳定；至少存在一个非当前宿主的真实使用需求。

### 独立 Agent 形态（未来阶梯项）

"用户直接提供 API key（如 OpenRouter），Excavator 自带调查循环、无需宿主"是一次产品形态决策，不是改造。其胚胎已存在于计划中：Harness 的 OpenAI-compatible Model Adapter + 最小工具循环。真实需求出现后，将该循环晋升为 `packages/excavator-agent`，走与 MCP 相同的准入阶梯。在此之前不建设。

### M1 内的防锁定保险

- M1 验收含**非 Claude 宿主冒烟测试**：至少一次 explain/relate 端到端调查由非 Claude 环境驱动完成（Harness 最小循环或真实第二宿主）；
- 内部验证场景的实际使用者中至少一名使用非 Claude 宿主（Cursor / opencode 等）。

## 九、Semgrep 边界

接入前必须分别检查：引擎许可证；使用的规则许可证；所需能力是否存在于 Community Edition；是否允许目标分发和商业使用方式；输出格式是否稳定满足 Provider 合同。

不将以下能力默认视为 Semgrep CE 可提供：跨文件数据流；跨函数完整调用分析；商业规则集能力；商业平台专属分析。

优先使用自有规则，避免默认依赖许可证边界不同的远程规则库。Semgrep 只在明确的规则或安全调查场景下进入，不作为基础 Target Resolution Provider。

## 十、Difftastic 边界

官方将 difftastic 输出定位为供人阅读，因此一律不作为机器分析的数据源。

只用于：人类查看结构化差异；降低格式变更噪声；辅助诊断 Provider 结果。

不得用于：生成 Changed Entity 的唯一来源；Comparison Finding 的事实来源；自动迁移或 Patch；Machine Audit 输入。

分析层事实仍来自：

```text
Git Diff + before / after Snapshot + 两侧 Provider 数据 + Source Evidence
```

## 十一、首个里程碑使用的工具

首个垂直薄片只包含：

```text
JSON Schema
Ajv 构建工具
生成的自包含 validators
node:test
宿主无关 Eval Harness
Git
现有 Node Source Search
现有 CodeGraph
JSON / JSONL
中立 driver 指令源（Phase 1C）
```

按需加入：Claude Host Adapter（真实宿主评测）；OpenAI-compatible Adapter（第二模型环境、本地模型评测、非 Claude 冒烟测试）。

暂不进入产品路径（可先在 Benchmark 试运行）：ripgrep；SCIP；ast-grep **CLI**（库形态 `@ast-grep/napi` 已于 57B-395 进入 Core，见 §四）；可写 SQLite；MCP；Semgrep；Joern；difftastic；gh。

## 十二、最终选择

立即确定：唯一公共合同 JSON Schema 2020-12；构建期校验器 Ajv；运行时校验器为生成并 bundle 的自包含 ESM；规范源码搜索为现有 Node Source Search；默认结构化 Provider 为 CodeGraph；公共事实工件为 JSON / JSONL；评测核心为 `node:test` + 宿主无关 Harness；**Core 运行时依赖限审计过的白名单（见 §一，2026-08-13 起替代原"零依赖绝对"），仍零模型调用**。

候选工具进入产品的条件：Benchmark 中产生明确收益；有实际消费者；能力和许可证符合要求；不破坏公共合同；有降级和卸载路径。

最终原则：

**候选工具可以自由进入评测，但必须通过数据和真实消费者，才能进入 Excavator 产品路径。工具阶梯双向可逆，包括 CodeGraph 在内。**
