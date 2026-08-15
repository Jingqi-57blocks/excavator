# 参考：Google Code Wiki 与同类"仓库自动 wiki"系统

**日期**：2026-08-15　**性质**：外部系统调研，非 Excavator 自身设计文档
**结论一句话**：他们做的是**常青文档**（把仓库变成永不过期的 wiki），我们做的是**可辩护调查**（每句话可追溯、没读到的部分被显式记账）。同赛道、不同产品；他们已验证的工程手法值得抄，他们公开翻车的地方正好是我们押注的护城河。

---

## 一、Code Wiki 是什么（事实层）

| 项 | 内容 | 来源级别 |
|---|---|---|
| 发布 | Google 2025-11-13 公开预览，`codewiki.google` | 官方博客 |
| 定位 | "reading existing code is one of the biggest, most expensive bottlenecks in software development" | 官方博客原文 |
| 三条产品原则 | ① 扫描全库、**每次变更后重新生成**；② 整个"始终最新的 wiki"作为 chat 的知识库；③ 文档段落**深链**到具体文件/类/函数 | 官方博客 |
| 产物 | 可导航 wiki 页面、架构图/类图/时序图（随代码更新）、Gemini chat | 官方博客 |
| 交互细节 | 文中每个类/变量/API 名是活链接，悬停出定义 tooltip，点击跳到当前分支的文件 | 二手评测一致复述 |
| 范围 | 公开 GitHub 仓库；私有库走 **Gemini CLI 扩展**（本地/内网跑，候补名单，未 GA） | 官方 + 报道 |
| 免责 | 页面上写着 "Gemini can make mistakes, so double-check it" | The Register |
| 血统 | 是 **Mutable.ai 的 Auto Wiki 的重建**（Google 收购 Mutable.ai 后） | The Register 报道 |

Google **没有公开架构细节**。要看实现，只能看两处：前身 Auto Wiki 的一手表述，和学术界同类系统的开源复现。

---

## 二、实现方式：公开可考的部分

### 2.1 前身 Auto Wiki（一手，创始人 HN 原话）

- 生成机制：*"It's purely based on the code and we force the LLM to cite the code it describes to cut back on hallucination."* —— **强制引用**是它唯一的抗幻觉手段。
- v2 增加 **chain-of-verification**（自验证步骤）+ 微调；Mermaid 图；筛选/搜索；AI 指令改写 + 人工编辑。
- 更新：每月 + 每次 commit（PR bot）。定价 $2/repo/月。
- 引用粒度：点击到**被讨论的那几行代码**。

### 2.2 学术同类系统 CodeWiki（**MIT 开源，可直接读代码**）

arXiv 2510.24428（FPT Software AI Center + University of Melbourne，v6 2026-04-04），仓库 `FSoft-AI4Code/CodeWiki`。这是目前**唯一完整公开的同类实现**，三阶段：

1. **仓库分析与分层模块分解**
   - Tree-Sitter 解析 AST，抽函数/方法/类/结构体/模块及其相互依赖（调用、继承、属性访问、导入），**归一成统一的 `depends_on` 关系**，建有向图 G=(V,E)——跨语言泛化靠这层归一。
   - **拓扑排序找零入度组件** = 用户交互的入口点（main、API 端点、CLI、公共接口）。
   - 按组件间依赖 + 语义内聚递归分区，得到**面向功能的模块树**；为了可扩展，只把组件 ID 喂给模型。
2. **递归 agent 生成**
   - 每个叶模块配一个 agent，给它：完整源码访问 + 全模块树（跨模块理解）+ 文档工作区工具（查看/创建/编辑）+ 依赖图遍历能力。
   - **动态委派**：模块复杂度超过单次处理能力时，agent 把子模块委派给子 agent。触发准则是明确的：**圈复杂度、嵌套深度、语义多样性、上下文窗口占用率**。自底向上递归。
   - **跨模块引用注册表**：遇到外部组件时建交叉引用而不是复制内容，全局注册表记录"哪个组件已被记录在哪"。
3. **分层装配**：父模块由子模块文档 + 模块树 + 依赖信息经 LLM 综合，产出架构综述、功能摘要、使用指南、架构图/数据流图。

输出：`overview.md` + 各模块 md + `module_tree.json` + `metadata.json` + `index.html`；`--update` 增量更新；支持 9 种语言（论文评测 7 种）；可挂 OpenAI/Anthropic/Bedrock/Azure，也支持 Claude Code CLI 订阅模式。

