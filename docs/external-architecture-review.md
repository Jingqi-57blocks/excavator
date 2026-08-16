# 外部项目架构调研（2026-08-16）

用户裁定：**只参考架构与实现方式，不引入任何这些项目。** 本文只收「可用确定性手段（零模型调用）复刻的机制」，
并按证据层级分栏。调研覆盖约 40 个对象，分五簇：文档/wiki 生成、代码索引、agent 范围选取、覆盖率与溯源、
多仓与遗留系统理解。

## 零、方法论：为什么本轮坚持读源码

**「文档说的和代码干的不一样」在本轮出现了至少七次，没有一条能靠读 README 或论文发现。**

- CodeWiki（ACL 2026）论文说入口点用 zero-in-degree 拓扑排序，实际那只是候选超 400 时的泄压阀；论文写的委派判据是圈复杂度，代码里是 `len(files) > 1`；两个论文点名的函数是死代码。
- RepoDoc 论文说知识图谱 7 种边、增量做双向传递闭包；代码只有 4 种边、只做下游，且 `implements` 不传播。
- deepwiki-open 的提示词写「你能看到这些文件的完整内容」，实际是 FAISS `top_k=20` 的 350 词分块。
- Google Code Wiki 宣称每节都超链到相关代码；实测 gemini-cli 页里 test/lint/preflight 三个词全指向 `Makefile#L3`，而第 3 行是 `.PHONY:`。
- Graphify README 称 "local deterministic AST parsing"，但 Pass 3 用模型抽 docs；`check-update` 全文只是检查一个标记文件是否存在然后永远 `return True`。

**结论作为纪律固化：外部机制未落到源码文件或规范条文的，一律标「未证实」，不得作为决策依据。**
这条已经付过学费——上一轮某份分析列的四条「值得借鉴」里，三条在官方命令表中根本不存在。

## 一、本轮最重要的发现：不是外面有什么，而是我们的闭环缺一段

**已在我们代码里逐行验证（我自己核的，非 agent 转述）：**

| 事实 | 位置 |
| -- | -- |
| 种子只来自一次**全局** top-120 竞争 | `src/context/context.ts:324` |
| 各模块各查一遍后合并、按 kind→路径字典序排序、**全局截断** | `src/codegraph/codegraph-set.ts:100-103` |
| **零种子的模块完全不扩展**，`if (!seeds?.length) continue` | `src/codegraph/codegraph-set.ts:131-133` |
| `actionSeeds` 只在 primary seeds 的文件里搜，二次锁死 | `src/context/context.ts:326` |
| `roundRobin()` 已存在且 `routeSummary` 在用，`searchNodes` **没用** | `src/codegraph/codegraph-set.ts:96, 224` |
| 恢复出的路由只进**分母**（freeze 路径） | `src/core/run.ts:166` |
| `src/framework/` 的约定恢复产物**完全不进 `context.ts`** | grep 无命中 |

**核心诊断：我们已经能算出「本应读什么」（读义务分母、框架约定恢复、跨仓链接），但这份知识从不回流到「实际读什么」（候选池种子）。**
分母与种子是两条不相交的管线。于是「整个 wcp-ui 缺席」这类失败，分母侧无话可说（函数级义务对整仓缺席无表达力），
种子侧又没有任何兜底把它拉回来。

**实测确认的机制**（我跑的模拟，5 个真实 CodeGraph 库 + leave 锚点词）：
```
各模块命中（全局截断前）:  wcp-service 117 | wcp-service-v2 120 | wcp-ui 120 | review 1
全局 slice(0,120) 之后:    wcp-service  64 | wcp-service-v2  35 | wcp-ui 21
被清零的模块:              wcp-auth、wcp_review_service
```
**「全局截断会把整个模块清零」已证实**（两个模块各得 0 席）。
**「它是 wcp-ui 缺席的原因」未证实**——我的模拟里 wcp-ui 拿到 21 席；且 2026-08-13 的前端候选池 fixture 里
wcp-ui 有 542 节点、剪枝后留 67。10/16 那个读数来自 2026-08-11 的 run，两次之间差的可能是模块集合或锚点词。
**要坐实需重跑一次真实 run 并记录每模块入池计数。**