> 注意：二手博客普遍宣称 Google Code Wiki 用 "tree-sitter 建知识图谱 + agentic RAG"，**这是推测**，Google 未证实。但学术复现证明这条路线确实可行且是当前主流做法。

---

## 三、效果的可信数字（CodeWikiBench）

评测方法本身比分数更值得抄：

- **rubric 来自项目自己的官方文档**：把官方文档层级解析成 JSON，由 rubric 生成 agent 产出带权重的分层要求树；多模型家族各生成一遍再综合，降低单模型偏置。
- **judge 只判叶级要求**，二元"是否充分覆盖"+ 简短理由，禁止评抽象概念（例：判"DeepDoc Visual Parser for complex layouts"，不判"Document Processing Engine"）。
- 多个不同模型家族的 judge 各评一次取均值，**标准差沿层级传播**，最终分带置信区间。

结果（7 个真实仓库，86K–1.45M LOC）：

| 系统 | 平均分 | 脚本语言 | 托管语言 | 系统语言 |
|---|---|---|---|---|
| OpenDeepWiki（开源） | 47.13 | – | – | – |
| deepwiki-open（开源） | 50.05 | – | – | – |
| **DeepWiki（Cognition，闭源基线）** | 64.06 ±3.60 | 68.67 | 64.80 | **56.39** |
| **CodeWiki（论文）** | **68.79 ±3.84** | **79.14** | 68.84 | 53.24 |

**三个必须记住的数字**：

1. **系统语言（C/C++）两家都崩**：53–56 分，论文自认"需要专门的解析模块"（指针、手工内存、模板元编程——"对系统语言来说这些构造本身就是架构"）。CodeWiki 在 wazuh(C) 上反而比 DeepWiki **低 4.51**，electron(C++) 低 1.80。
2. **覆盖率（满足的叶级要求数/总要求数）远没到"完整"**：最好 puppeteer 74/82、OpenHands 59/67；最差 **electron 48/92、logstash 38/57**。即业界最好的系统，也有 **10%–50% 的官方文档要点没被覆盖**——而且用户看不到漏了哪些。
3. **评测本身也不硬**：rubric 自身一致性只有 73.65%（语义）/70.84%（结构），人评只有 3 人 × 3 仓库共 9 次判断（7 次偏好 CodeWiki）。

### 真实翻车（都发生在"有引用"的前提下）

- **DeepWiki**：LibreOffice 被写成"主要构建系统是 Buck"（完全错误），多个开源维护者公开抗议。
- **Auto Wiki**（Code Wiki 前身）：HN 用户 teraflop 逐条指出 CPython wiki 的事实错误——栈式 VM 被写成寄存器式、编造不存在的 trace 功能、编造结构体名。作者回应是"v2 质量更高"。
- **Code Wiki**：The Register 实测中 Gemini 声称 ASP.NET Core 分布式缓存"没有 PostgreSQL 支持"，与微软官方文档矛盾。

---

## 四、对 Excavator 的意义

### 4.1 定位差异（不要跟着走偏）

| | Code Wiki / DeepWiki / CodeWiki | Excavator |
|---|---|---|
| 目标 | 让人**更快读懂**代码 | 让结论**可被辩护** |
| 优化对象 | 覆盖面 + 新鲜度 | 每句话可追溯 + 漏报可见 |
| 抗错手段 | 强制引用（+ chain-of-verification） | 引用 + **逐句 claim 绑定 + 审计硬失败 + 阅读问责** |
| 产物 | 随 commit 重生成的活 wiki | 冻结不可变的 run + 跨 run diff |
| 说不知道 | 不会（会自信编造） | `cannot-determine` / `searched-not-found` 是一等结果 |

### 4.2 他们已验证、我们该抄的