## 二、外部参照系（第一次有了外部数字）

我们的边界召回读数此前没有外部坐标。现在有了：

| 方法族 | 数据集 | 召回 | 与我们的尺可比性 |
| -- | -- | -- | -- |
| 纯 IR（VSM/LSI/LDA，8 种实现） | 12 系统（Rhino/jEdit/ArgoUML/Eclipse…），method 级 | **Recall@K 0.19–0.28** | 最接近可比 |
| 微服务架构恢复**端点枚举**（RAD/Code2DFD 等） | 17 开源系统、160 endpoints | **recall 0.54–0.68** | 任务形状最接近 |
| 微服务**组件识别** | 同上、144 components | F1 0.71–0.98 | 说明「认出节点」远易于「认出边」 |
| 确定性 COBOL 业务规则抽取（A-COBREX） | 27 程序带 ground truth | recall 74.12% / precision 62.21% | 唯一确定性规则抽取的公开数字 |
| 我们（真实 run / 候选池含前端仓） | 自建 31 项 / 16 mustFind | **0.625 / 1.00** | — |

**诚实表述**：我们在 IR baseline 之上，与外部端点级恢复工具同档。**不能宣称领先**——外部是数百 feature 跨 12–17 系统，
我们是单 feature 自建 gold，样本量差两个数量级且有 selection bias。

**一个必须记住的方差数据**（SITIR, ASE 2007 Table 4）：同一 feature 由 4 个开发者各写一条查询，
LSI 排名 = 26 / 1 / **3242** / 20。**查询措辞方差跨三个数量级**——这是「锚点词由人或模型给定」这一路的根本不稳定性，
与我们「同输入同输出」的硬约束直接冲突。

## 三、行业空白：我们的分母没有对手

**约 40 个对象里，没有一个记录「预算耗尽时我漏了什么」——没有覆盖率、没有未探清单、没有残差。**

最接近的四条都只是局部：SWE-agent 的行级 `(N more lines above/below)`；repomix 的排除文件清单 + `--token-count-tree`；
Agentless 落盘的「无关文件夹」清单；CodeWiki 的 `_validate_module_tree` 三集合差。
Sourcegraph 官方直接承认「缺少相关上下文的 ground truth」因此无法测 recall。
DeepWiki 官方文档把举证责任写给用户：「**If you know** certain parts are being missed…」，
troubleshooting 有一节标题就叫 "Only certain folders are being documented"，官方回答 "This is the classic large repository problem."

**且行业最好的那条残差账本，其诚实边界恰好排除了我们的缺口**：CodeWiki 自己写
"Non-candidate components are **intentionally not reported** as leftover"——**从没进候选池的东西按设计不出现在残差里**。

**所以 `read-obligations.ts` 那套东西在这批 SOTA 里没有对手；缺的只是粗粒度（仓/模块级）那一层。这是差异化，不是追赶。**

## 四、值得复刻的机制（按能治哪个缺口排序）

### 第 1 名 · 节点先于边 + 全员兜底（治「整模块清零」）

**外部证据（源码级）**：Nx 有两层构造性保证——
`packages/nx/src/project-graph/build-project-graph.ts` 的 `normalizeProjectNodes` **在处理依赖之前**把所有
project 无条件建成节点（与有无边无关）；`affected/locators/workspace-projects.ts` 命中全局输入时
`return Object.keys(projectGraphNodes)` **直接返回全部 project**。

**反面证据加固**：Turborepo 的 `globalDependencies` 只进 task hash、不进包选择集（**抄它等于抄我们现在的 bug**）；
Bazel 的 `//...` 只在「已声明的 package」内完备；EMSE 2025 横评明确「没有任何工具保证发现全部服务」。

**落法**（零模型、零新依赖、字节确定）：
1. `codegraph-set.ts:100-103` 的全局 `slice(0, limit)` 改为**每模块保底 k 席 + 剩余名额全局竞争**——`roundRobin()` 就在同文件 224 行，`routeSummary` 已在用，直接复用。
2. **闭环**：把已有的读义务 / 框架约定恢复 / 跨仓链接产物**回流作结构兜底种子**，使 `:133` 的 `continue` 不再触发。这是本轮最大的架构发现——我们已经算出「本应读什么」，只是没喂回去。
3. 反调绊线：断言「每个已索引模块在候选池 ≥1 席」，违反即残差上报。

**别一起抄的**：Nx 自己在 `getTouchedProjects` 里把未匹配任何 project 的文件静默丢弃——正是我们「不许有第四态」要禁的东西。

### 第 2 名 · 模块级预算占比表 + 具名排除清单（治缺口可见性）

**正面**：repomix 的 `--token-count-tree`（带 token 数的文件树）+ 逐条列出被排除文件；deepwiki-rs 的 `total_lines`/`read_lines` 双计数（成本近乎为零）。

**反面（四个同构案例，都因此对前端全盲）**：moatless `required_exts=[".py"]`；Agentless 的 `filter_none_python`；
LocAgent 对无 `.py` 目录 `graph.remove_node` **物理删除**；gitingest 命中 `MAX_FILES` 只 `logger.warning`、
产物零痕迹，且 `if not children: continue` 让被规则清空的目录**连树里都不出现**（整个子系统静默蒸发）。

**最危险的一处放大**（deepwiki-open）：决定「wiki 有哪些页」的规划视图与索引视图共用同一个 `iterate_files`，
但**共用点在过滤之后**——规划模型从头到尾不知道被排除的目录存在。一次配置过度排除被固化成整份文档的结构性盲区。
**正确形态：两个视图同源于过滤之前，排除结果作为显式清单一并进规划上下文与最终产物。**

**落法**：把 `context.ts:398` 的 `scopeNodesCapped: boolean` 升级成一张表——
`模块 → (候选池节点数, 保留节点数, 预算占比, 排除原因)`，进 freeze 产物与审计。**某模块 0 就是可见告警。**

### 第 3 名 · 约定即种子、失败退化为超集（治框架驱动系统）

**外部证据（源码级）**：Brakeman `rails3_route_processor.rb` 的 `loose_action` —— 路由里出现通配就把该 controller
标 `:allow_all_actions`，**保守过近似而非丢弃**，且官方文档写明「解析 routes 出错时自动启用」——**失败退化为最大集合，不是空集**。
CodeQL `ActionController.qll` 的 `ActionControllerActionMethod` 构造条件只有 `not this.isPrivate()`，
`getARoute()` 只是**可选富化**（"if one exists"）——**路由文件只用于加标签，绝不用于筛选**。
PyT 的 `FrameworkAdaptor` 不硬编码框架，接一个谓词遍历全部函数，并显式提供 `Every` 档（每个函数都当入口）。

**为什么在我们场景成立**：我们已有 `src/framework/`（Catalyst）与 express 内联闭包恢复，
但它们的产物只进分母、不进种子。把「是否入口」与「能否解析出路由表」解耦，正是第 1 名第 2 条的具体实现路径。

**别一起抄的**：Brakeman 对循环内注册、插值 controller 名、元编程注册是**静默忽略**（它自己的第四态）。
我们必须落进第三个可见桶。

### 荣誉提名（够格但工程量大，建议排在后面）

- **快照反查重锚**（deepwiki-open `codemap.py::_locate_snippet`）：原注释 "LLM-provided line numbers are unreliable, but the snippet is copied verbatim, so the true location is recovered by searching the real file."——让模型交 verbatim 片段，用 `find()` 命中位置**覆写**模型报的行号。纯字符串搜索、零模型、可做审计硬门。**但我们的窗口机制已由 audit 逐字重推导覆盖了同一性质**，收益主要在未来若引入模型报位置的路径。
- **标识符普遍度降权**（Aider `repomap.py:498`：`if len(defines[ident]) > 5: mul *= 0.1`）：惩罚**标识符**（一个名字在 >5 个文件里被定义 = 通用名），**不是节点**。这正是对我们已实测失败的 p99 度数排 hub（15/16，丢掉的是 hub 形态的导出处理器）的正面替代——降权对象换了一层。
- **Wittern 式 URL 三段匹配**（ICSE 2017，端点精度 96%，FP 中仅 0.08% 源于分析不足，16% 的 URL 本就不可静态求值且**明确不报警**）：**我们已有等价物**——`frontend-calls.ts:57` 的 `unresolvedReason` 五值闭集。外部数字的价值是给了可辩护的期望值上限。
- **Nx 之外的跨仓身份统一（SCIP 的 package+version）**：**对我们不适用**——5 个仓之间没有包依赖关系，算不出共享的 (package, version)。