1. **依赖图 → 拓扑排序找入口 → 递归分层模块树**：这是"大仓怎么不炸上下文"的成熟答案。我们现在的调查计划是章节/功能驱动，没有从 CodeGraph 依赖图自动生成的模块树。这条直接对上我们"codegraph → 调查计划"的方向。
2. **动态委派的触发准则**（圈复杂度 / 嵌套深度 / 语义多样性 / 上下文占用率）：57B-386 并行撰写正缺"按什么拆"的客观依据，别拍脑袋分节，用这四个信号。
3. **跨模块引用注册表**（交叉引用不复制内容）：我们多文档已共享 evidence，但报告之间没有"这个组件已在 X 文档记录过"的注册表，重复描述是实际存在的浪费。
4. **rubric 覆盖率评测法**：拿目标项目**自己的官方文档**当分母，判定只在叶级、多模型 judge、方差传播。这比我们现在的单跑 gold 召回稳得多（单跑方差已知：44/58/38），可作为 gold 的补充度量。
5. **live link / 悬停定义**：我们 HTML 现在是折叠证据块，可升级为标识符悬停出定义。
6. **增量更新**（`--update`）：我们 freeze + knowledge-v1 已有地基，可对齐"每次 commit 只重算受影响模块"。

### 4.3 我们有、他们没有（继续押）

1. **引用 ≠ 正确**。三家的公开翻车**全部发生在有引用的前提下**——引用只保证"这段代码存在"，不保证"这句话是这段代码说的"。我们的 claim 逐句绑定 + 审计硬失败正是补这个洞，而 57B-391 的阅读问责（read-obligations 分母、未打开窗口、消费漏斗）补的是更前面那一段：**引用不了的东西，他们连"漏了"都不知道**。
2. **漏报可见性**。CodeWikiBench 只能事后拿官方文档当分母测覆盖率——**没有官方文档的项目就测不了**（而这正是最需要调查的那类项目：遗留系统）。我们把"未打开的窗口 / 未消费的条件"做成运行内产物，不依赖外部文档。这是结构性优势。
3. **遗留 / 框架驱动 / 系统语言**。两家在 C/C++ 上都掉到 53–56 分，论文把"专门的解析模块"列为 future work。我们的 `native-graph`（Perl/Zope/ctags）+ 框架约定包（Catalyst）就是这块，provital 是活证据。这是他们公开承认打不动、而我们已有产出的地带。
4. **零模型 Core + 字节确定性 + 本地可跑**：他们的私有库方案还在候补名单。

### 4.4 他们的教训，反向确认我们的选择

- HN 评论："今天读到一半，明天全变了，这是巨大的浪费。" —— **"每次 commit 重生成"损害可引用性**。我们的 run 不可变 + freeze + 跨 run compare 是对的，不要为了"常青"放弃可引用。
- Auto Wiki 加了 chain-of-verification 仍然错。**自验证（模型自己检查自己）不是护栏**，形式闸门（审计硬失败）才是。这条和我们已有的 Goodhart 迁移观察一致。

### 4.5 候选动作（待裁定，不在当前切片）

| # | 动作 | 价值 | 依赖 |
|---|---|---|---|
| A | rubric 覆盖率评测：拿目标官方文档当分母量我们的漏报 | 高——给"漏报归因"一个外部锚点，比单跑召回稳 | 需要有官方文档的目标（WCP/svelte 类） |
| B | CodeGraph 依赖图 → 拓扑入口 → 模块树 → 调查计划 | 高——直击"调查深度方差"这条线 | 57B-391 Phase 1 检索 |
| C | 并行撰写的拆分准则用委派四信号 | 中——57B-386 缺的正是这个 | 57B-360 token 记账 |
| D | HTML 标识符悬停定义 + 跨文档引用注册表 | 中——阅读体验，非正确性 | 无 |

---

## 参考

- [Introducing Code Wiki（Google Developers Blog）](https://developers.googleblog.com/introducing-code-wiki-accelerating-your-code-understanding/)
- [Google previews Code Wiki: Can you trust AI to document your repository?（The Register，含 Mutable.ai 血统与批评）](https://www.theregister.com/2025/11/17/google_previews_code_wiki/)
- [Show HN: Auto Wiki（含作者对实现的一手说明与 CPython 错误清单）](https://news.ycombinator.com/item?id=38915999)
- [CodeWiki: Evaluating AI's Ability to Generate Holistic Documentation for Large-Scale Codebases（arXiv 2510.24428）](https://arxiv.org/pdf/2510.24428)
- [FSoft-AI4Code/CodeWiki（MIT 开源实现）](https://github.com/FSoft-AI4Code/CodeWiki)
- [DeepWiki 准确性争议（BigGo）](https://biggo.com/news/202508270142_DeepWiki_Accuracy_Concerns)
- [Google Code Wiki 上手观察（Analytics Vidhya）](https://www.analyticsvidhya.com/blog/2025/12/google-code-wiki/)