## 五、明确不做（负面读数，避免重复调研）

| 对象 | 依据 |
| -- | -- |
| Leiden/Louvain 社区检测当分母 | 算法本身随机（Traag 2019 设计目的）；确定性挂在**三个外部前提**上（排序输入 + 固定 seed + 固定第三方 Rust 库版本），任一漂移静默改变分母。Graphify 自己的注释承认 partitioner 枚举顺序 "not seed-stable"，且它**没测**成员划分的可复现性 |
| Graphify `--exclude-hubs` | 已实测拒绝：15/16 劣于基线，丢掉 `T2-leave-export`——feature 的中心处理器本身就是 hub |
| 全局 PageRank 排序 | 已实测：**0/16**；加种子也只有 9/16。它答「谁重要」，我们要「谁属于这个 feature」 |
| 纯 IR（LSI/LDA/VSM）当主力 | method 级 Recall@K 0.19–0.28；且同一 feature 换查询措辞排名从 1 跳到 3242 |
| 动态执行轨迹（SITIR/PROMESIR） | 确有效（候选集缩 5×），但需跑起来 + 人工设计场景，违反「读真实仓、零执行」 |
| Turborepo 式 filter 当边界机制 | `globalDependencies` 只影响 hash 不影响选择集，构造上不可能给全员保证 |
| 按扩展名做入池白名单 | moatless / Agentless / LocAgent 三家都因此对前端全盲。**入池白名单本身要当审计对象** |
| SWE-agent 的「>100 命中即整体拒答」 | 主动制造缺口。要抄只能抄成「截断 + 记残差」 |
| repomix 的 churn **升序** | 那是为 LLM 位置偏置设计的；用作入池优先级要**降序**，且须记录 git 不可用时的回退（repomix 此处静默返回 null） |
| 单一来源恢复跨仓边 | 纯字节码 RAD / 纯 POM ContextMap / MicroGraal 的 connections F1 **0.00–0.04**。跨仓边必须多来源交叉 |
| Prophet 式「文件夹结构 + 命名约定」推服务 | connections F1 0.02、components F1 0.23 |
| AutoWiki / mutable.ai | 站点已死，从未有公开实现；核心卖点只存在于一条推文。**只能作「名词先于机制」的反例** |
| Sourcebot | 不自建索引（vendor 了 Zoekt fork），四个缺口一个都不治 |
| ADDI 业务术语分类器 / EvolveWare / Blu Age | 机制不公开或依赖 ML 分类器 + 人工映射，不可零模型复刻 |
| 「增量==全量」的现成保证 | 约 10 个索引系统里**只有 salsa 正式写下来过**（代价正是「所有查询必须是纯确定函数」——我们已付过这个价）。Kythe/Glean/Zoekt/SCIP 全是「官方未表态」，Stack Graphs 是 conjecture，Glean 甚至记录了已知反例。**我们要这个性质就得自己测** |

## 六、顺带查到的我们自己的两处待议

1. **`sourceManifestDigest` 不含内容 hash**（`src/snapshot/snapshot.ts:283`）：用的是 `(relativePath, size, trunc(mtimeMs))`。
   同长度、同毫秒 tick 内的编辑静默同摘要。**严重性有限**——有证据依赖的窗口由 audit 逐字重推导兜住；
   裸露面是「没有任何窗口的文件」，影响分母计数。参考 Graphify `cache.py` 的 racily-clean 守卫
   （必须 `mtime_ns + granularity <= indexed_at` 才信任 stat）：补内容 hash 或补 mtime 粒度守卫，二选一。
2. **CodeGraph 的 `unresolved_refs` 只有一个桶**：实测 22449 条**全部** `status='failed'`、`candidates` **全空**。
   列的形状在、信息量为零。且内容以 Go 标准库/第三方调用为主（`encoding/json`、`strings.Replace`），
   含路径/api/http 形态的只有 176 条——**「用 unresolved 做跨仓 join 反向拉池」这个建议我们的数据不支持**。
   这张表由外部工具产出，我们只能消费。
