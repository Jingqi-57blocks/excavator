# Excavator 分层契约（code → knowledge）

本文是「仓库 → 可辩护知识」这一段的**接口契约**：每层一个确定的输入、一个确定的输出产物、一个确定的失败输出、一列被禁止的输入。它不设计任何层的内部机制——内部可以被独立建成、测量、替换，只要接口不破。范围止于 knowledge；knowledge → 报告不在本文内。跨界依赖恰好一条：撰写层只能陈述能绑定到可引用单元的事实，所以本文必须产出可引用单元。

**层之前有一份绑定契约（`BoundRunContract`），不占层。** 它由三份外部不可变输入物化而成，在任何生产者被调用之前就位，此后全 run 只读：

| 输入 | 谁给 | 内容 |
|---|---|---|
| `run-intent.json` | 操作者 | target、feature subject + 排序后 aliases（**查询别名**）、预算、可选的 `FeatureProfile`（入口假设：method + path pattern，每条带 `origin: user / host-model / deterministic`）。**假设不是事实**：它只能匹配某个第 3 层生产者已独立观察到的东西才换来候选，自己绝不铸造成员资格、事实或席位；且它是 feature 词汇，故只能被第 4 层侧消费，生产者保持 feature-blind |
| `requirements.json` | 报告侧（模板 / audience 在边界处翻译成需求行） | 本 run 必须回答的知识需求；每个请求文档的每个 `##` 模板章节恰好一行，另有无条件 run 级行；**知识需求的唯一通道** |
| `contract-manifest.json` | **基座注册表 + 契约版本推导** | 本 run 预期哪些层产物与第 3 层生产者信封（必需 / 可选）、schema id、validator 版本、各检查族与版本 |

`contract-manifest` 的期望产物集与生产者集**必须从基座注册表推导，绝不能从「实际跑出了哪些结果」反推**——反推等于让结果定义期望，冻结的信封检查就成了同义反复。八层的产物槽位与第 3 层的逐生产者信封都在 run 开始前登记；缺少任一必需槽位都可被第 8 层判断，而不是只验第 3 层。**登记到实例基数，不止产物族**——槽位存在不等于每个实例齐全：固定实例（run 级、逐 feature key、逐 producer key）逐个登记，append 族登记 stream 身份 + 冻结截止 + 尾摘要，epoch 登记当前序号与其闭合集合。期望实例集 = 注册表 × 契约输入（feature key 来自 `run-intent.json`），仍是前推，不违反上一句。否则两 feature 的 run 里 B 的工作集文件消失、槽位仍被 A 满足，P6 在实例层重演。编排只负责在调用任何生产者之前把这三份物化，自己没有业务产物；第 8 层因此消费的是**层之前的不可变契约**，不是更高层的产物。

先前的所有裁定原样承接，不再重开：**准入已废除**（零分是一行带理由的记录，不是缺席）；第一轮评审七条裁决（关系标注、判断以被记录输入进入、两条守恒律、依赖方向律、completeness 无消费者不建）与第二、三轮评审各自的裁决全部生效。

**本文的 `path:line` 锚点由绊线守着，不靠手工核。** `tests/layering-anchors.test.ts` 抽出本文全部锚点（含 `` `run.ts:1542`、`:1470` `` 这类续写形，先规范化为全限定再分类——只抓全限定形的正则实测漏抓过续写），对照一份内置的**总分类清单**：每个锚点要么 `current`（该文件的该行区间必须含指定片段，**行号精确、无容差**），要么 `current-file`（只给路径、没有行区间：文件必须存在），要么 `historical`（记录「修之前」的位置，不查代码，且必须写下不追的理由）。**未分类即红；清单里有而文中找不到也红**（双向，防清单烂尾）。这条绊线不是洁癖：手工核过的锚点活不过一个切片——上一轮 20 个锚点里 6 个在一个切片内腐坏，`run.ts` 的一处偏了 41 行，而文档读起来照样像真的。

**基座与编排不是层。** 共享类型 / 工具 / 注册表 / append-only 日志写入器没有业务产物，位于一切层之下；`run.ts`、`cli.ts` 把各层接线，位于一切层之上。报告侧代码（撰写、claims、审计的报告半边）位于层 8 与编排之间，**在本契约范围外**，但仍受第二节的依赖秩序与层序测试约束。

---

## 一、层表

八层。**接口即产物**：每层恰好一个输出产物族，统一使用基座定义的 `ArtifactResult<T> = Built<T> | NotApplicable{determination, basedOn, coverageDigest} | Unavailable{cause, retryable}`（三态判据见 §四输出法则），唯一写者、穷举消费。「没运行」是一个被写下来的状态，绝不是一个不存在的文件；各层不得另造 `census-unavailable`、`channel-unavailable` 一类与顶层三态竞争的失败方言，它们只能作为 `Built` 内的逐行状态或映射到统一信封。

| 层 | 输入 | 输出（产物） | 失败输出 | 禁止输入 | 产物身份 |
|---|---|---|---|---|---|
| **1 边界** | `BoundRunContract` + target 路径 | `ledger/files.json`：文件台账。**候选集是根发现后未被忽略规则排除的全部文件**，每个候选恰好落一个桶（counted / excluded{rule} / unexplained）——`rule` 含 `unsupported-extension`，且按扩展名分组可见：修之前 `snapshot.ts:213` 的 `if (!isSupportedFileName(name)) continue` 让未注册扩展名根本不进候选表，「忘了加语言」在分母所在的层不可见（**57B-418 已改**：wcp 的 14 份 `.ejs` 邮件模板现在是 `excluded{unsupported-extension}` 里的一行，与 `.png` 分列）；扫描完整度块必填（capReached、skippedByCap、被丢弃的根）；每文件双层身份（tier1 形状 / tier2 内容哈希），形状含行形状信号（压缩 / 二进制判定的输入） | `Unavailable{cause}`（target 不可读、根发现失败）——被写下的记录，不是缺文件 | 任何来自索引、图或下游产物的东西——它先于一切 | 契约摘要 + target 路径 + 扫描器版本；内容身份 = 全表 tier2 摘要 |
| **2 机制** | `files.json` 的行集 + 语言/机制注册表（基座）+ 各机制运行时可用性 | `ledger/mechanisms.json`：每机制先声明 `CoverageDomain` 与 `UnitKind`（文件 / 模块 / 模块对 / corpus / 节点），台账只统一信封、身份与失败语义，**不强行统一粒度**；文件域机制落（文件 × 机制）矩阵，每格 covered / no-mechanism / mechanism-unavailable{cause}，按例外压缩。**`no-mechanism` 只说「这一行已被 L1 counted，但没有机制支持它」**——未注册的扩展名不是本层的事，它在 L1 落 `excluded{unsupported-extension}`；两者不得混成一个概念，否则本层要为一批根本没进台账的文件造幽灵行。降级能力必须注册成**独立机制**（如 `condition-regex-numeric`），不得把它记成原机制成功 | 机制整体不可用（如 ast-grep 绑定缺失）写 mechanism-unavailable 行，**绝不静默退化或冒充原机制**；若独立 fallback 可用，它在自己的机制格记录 covered | 不来自 `files.json` 的文件清单；机制自报的覆盖率比值作行集；**跨 CoverageDomain 合成的任何比值** | `files.json` 身份 + 注册表版本 + 各机制版本 |
| **3 事实与单元** | `files.json` + `mechanisms.json` + 目标源文件；每生产者独立 | 事实库：每生产者一个信封（生产者：codegraph 索引、native-graph、framework pack、db-schema、crossrepo、词汇仓内 df）。每条事实带生产者、粒度、kind（闭合注册表 + 不透明 subkind + unmapped 计数）。**并产出 `units.json` 的两个明确集合**：`refUnits[]` 是可引用结构，允许 class / method / closure 等嵌套，身份 `RefUnitId = (snapshot, files.json 行身份, unit-kind, canonical span)`，不含 producer，重复观察合并到 `observedBy[]`；`partition[]` 是归属分母，身份 `UnitId = (snapshot, files.json 行身份, partition-kind, canonical non-overlapping span)`，每个 counted 文件由非重叠细粒度 cell + residual cell 完整划分。**两种身份都锚在第 1 层台账的行身份（路径可区分 + tier2 内容哈希），绝不只用内容哈希**。每个 ref unit / fact 必须由第 3 层一次性写下**成员资格**（闭合联合，规则来自基座 kind 注册表），下游只按它关联，禁止重新按 path/span 猜测。`partition[]` 由**指定的分区构建器**产出，事实生产者只观察不改分区。粒度按**粒度阶梯**逐文件递降（node span → handler 区间 → 文件），降档必记原因。两种身份都**不含 producer 与语义裁定** | 生产者级信封：pack 判定目标无此形状 → `NotApplicable{not-detected, basedOn, coverageDigest}`；单模块目标 → `NotApplicable{single-module, …}`；工具缺失 / 读取失败 → `Unavailable{cause}`；**缺信封 = 冻结失败（对照 `contract-manifest`）** | **feature 词汇 / 查询词 / feature key**——事实与 feature 无关；模型输出；世界词表；**producer 进 RefUnitId / UnitId**；下游重算 ref unit → partition 的映射 | (snapshot 身份, `mechanisms.json` 摘要, 生产者, 生产者版本 + 配置/模式)——**绝不含 feature key** |
| **4 归属** | 分母 = `units.json.partition` 派生的 RowSet（**每个 RowSet 携带其 UnitKind，守恒按粒度分别成立**）；分数贡献 = 各通道消费事实库（贡献契约：来源通道、理由、锚点、传播路径）；预算；`run-intent.json` 的查询别名 | `attribution.json`：每个 partition `UnitId` 结局 seated / zero-score / budget-displaced，守恒 `counted = seated + zero-score + displaced`（逐 UnitKind）；每次挤出带记录；模块 × 语言分组 | 顶层使用统一 `ArtifactResult`；无图 / 空词汇时在 `Built` 产物内逐通道写 channel-unavailable，partition 单元全 zero-score 带理由——不是缺文件 | 非 RowSet 的裸 `string[]` 作分母；`GraphSummary["roots"]` 作分母；不同生产者 raw 分数直接相加；**任何阈值作准入闸**；无挤出记录的机制；**第 7 层的 observed aliases**（那会造成 7 → 4 反馈环） | units 台账身份 + 通道集与版本 + 预算 + run-intent 摘要（audience-free） |
| **5 工作集** | `attribution.json`（**席位集是成员资格的唯一权威**）+ 事实库 + `units.json` + `files.json` | 每调查的工作集：fact pack v2（每条目必带关系标注 retained / co-located / seeded——按第 3 层写下的成员资格与注册表声明的判定规则对席位 `UnitId` 集合判定，`{corpus}` 域标 `NotApplicable`——及粒度）、**`ReadSpec` 集：路径 + span + 理由 + 预算授权，不含源码正文、不含 evidence id**；scope census v2（分母来自台账，模块 × 语言，双守恒律）；overview census（无条件产出，含 overview-only run）；**渲染视图带声明的上界**（§四视图法则） | 顶层使用统一 `ArtifactResult`；每 feature 的不可构建原因作为 `Built` 内逐行状态，整层不可构建才返回 `Unavailable` | **整文件作为归属边界——文件只授权阅读，绝不授予成员资格**；无关系标注的事实条目；分母取自图 summary、候选池或证据目录；**源码读取器**——本层只授权，不执行；下游以 path/span 重算成员关系 | attribution 身份 + 事实库身份 |
| **6 义务声明** | `requirements.json` + 工作集 + `mechanisms.json` + `units.json` | 义务声明集：每个 `ReadSpec` 先有一条 `source-reading` 声明；每候选行再必落桶——decision-bearing → `decision-reading` 义务；probe unavailable → **逐候选残差行**（永不丢弃）；模板推导的知识要求逐条成行；**无 feature 的 run 也发 run 级义务** | 顶层使用统一 `ArtifactResult`；逐 feature 的失败原因保留为 `Built` 内的残差行，整层不可构建才返回 `Unavailable` | **证据目录的任何内容——声明绝不引用证据 id（这是义务↔证据环的切口）**；模板 / audience 形状本身；requirements 之外的需求来源 | requirements 摘要 + 工作集身份 + mechanisms 摘要 + units 身份 |
| **7 调查结果** | 义务声明集 + 工作集的 `ReadSpec` + 事实库 + 台账 + 被记录的判断（成员归属裁定、**observed aliases**：判者与所读证据 id 必填） | `investigation/results.json` **执行每个 `ReadSpec` 并产出真实源码窗口**，与证据目录、义务处置同层生长、同被封存：每条执行都引 `ReadSpec` 和 `source-reading` 声明；每个 `decision-reading` 明列 fulfilled / closed-negative / pending 与是否贡献正向知识；probe unavailable 仍逐函数保留。证据条目稳定 id、摘要、逐字节可重推导，类型含 source / graph / derived / **fact / ledger**（「我没能看」可被引用）；空枚举也是一条 ledger 证据；**四级字节上界（标量字段 / 单条记录 / 分片产物 / 模型视图）皆必设且覆盖所有 evidence kind**——超界确定性截断，必带 `contentRef`、`contentDigest`、`originalBytes`、`retainedBytes`、`truncatedReason`（P18）。`contentRef` 必须指向 run 内不可变、内容寻址且归档后仍可解析的字节（或等价的冻结源）；只指向可变化的 target 路径不成立。**它引用的是「本 run 声明的脱敏模式作用之后、截断之前」的字节，redaction 模式与版本进入内容身份**（今天 `src/snapshot/source.ts:29` 的 `windowCacheVersion` 已是这个形状）——把 target 的未脱敏字节存进 blob 会绕过 `redactSecrets`，让脱敏 run 的归档产物里出现原秘密；`originalBytes` 指的是截断前的长度，与此处的「原始」不是一回事 | 顶层使用统一 `ArtifactResult`；空类别写成证据条目（empty is a fact）；未处置或读取不可用的声明保持 pending 行——可见，且阻冻结 | 不在本 run 记录产物集内的数据；模型生成内容作为 derived 之外的任何类型；judgement 当事实消费；`rejected` 当预过滤器；负向关闭计入知识覆盖；**模型生成的摘要替代被截断的 source**（那只能是 derived，且必须与 `contentRef` 并存）；用活 target 路径冒充可归档 `contentRef` | (snapshot 身份, 源产物摘要, 声明集身份, **被记录判断摘要, 截断策略版本**)；id 规则稳定（`FACT-*` 等） |
| **8 冻结** | 全部前层产物 + 各自完整度块 + `BoundRunContract` + 审计清单 | 封闭哈希链产物集，**按 epoch 封存**：completeness **按 CoverageDomain 逐域合取**，内嵌各台账摘要或其摘要+限定（声明「没看」禁止无限定地渲染「全齐」）；正 / 负关闭拆分；**每个 `NotApplicable` 的 determination 必被验证其 `coverageDigest` 所依赖的完整度**（扫描被 cap、读取失败、机制部分覆盖时 not-detected 不成立，降级为 Unavailable）；审计清单让「检查被跳过」本身可检查 | 冻结拒绝本身是一份带理由的 append-only 记录：不平衡 census、pending 声明、对照契约缺信封、determination 前提不成立 ⇒ **错误**；tier1 身份失配 ⇒ 劝告，tier2 失配 ⇒ 错误 | 记录产物集之外的任何东西；**只由 plan 计算的 completeness**（57B-431 前的实现即此禁例）；**对照当前代码的期望集而非本 run 契约验收信封**（追溯性失败的源头）；**跨 CoverageDomain 合成的单一完整度比值**；**原地改写已封存 epoch 的哈希链** | 全链摘要 + 契约摘要 + **epoch 序号**；57B-424 选择不做旧工作集兼容读取——v12 之前的 run 不原地迁移，必须重新 prepare；世代闸由 `src/base/assurance-version.ts:91` 判定 |

**第五列（产物身份）的辩护。** 五件已付过学费的事压在它上面：归档 run 必须按自己记录的契约永久可验（硬约束）；快照身份曾是 mtime 形状而非内容（P10，双层身份写进第 1 层输出与第 8 层验证）；缓存键漏掉模式位造成静默漂移（先前裁定：模式是身份的一部分）；**语义输入漏进身份则缓存假命中**——故第 3 层身份含 `mechanisms.json` 摘要与生产者配置，第 7 层身份含被记录判断与截断策略版本。且**第 3 层身份不含 feature key**、**`RefUnitId` 与 partition `UnitId` 都不含 producer**，这两格分别治 P17 与「分母是工具观察数而非代码单元数」。`RefUnitId` 解决引用与多生产者合并，partition `UnitId` 解决守恒；两者职责不可再合并。

第五件学费是本轮新钉的：**单元身份只用内容哈希会让同 snapshot 内路径不同、内容相同的文件坍缩成一组 id**。实测**在扫描器自己的语料上**（`createSnapshot` 的输出，不是按扩展名 glob 的近似）：provital 3005 个扫描文件里 226 份与另一路径字节相同，83 个碰撞组，最大一组 **22 份 0 字节文件**（横跨 `.py` / `.dtml` / `.css` / `.zpt`，不是同一目录下的同名文件）；wcp 50 / 1999，20 组，最大 7；excavator 自己 0 组——它那批同内容文件在 git-ignored 路径里，扫描器本就不收。失败形态是静默的：坍缩后第 4 层分母少算，而三态守恒仍在 partition 行内部平衡，单文件夹具全部照绿。故两类身份都锚在第 1 层台账的行身份上——由 L1 拥有「什么让一行唯一」（target 相对路径 dedupe）加 tier2 内容哈希；不在此处重拼元组。副产物是结构性的：`UnitId` 从此不可能指向一个不在 `files.json` 里的文件。

**冻结的 epoch 模型（P0-4 的解法）。** 「不可变」与「允许冻结后补证」不能同时原地成立，而现行代码确实允许补证（`src/run/stages/investigation-stage.ts:35`：冻结后的写入必须携带一个能在 `workitems.json` 里解析到的 supplement）。裁定：**同世代内保留原地补证，但封存按 epoch 追加**——首次 `freeze` 把 `epoch 0` 写在兼容位置 `knowledge.json`；补证只追加到 `knowledge/supplements.json`；再次 `freeze` 把 `epoch N+1` 写到 `knowledge/epochs/epoch-N+1.json`，并钉住前一 epoch 摘要以及 evidence / timeline / supplement 三条流的 cutoff 与 tail。前一个 epoch 的字节和哈希链**只读不改**。报告与 authoring packet 绑定具体 epoch；有未封 supplement 时作者入口拒绝继续，旧 epoch 的 draft receipt 也不得被新 epoch 收集。这样：现有 supplement 机制不失效、而「补了什么」在产物上可见；v16 之前的旧 run 不改旧字节，重新 prepare。这个 epoch 模型不等于跨 schema 兼容读取。

**事实的成员资格是一个闭合联合，不是一个 cell。** 第 2 层声明的 `UnitKind` 含模块、模块对、corpus，而「每条事实恰好指向一个 partition cell」对它们不成立——`src/crossrepo/link-match.ts:42` 的 `MatchedLink` 真的两端（`call` 在前端文件、`route` 在另一模块），class 跨 method cell 与 residual cell，corpus 域的词汇 df 没有任何 cell 可挑。挑一端就直接污染 seeded / retained / co-located：后端路由入席而前端文件未入席时，那条跨仓边会被读成 co-located 而丢弃，P17 换个粒度重演。裁定：成员资格是**必填的闭合联合**——`{unit, unitId}` / `{spanSet, unitIds[]}` / `{relation, endpoints[]}` / `{module, moduleId}` / `{corpus}`，没有可选字段、没有空集合合法态。**判定规则（任一端入席 / 全部覆盖入席 / 锚点入席 / 不参与席位判定）由基座的 kind 闭合注册表随 kind 一起声明**，不由第 5 层按 fact kind 选择——否则消费侧持有第二份语义表，正是「下游不得拥有第二份映射算法」禁的事。`{corpus}` 的席位判定是 `NotApplicable`：它是一个被写下的状态，不得塞进任一 cell，也不得以 null 进入事实包的逐条标注。事实不参与三态守恒（守恒的对象是 partition 行），不得为多单元成员资格补一条事实守恒律。

**分区由指定构建器产出，观察者不得改分区。** 契约自己撞了一次：分母法则要求「producer 增减不得改变既有分区」，而§六的粒度阶梯又写「有索引处投影到 partition、无索引处降至文件」——分区粒度成了生产者可用性的函数，一个可选工具一次可用一次不可用就换掉整个分母与大量 `UnitId`。裁定拆成两件事：(a) `partition[]` 由**每语言一个指定的分区构建器**产出，该构建器在 `contract-manifest` 中声明且**必需**——不可用时第 3 层信封是 `Unavailable`，绝不静默给一个更粗的分区；无构建器的语言按契约声明落文件级 partition（只有 residual），并在 `mechanisms.json` 记为已声明的覆盖缺口，而不是意外结果。(b) 普通事实生产者（framework pack、crossrepo、词汇）只能**观察并挂到既有 cell**，永不创建或切分 cell。补构建器或改其算法是**分区 schema 换代**：`UnitId` 跨版本不可比较，走 epoch，不做原地细化。验收是双向的：同一源码与契约下，可选生产者 available / unavailable 两次跑 `partition[]` 字节不变；构建器不可用时第 3 层返回 `Unavailable` 而非更粗分区。

**第 5/7 层的读取分工（P0-2 的解法）。** 第 5 层只产 `ReadSpec`（授权），第 7 层才执行并产出真实窗口与证据。否则因果是「先读源码 → 再声明该读什么」，义务顺序问题只是换了名字。生产者为构造事实而做的预读属**第 3 层内部**，不进证据目录、不占预算授权。

**`co-located` 不建立同 run 的反向提升环。** 关系标注本身不得授权 `ReadSpec`、进入模型视图或自动生成 fact evidence。第 7 层只有在**已有独立理由的第 5 层 `ReadSpec` 已覆盖该条目成员资格中的任一 `UnitId`**时，才可用所读 evidence id 与判者记录把它显式纳入调查结果；该判断不得回写第 5 层或补造一个追溯性的 `ReadSpec`。若没有独立授权，必须以新的 run-intent / 查询别名开启新 run，而不是从第 7 层反馈到第 5 或第 4 层。负向验收是默认 co-located 全部零消费；正向验收是已有独立 `ReadSpec` 时恰好一条具名判断可提升。

**第 6/7 层的切法是从现状读出来的，不是排出来的。** 今天计划就在 prepare 铸出（`src/run/run.ts:333`），先于源码窗口阅读；而冻结后补证必须引用一个既有 work item（`src/run/stages/investigation-stage.ts:35`）——证据引义务、义务处置引证据，两个方向都真实存在。切成「声明在下（绝不引证据）、执行与处置同层在上」，环被声明侧的禁止输入列切断；调查在第 7 层内迭代生长，冻结是唯一封口。层序约束跨层依赖方向，不约束层内迭代。

---

## 二、依赖全序与去环

**全序**（低 → 高）：

```
BoundRunContract（层之前的不可变契约）
基座 < 1 边界 < 2 机制 < 3 事实与单元 < 4 归属 < 5 工作集 < 6 义务声明 < 7 调查结果 < 8 冻结 < 报告层（范围外） < 编排
```

导入只许指向同层或更低层；`import type` 同样计数（接口知识向上流动也是依赖）。`BoundRunContract` 在一切层之前，任何层都可读它。

**七边已全部解开（57B-419），实测 0 向上边 / 0 环。** 下表是落地记录，不是待办。「落地前」列写的是移动之前的位置，**它们是历史锚点，绊线不再对照代码**；「落地后」列指向今天的文件，由绊线守着。层序门（`tests/layer-order.test.ts`）在 `src/**` 上首次指向时红在 **10 条向上边与 5 个强连通分量**上，逐批消到 0，每批全量测试保绿。

| # | 落地前的违序边 | 落地后 |
|---|---|---|
| 1 | `src/snapshot/providers.ts:6` → `codegraph/module-detection`（边界层向上引事实层） | `module-detection.ts` 下移到边界层 `src/snapshot/module-detection.ts`——模块标记发现是 target 形状检测，不是图能力 |
| 2 | `src/codegraph/codegraph-command.ts:4` → `snapshot/providers`（取 `executableAvailable`） | `executableAvailable` 下移到基座 `src/base/executable.ts` |
| 3 | `src/context/boundary-functions.ts:26` → `assurance/decision-probe`（工作集层向上引探针） | 探针与结构化边界函数生产者都下移到事实层 `src/facts/probe/`（`boundary-functions.ts`、`decision-probe.ts`、`condition-extract.ts`、`condition-extract-perl.ts`）——预读属于事实生产，不属于工作集授权 |
| 4 | `src/crossrepo/frontend-calls.ts:21`、`src/crossrepo/route-table.ts:25` → `assurance/condition-extract`（取 `loadAstGrep`） | 随 #3 一并解决：crossrepo 与 probe 同属第 3 层，平层引用合法 |
| 5 | `src/core/types.ts:1-4` → context 四个产物类型（基座向上引） | `PreparedContext` 上移到其生产者 `src/context/context.ts`，基座那四行 import 删除 |
| 6 | `src/core/run.ts` 与 `types.ts` 同目录（假层：一头最底、一头最顶） | `src/core/` 整体解散：`run.ts`、`run-label.ts` → `src/run/`（编排），其余 → `src/base/`（基座） |
| 7 | `src/assurance/parallel-authoring.ts:7` → run.ts（报告层向上引编排，取 `archiveCheckpoint`、`normalizeSection`） | 两函数随 #6 同批移出 run.ts 到报告侧，现位于 `src/report/checkpoint.ts` |

**契约原文在这一节错了三处，照实记下，因为每一处都改变了「该防什么」：**

- **说「三个环」，实测是 5 个。** 多出来的两个契约从没提过：`src/schema/parsers/` 的**六节点环**与 `src/framework/` 的**二节点环**。两者的反向边都是 `import type`——`gorm.ts` 引 `type { SchemaParser } from "./parser.ts"` 而 `parser.ts` 引 `gormParser`；`catalyst.ts` 引 `type { FrameworkPack } from "./pack.ts"` 而 `pack.ts` 引 `catalystPack`。接口知识向上流动一样是依赖，而这种边人眼扫代码看不出来，只有把 `import type` 一起计数的强连通分量检测能看见。这正是「(b) 任何环即失败，无论涉事文件登记与否」不能退让的理由：靠人清点漏掉了 5 个里的 2 个，而且都不在任何人的怀疑名单上。
- **#7 不是「落地即新生」，它今天就在。** `parallel-authoring ↔ run` 在 `src/core/` 解散之前已经是一个二节点环；契约把它写成「#6 落地才会创造」，等于把一条既存红边记成了未来风险。
- **#2 的方向其实是向下**（L3 → L1），文件级不红——它是「目录成环」这个思维的产物。解法照做（`executableAvailable` 下移基座，两个消费者分别在 L1 与 L3，归谁都是跨层引用），但它本身不贡献任何红边。

**登记逐文件，没有默认层。** 「目录默认层 + 逐文件例外」与「未登记文件必须失败」不能同时严格成立——新文件会自动吃到默认层而不失败，盲区照旧。故登记表（`tests/layering-registry.ts`）**只有显式条目**：目录条目仅当该目录整体属于一层时使用；原先混装的 `src/assurance/` 已按真实层拆除，登记表因此退化为目录清单加编排入口。

**两处混装文件已拆开——「只登记不拆」不是可接受终态。** `freeze.ts` 引 `assurance.ts`，而 `assurance.ts` 引报告侧 `claim-comparison.ts`：一条向上边，也是一个环的一半，而登记表无论把 `assurance.ts` 记成知识侧还是报告侧都有一半是假的。

- `assurance.ts`（当时 1076 行）拆三份：`AuditFinding` → 基座类型；版本闸簇 → `src/base/assurance-version.ts`（**归基座而非第 8 层**：它的消费者横跨 L7 / L8 / 报告 / 编排，登记 L8 会当场造出一条 L7 → L8 的新向上边）；报告侧 section / claim / marker 审计 → `src/report/section-audit.ts`。残余现位于 `src/investigation/assurance.ts`（**425** 行，L7）：计划/清单机器与 evidence / trace / workitem / checklist 四个审计，正是 freeze 消费的那四个。
- `assurance-artifacts.ts`（当时 118 行）二分：`createAnalysisScope`、`emptyTraceCatalog`、`mergeTraces` → `src/investigation/investigation-artifacts.ts`（L7）；`collectClaims`、`writeReportCompanions` → `src/report/assurance-artifacts.ts`。

**防复发靠代码形状，不靠纪律。** 层序测试（与 `tests/search-corpus.test.ts:17` 钉注册表包含关系同一形状）解析 `src/**` 全部 import 建图，(a) 对照登记表断言无向上边；(b) **检测强连通分量——任何环即失败，无论涉事文件登记与否**；(c) **未登记的文件即失败**——新文件必须先声明自己是哪一层，没有第四态。**装置本身先被验证**：每条检查都另有一组合成夹具喂进同一批纯函数证明它会红，且真实那一遍先断言「图覆盖了 src 全部文件、每条相对 import 都解析到已知文件」——只会绿的检查器比没有检查器更糟，它会为它指向的任何东西背书。

四个接口法则各有一个会红的执行点，都已落地：

| 执行点 | 落在哪 | 今天怎么红 |
|---|---|---|
| `ArtifactResult<T>` 只有基座一个定义，且不得另造竞争方言 | `tests/artifact-result-single-definition.test.ts` | 除 `src/base/artifact-result.ts` 外，任何**单个类型声明**同时含 `status: "unavailable"` 与 `status: "built"` / `"not-applicable"` 即红。已知边界写在测试里：换字面量（如把判别字段挪到 `reason`）能逃过形状扫描，第二道防线是消费端穷举 switch |
| 消费必须穷举三态 | `tests/interface-laws.compile.ts` | 少写一个分支后调 `assertNever`，参数不可赋给 `never`。整个文件由 `npm run typecheck` 把关（不在 `npm test` 的 `tests/*.test.ts` glob 内，在 tsconfig 的 `tests/**/*.ts` include 内）；抑制注释拆掉后 `tsc` 报 6 条错 |
| 产物注册表覆盖八层槽位与全部第 3 层生产者 | `tests/artifact-registry-coverage.test.ts` | 八层各 ≥1 槽位、producers 恰是层 3 点名的七个、id 唯一、每条必带 `enforcementNote`。少一层或少一个生产者即红——否则期望随产物一起消失，冻结的信封检查又成同义反复 |
| `RowSet` 私有构造函数只接受较低层台账 | `src/base/row-set.ts` + 编译夹具 | `new RowSet(...)` 与把裸 `string[]` 当分母都是编译错误；两个门 `fromLedgerCounted` 与 `fromPartition`（57B-421 落地）各自要求台账身份与完整度块随行，且按来源命名而非按参数取域，调用方无法谎报粒度 |
| `summarize` 是两条守恒律的唯一构造函数 | `src/base/conservation.ts` + 编译夹具 | 产物类型带**非导出 symbol 品牌**，四个数字都对的字面量也不可赋值；`unexplained` 由构造函数减出来，调用方连传都传不进去。`buildFileLedger` 的 summary 已经过它构造，`files.json` 字节零变化 |

---

## 三、目录结构：让真实目录对应真实层

一个目录一层（或一层的一个生产者），是登记表能退化成目录清单的前提。原先 `src/assurance/` 一个目录装了 **21** 个文件、横跨知识侧与报告侧；57B-429 已按既定归属消除该目录。当前结构（`✓` = 目录归属已落地，后续能力仍按切片补齐）：

```
src/base/            ✓ 共享类型、工具、注册表（语言 / 机制 / 产物）、RowSet、守恒构造函数、版本闸
src/contract/        ✓ BoundRunContract：run-intent / requirements / contract-manifest 的类型与物化
src/boundary/          层 1：扫描、文件台账、双层身份、module-detection —— 今天仍叫 src/snapshot/
src/mechanism/       ✓ 层 2：机制台账、CoverageDomain / UnitKind 声明
src/facts/             层 3：units.ts（reference units + canonical partition + member mapping）+ 每生产者一个子目录
    probe/           ✓ —— 今天 src/facts/ 下只有这一个；另外六个生产者仍在自己的顶层目录里
    codegraph/  nativegraph/  framework/  schema/  crossrepo/  vocabulary/
src/attribution/     ✓ 层 4：唯一分配器、选择贡献痕迹与归属产物
src/workset/         ✓ 层 5：fact pack v2、ReadSpec、census 与唯一消费视图
src/obligation/      ✓ 层 6：义务声明、requirements 展开、残差行
src/investigation/   ✓ 层 7：ReadSpec 执行、证据目录、义务处置、截断策略
src/freeze/          ✓ 层 8：epoch 封存、completeness 逐域合取、审计清单
src/report/          ✓ 报告层（契约范围外，仍受层序测试约束）
src/run/  src/cli.ts ✓ 编排
```

**登记表今天与目标结构的两处差距，都是过渡而不是裁定：**

- `src/facts/` 只有 `probe/`。另外六个生产者（codegraph、nativegraph、framework、schema、crossrepo、词汇）仍在自己的顶层目录里，各自登记 L3。层 3 的约束是「每生产者一个子目录」而不是「必须叫 `facts/x`」，所以这只是名字没搬。
- 层 1 的目录名 `snapshot/` 尚未改。层 5 仍处于双目录过渡，但 57B-424 已把 census、`ReadSpec` 与唯一模型视图收束到 `src/workset/`；`src/context/` 只保留确定性收集与缓存。结构化源码预读的生产者已迁至 `src/facts/probe/`。**但层 5 仍在执行源码读取**：`src/context/context.ts:172` 构造 `SourceReader` 并在 prepare 期读出项目文档与回退搜索窗口，与本层禁止输入列的「源码读取器——本层只授权，不执行」直接冲突。这是**已计量的过渡违规**，不是已完成的迁移：第 8 层 `closure.sourceReadsWithoutObligation` 记录每次冻结时未被任何读取执行认领的读取条数（wcp overview 实测 10 条），并在 `investigation-closure` 族发劝告级 finding。层序测试抓不到它——L5→L1 是向下 import，方向合法，禁止输入列不由装置守着。迁移方案见该字段的定义注释。**登记表是契约，目录名不是**。

探针三份（`decision-probe`、`condition-extract`、`condition-extract-perl`）与版本闸簇先迁至 `facts/probe/` 与 `base/`；57B-429 又把余下 21 份全部按已登记的侧归位：义务三份 → `obligation/`，调查五份 → `investigation/`，冻结三份 → `freeze/`，timeline → `base/`，报告九份 → `report/`。`src/assurance/` 不再存在，新文件不能再靠混装目录逃过层登记。

**这不是严格一一对应，也不需要是。** 约束只有三条：**一个目录不跨层**；**层 3 的生产者各占一个子目录**（它们的失败语义与身份互相独立，混在一起就无法逐生产者写信封）；**报告侧代码不与知识侧同目录**（否则登记表必须重新引入默认层，盲区回来）。目录改名不是契约——登记表是契约，名字随切片定。

---

## 四、四法则，作为接口规则

| 法则 | 接口规则表述 | 承载列 |
|---|---|---|
| **输出法则** | 每个接口是**全函数**：任何输入（含坏输入）都映到一份被写下的 `ArtifactResult<T>`，闭合三态、穷举 switch。**判据——新增状态仅当冻结/完整度消费者必须在不读 reason 的前提下分支、且并桶会翻转一个审计结论**：`not-detected`、`single-module` 是对 target 的**判定**（已看，确定无），并进 Unavailable 会把「已判定无」错渲染成盲区，故 NotApplicable 成立——但**判定必须携带其成立前提**（`basedOn` 指出依据哪份完整度、`coverageDigest` 钉住当时的值），第 8 层验证该前提；扫描被 cap、读取失败或机制部分覆盖时 not-detected 不成立，降级为 `Unavailable`。策略性跳过今天没有按状态分支的消费者，折叠为 `Unavailable{cause:"policy"}`，不设第四态。**唯一写者，两个温度类**：第 7 层产物与 timeline 是 append-until-freeze（并按 epoch 封存），其余 write-once。**append 类产物必须真正做到累计 I/O 为 O(N)**：不仅禁止「整读 → 改一条 → 整写」，也禁止追加前整读历史来取得尾状态——57B-430 前 `src/base/timeline.ts:18-19` 与 `src/run/stages/investigation-stage.ts:152` 分别是这两种缺陷。现在 evidence、timeline、supplement 共用 `src/base/single-writer.ts:28-50` 的单写者与常数大小尾 checkpoint，evidence 的追加门在 `src/investigation/evidence-store.ts:129-145`；追加顺序由确定性序列而非并发到达时刻决定。**序列权威说清三件事**：sequence 在单写者提交时分配（不预留），语义序取自确定性排序的收集队列而非完成时刻（`src/report/parallel-authoring.ts:100-110` 的 `collectDrafts` 串行栅栏已是这个形状：草稿落 receipt，一个进程按确定序收集），墙钟 `at` 进 digest（否则可无痕改时间）。因此**字节确定性钉在封存产物上，不钉在 timeline 上**：timeline 是保留真实因果顺序的墙钟日志，两次跑不可能逐字节相同，要求它相同只能靠丢掉真实时序；「随机到达仍逐字节相同」的验收对象是 canonical 排序后的冻结产物（证据目录、声明集、partition），timeline 的验收是链验证通过 + sequence 连续。证据的全量 canonical 排序与摘要只在封存/审计发生一次。可能截断的生产者把完整度日志作为必填参数。消费强制在第 8 层 | **失败输出**列（全表八行），消费强制在第 8 层的输入契约 |
| **分母法则** | 任何跨接口的分母必须是**严格更低层台账产物**派生的 RowSet（`files.json`、`mechanisms.json`、`units.json.partition`、事实信封），且该台账记录自己的完整度；每个 RowSet 携带其 UnitKind 与 CoverageDomain，消费方嵌入台账身份与完整度块。分子可以来自任何地方，**分母只能来自台账**——`GraphSummary["roots"]`、候选池、证据目录、允许嵌套的 `refUnits[]` 都不是归属分母。分母的 partition `UnitId` 必须 canonical、无重叠、锚在第 1 层台账行身份上且不含 producer；**分区只由指定的分区构建器产出，事实生产者增减不得改变既有分区**（构建器本身换代走 epoch，见§一「分区由指定构建器产出」） | **禁止输入**列（第 4、5 层的行把它落到实处） |
| **三态法则** | 每个集合值输出是一次**完全划分**，两条轴两条守恒律，各有唯一构造函数、**各在其自己的 CoverageDomain 与 UnitKind 内成立**：覆盖轴 `total = counted + excluded + unexplained`（第 1/2/5 层）；选择轴 `counted = seated + zero-score + displaced`（第 4 层）。**文件的 partition 也是一次完全划分**：非重叠细粒度 cells + residual cells = 该 counted 文件的全部（第 3 层）；允许嵌套的 `refUnits[]` 与事实都不参与这条加法，只通过声明的成员资格映射到 partition——多单元成员资格因此不需要、也不许补一条事实守恒律。**不同域的守恒不得合成一个数**——跨域比值被第 2、8 层的禁止输入列点名。zero-score 不是排除；`unexplained` 是诚实残差，永不可删，在第 4 层它意味着产物损坏，是错误而非劝告 | **输出**列（产物 schema 自带守恒），复核在第 8 层平衡强制 |
| **视图法则** | **机器产物绝不直接进入模型上下文**；模型消费只经由声明了上界的确定性渲染视图，视图必引其源产物摘要（今天 `renderFactPackSection` 的 60 行/类目上限即此形状，`src/workset/factpack-view.ts:54`）。实测同一批 660 条事实项，JSON 比表格贵一倍（125,807 vs 60,939 字符）——JSON 是给审计与重推导的，视图是给模型的。**上界分四级各自设定**：标量字段、单条记录、分片产物、模型视图——只限字段挡不住「每条都小但数组无限大」。不给层表加「模型可读性」列：八层产物全部是机器读物，一列会重复同一个词八遍；模型可见的视图各自在产物定义里声明上界 | 第 5 层**输出**列；产物侧四级上界由 P18 禁令（第 7 层输出列）承载 |

---

## 五、粒度检验（P1–P18 必须跨接口）

判据：每个已知问题必须跨一条**具名接口**；留在层内的问题意味着那条边界没画对。接口按其承载产物命名。

| # | 问题 | 跨哪条接口 |
|---|---|---|
| P1 | 词法命中是唯一准入路径 | 事实 → 归属：词法是贡献契约下的一个通道；归属层禁止输入「任何阈值作闸」+ 分母必须是台账 RowSet |
| P2 | 噪声判断只在下游生效 | 事实信封：unit kind 由第 3 层唯一声明，下游禁止再分类——第二份拷贝在接口上不可表达 |
| P3 | 结构工具不能准入、不可引用 | 事实 → 归属 与 事实 → 调查结果：工具成为第 3 层生产者，产物经通道计分、经证据目录可引用 |
| P4 | 加语言要改六处 | 边界 → 机制：注册表在基座唯一；未注册扩展名在第 1 层落 `excluded{unsupported-extension}` 并按扩展名分组，已 counted 而无机制支持的在第 2 层落 no-mechanism 行——两个桶都进 census，「忘了」在分母所在的层就可见 |
| P5 | census 分母取自索引 | 台账 → 工作集：census 分母只能通过两扇 RowSet 门进入；`src/workset/census.ts:95` 只接受 `ledger/files.json` 的 file RowSet 与 `facts/units.json.partition` 的 partition-cell RowSet，旧 `GraphSummary["roots"]` 路径已删除 |
| P6 | 记账按 feature、整 run 可沉默 | 工作集 与 义务声明：overview census 无条件产出；无 feature 的 run 也收 run 级 requirements 与义务声明 |
| P7 | 模块身份 = 路径首段 | 工作集产物契约：模块 × 语言双分组强制，每行声明粒度，比值绝不跨粒度、绝不跨 UnitKind |
| P8 | 全局预算整模块清零 | 台账 → 归属（零命中侧：分母成员资格构造性完整）+ 归属产物契约（有命中侧：挤出必带记录） |
| P9 | 计划只有缺陷假设 | 契约 → 义务声明：`requirements.json` 是知识需求唯一通道，模板是它的一个生产者，在边界处翻译成需求行 |
| P10 | 快照身份是 mtime 形状 | 边界 → 冻结：双层身份在 `files.json`，验证规则（tier1 劝告 / tier2 错误）在第 8 层。**已由 57B-418 落地**：身份改锚 `contentManifestDigest`，`SCANNER_VERSION` v2；内容缓存键含 `ctimeMs`，否则同尺寸同 mtime 改写在热缓存下仍隐形（实测过一次假绿） |
| P11 | 冻结在证据需求已知前关门 | 义务声明 → 冻结：pending 需求行或未处置声明即冻结失败；冻结保持单阶段，补证走 epoch |
| P12 | 静默出空（清点 42 处） | **全部接口的失败输出列**——这一类由「接口是全函数」整体化解，不属于单条边 |
| P13 | 文件扫描静默截断 | 边界 → 一切下游：**已由 57B-418 落地**（以下行号是修之前的 `snapshot.ts`，留作出处）：`:211` 把 cap 与固定排除混在同一个条件里、`:238` 的 break 可丢整根，另有三处静默吞（`:215` 路径逃逸、`:218` 非常规文件/符号链接/>2MB、`:226` lstat 失败）；现在每个候选必落桶，完整度块必填，经分母法则被每个消费方继承；**并被 NotApplicable 的 `basedOn` 引用**——扫描不完整时 not-detected 不成立 |
| P14 | 未探测函数被静默丢弃 | 机制 → 义务声明：`mechanisms.json` 声明（语言 × 机制）缺口；`src/obligation/declarations.ts:93` 让每个候选进入 decision / exclusion / unavailable 之一；`src/obligation/read-obligations.ts:258` 的 legacy skip 不再是第 6 层声明边界 |
| P15 | 最新机制零问责 | 分配器贡献契约：每个候选都携带来源通道、理由、锚点、传播路径及归一化贡献；唯一 `seat-cap` 的挤出逐项记录，零信号模块仍有 census 行但不强塞席位（`src/attribution/allocator.ts`、`eval/fixtures/allocator/preregistration-v1.json`） |
| P16 | 旁路工具或层产物在流程里不可达 | 契约 → 冻结：八层产物槽位与第 3 层生产者未列入 `contract-manifest` = 无期望；列入而缺统一信封 = 冻结失败——不可达从文档问题变成会红的检查 |
| P17 | 事实包按文件边界收录 | **归属 → 工作集**：席位 `UnitId` 集是成员资格唯一权威。`src/context/factpack.ts:230` 现在只产不带关系裁定的收集结果与 layer-3 join hint；`src/workset/factpack-annotate.ts:38-58` 在第 4 层之后逐条转录成员资格、保持分母不变并标 seeded / retained / co-located / not-applicable；`src/workset/factpack-view.ts:6-22` 是模型视图、FACT evidence、义务、work item 与 cross-feature 的同一消费闸，只放行 seeded / retained。全链禁止重新按 path/span 猜测，也禁止 co-located 自动产事实。旧实现实测 `handlers.go` 299 条 entrypoint 中 293 条与功能无关且全部可引用；换格式不能修这类成员资格错误 |
| P18 | 无上界字段打穿产物与其每个消费者 | **调查结果 → 冻结**：一次真跑 `evidence.json` 2.5 MB，单条 SEARCH 记录 2.27 MB——一条 excerpt 439,321 字符，来自压缩过的 `tiny_mce.js`；现存历史 WCP run 还出现 8.56 MB / 596 条的目录，最大单条 graph evidence 约 266 KB，故风险既包含「一个巨型字段」也包含「许多中型记录累积」。第 7 层对所有 evidence kind 设四级上界，超界截断必带五字段；`contentRef` 必须是归档后仍可解析的不可变内容引用，freeze 后修改/删除 target 仍能重推导原字节。压缩判定走第 1 层行形状；append writer 的累计读写量必须线性，不能只把整写改成 JSONL 却保留每次整读 |

**检验改变了层的形状，三处：**

1. **结构 / 约定 / 词汇三个事实层合并为一个。** 三者接口形状完全相同（输入台账与源文件，输出带完整度的信封），差异只是生产者。P1–P18 没有一条需要跨「结构 vs 约定 vs 词汇」的边界。词汇信封保留独立产物身份与字节稳定验收。
2. **补一个工作集（消费）层（57B-424 已完成切片）。** `buildFactPack` 已被拆成第 5 层之前的确定性收集结果与 `src/workset/` 的关系标注 / 消费视图；机器分母保留全部行，自动消费只读 seeded / retained。census 只读 L1/L3 RowSet，`ReadSpec` 只表达授权，模型只读带源摘要与上界的 `context/workset.md`。
3. **义务拆为「声明」与「处置」，处置与证据、读取执行合为一个调查结果层。** 上一版把义务整体放在证据之上，但冻结后补证必须引既有 work item（`src/run/stages/investigation-stage.ts:35`）——证据引义务在旧序下是向上引用，契约自己违序；而计划本就在 prepare 铸出（`src/run/run.ts:333`），先于窗口阅读。声明在下（绝不引证据 id），执行与处置同层迭代生长，冻结按 epoch 封口。

十层 → **八层**（另有契约、基座、报告层、编排四个非层地层）。P5、P14、P17、P18 全部跨具名接口，检验闭合。

---

## 六、显式未决——不要把缺席读成决定

以下全部**有意留空**，由各自切片按读数裁决，本文不预设：

- **通道清单与融合算法**（哪些计分通道、分数如何合成）——由实测读数把关，接口只规定贡献契约与「不得作闸」。
- **分配器机制**（席位如何分、地板形状）——同上；接口只规定守恒律与挤出记录必填。
- **事实库的实现形态**（逐文件 JSON / JSONL 分片 / SQLite 派生索引 / 惰性实现）——接口只规定信封身份、单元字段与字节确定性。派生索引若引入，必须可从权威产物**字节确定性重建**。
- **P18 的四级上界常数**（证据侧：标量字段 / 单条记录 / 分片产物 / 模型视图）与不可变 content blob 的具体分片/压缩实现——禁令、归档可解析性与累计线性 I/O 已定，数值和物理布局由读数钉。**分区构建器一侧的行形状阈值已钉，见下。**
- **`SkippedByPolicy` 是否升格为第四状态**——仅当出现按状态分支的消费者时升格；在那之前是 `Unavailable{cause:"policy"}`。
- **freeze epoch 的粒度**（每次 supplement 一个 epoch，还是一批 supplement 一个）——epoch 存在、前序只读、报告绑定 epoch 是契约；粒度随切片钉。
- **词汇 df 的分桶与校准**——今天全仓**零 df 计算**（`context.ts` 的 `tokenize` 喂的词全部来自 run-intent 的 subject/aliases，不来自仓库语料），所以第 3 层的词汇信封是诚实的 `Unavailable{not-implemented}`；分桶与校准等它真被实现时再钉。注册表原先写着「In-repository term frequency / Computed inline during context preparation」，那句话对任何代码路径都不成立，已同批改掉——描述一个不存在的机制比不描述更糟，冻结会据它报一份干净的信封集。
- **两份外部输入的 schema 细节**、**证据 id 规则是否迁移**、**`assurance.ts` 与 `assurance-artifacts.ts` 的拆分形状**。
- **优先语言的结构探针什么时候补、先补哪几种**——今天探针只覆盖 TS / Tsx / JS / Go 七个扩展名（`src/facts/probe/condition-extract.ts:47-55`）加独立 Perl 后端，Python / Java / Ruby / PHP / C# 返回 `unavailable`（`src/facts/probe/decision-probe.ts:52-55`）。探针缺席限制的是**验证**，不是引用与分区身份：有指定分区构建器的语言建立嵌套 ref units 并投影到 partition，无构建器的语言**按契约声明**落文件级 partition 并记原因，residual cells 保证文件仍被完整划分——注意这条是「契约按语言声明的粒度」，不是「碰巧哪个可选工具在场」，后者已被§一「分区由指定构建器产出」禁止；每语言每机制在 `mechanisms.json` 里是一个数字，而非沉默；regex fallback 若保留则作为独立机制计数。
- **目录最终命名**——第三节给的是形状，名字随切片定；登记表是契约，名字不是。

### 已落地（57B-421 钉掉的五条，不再是未决）

以下五条原先在上面的清单里，现在是落地记录。写下来是因为**每条都由读数决定，且都有过一个看起来同样合理的错答案**。

- **两类 id 的编码**：`RefUnitId = ref:<unit-kind>:<startByte>-<endByte>:<relativePath>`，`UnitId = cell:<partition-kind>:<startByte>-<endByte>:<relativePath>`，实现与铸造器在 `src/facts/units/unit-identity.ts`。**canonical span 是 UTF-8 字节半开区间**，不是行号：两个结构可同处一行（压缩 JS），行粒度无法结构性保证无重叠，且完整度算术要对得上第 1 层的 tier1 `size`（字节数）。路径**殿后**、只按前三个冒号切，因此路径里含冒号也无歧义、不需要转义方案。两个构造器**都没有 producer 参数**，所以「分母是工具观察数」在编译面不可表达。装置先钉在使用之前：ast-grep 的 `range().index` 经实测是 **UTF-16 码元**而不是它自己文档说的字节偏移，所以每个偏移都过一次 `utf8OffsetMap`——若按文档假设，任何含一个非 ASCII 字节的文件的每个 span 都会错，而且错得一致到看起来是对的。
- **归一规则**：构建器骨架是 canonical span 的**唯一权威**。观察按「锚点所在行 + kind 类匹配」挂到骨架节点，`observedBy[]` 追加排序去重的 producer id；挂不上而又带完整行区间的观察铸独立 ref unit 并标 `normalization: "reported-span"`（对照骨架的 `"builder-node"`，二值必填）；挂不上也铸不出的落 `unnormalized` 可见桶带四种原因之一。**kind 类而非 kind 精确相等**：CodeGraph 把 `const f = () => {}` 报成 `function` 而语法树叫 `arrow_function`，精确匹配会拒掉 TypeScript 代码库里最常见的形状并在构建器节点旁边铸一个重复单元。行粒度的偏好序是显式且全序的（先「在该行内起始」，再 structure 先于 residual，再更小的 span），因为 `export function foo()` 的 cell 边界落在行中间——按「该行首字节所在 cell」解会把每个导出声明记到它前面那 7 字节的 residual 里，这是在本仓自己的源码上实测出来的。唯一判定点是 `src/facts/units/membership-map.ts`，下游没有第二个函数可调。
- **成员资格逐 kind 取值**：`indexed-function`(unit/anchor-cell)、`indexed-route`(unit/anchor-cell)、`recovered-route`(unit/anchor-cell)、`frontend-call`(unit/anchor-cell)、`http-link`(**relation/any-endpoint**)、`term-df`(**corpus/not-applicable**)，声明在 `src/base/fact-kind-registry.ts`，判定器 `evaluateSeat` 全仓唯一。`indexed-route` 只有在 `references` 边同时通过可调用 kind 与源码 qualifier/import 校验时才归属 handler cell，并以 `handlerFactId` 明示 route→handler；无边、错边或多条有效边都保留在注册行，写 `handlerResolved:false` 与闭合原因计数，绝不静默猜测。`all-covered` 与 `module` 两个臂 v1 没有 kind 取用，但都有夹具——只在需要它的那天才写的规则是在截止期下发明的规则。
- **分区构建器选型与首批语言**：`typescript` / `javascript` / `go` → 新机制 `partition-ast`（ast-grep，支持集直接复用两个探针已声明的 `AST_GREP_EXTENSIONS` 常量，不造第二份）；**其余全部注册语言**（perl、zope-page-template、dtml、python、html… 与全部 nameClass 语言）→ 声明的 `file-level`，即每文件一个 residual cell，并在 `mechanisms.json` 里作为已声明的覆盖缺口可见。映射表在 `src/base/partition-designation.ts`，加载期双向校验完整性。实测读数：provital 3005 个 counted 文件里 `.pm` 1366、`.zpt` 465、`.dtml` 346 全部 `no-mechanism{extension-not-declared}`。
- **分区构建器一侧的行形状上界**：`partition-ast` 声明 `maxLineLength: 5000`（与 `maxFileBytes: 500_000` 同形，两者都在机制注册表里而不是埋在代码里）。**尺寸上界单独拦不住它**：`tiny_mce.js` 是 439,601 字节、在 500 KB 之下，单份就产 3,489 个 ref unit，且有四份拷贝；未设行上界时 provital 的 `refUnits[]` 是 61,067 条、序列化 63 MB，设上界后是 7,322 条。阈值取 5000 而非更紧，是因为三个真实目标上最长的**手写**行是 3,153 字节（wcp 的 `ManPrice.tsx`），本仓自己最长 1,392；5000 在 provital 上命中 81/3005（60 份 `*.min.js`，其余是 webpack chunk 与打包后的 vendor dist，全在 `root/static/` 下）、wcp 3/1999（vendored prettify 词法表）、本仓 0/340。判定信号取第 1 层 tier1 的 `maxLineLength`，因为 P18 已裁定压缩判定走第 1 层行形状——在这里再扫一遍就是第二份分类学；它的局限一并写下：该信号只测前 8 KiB，8 KiB 之后才开始的长行看不见，而漏判的后果是产物更大而不是 span 更错。被拒的行仍得到完整分区（一个 residual cell + `builder-line-shape-cap`），不离开分母。

---

## 七、接口钉定顺序

原则承接：**度量先于它要归因的机制**；装置先被验证，再被使用。不承诺任何并行提速——独立性只作为接口事实陈述。

1. **`BoundRunContract` 骨架与产物/生产者注册表先钉**——它在一切层之前，登记八层产物槽位与第 3 层生产者，其余每层的身份列与第 8 层的验收都引用它。放在最前而不是收尾：注册表不存在时，「缺信封即失败」只能对照当前代码的期望集，那正是追溯性失败的源头。
2. **第 1 / 2 层台账**（含每机制的 CoverageDomain / UnitKind 声明）——它们是所有分母的来源。确认读物：静默截断变成完整度块字段；注册表登记齐全。**已完成（57B-418）**。
3. **层序测试（逐文件登记 + SCC 检测）与去环七边**随第一次移动落地——测试先红后绿；#7 由同一测试在 #6 落地当批拦住，绝不允许「先移动、后补测试」。目录结构（第三节）随这一步分批落，一次一层，每批全量测试保绿。**已完成（57B-419）**：实测起点是 10 条向上边 / 5 个环（不是契约原文说的六边三环，见第二节的三处更正），逐批消到 0；四个接口法则的执行点与本文锚点的绊线同批落地。目录结构只落了让层序门无例外变绿所必需的最小集合，剩下的差距在第三节列明。
4. **reference unit + canonical partition + residual 规则**——第 4 层的分母、第 5 层的关系标注都压在它上面，必须先产出允许嵌套的 `refUnits[]`、由指定构建器生成的无重叠 `partition[]` 与闭合联合的成员资格映射。**已完成（57B-421）**：`facts/units.json` 与七份生产者信封由每次 prepare 无条件写出（成功与失败路径皆然），八个槽位因此翻成 `enforced`；§六 的五条未决在同一片钉掉，落地记录见那一节。双向验收实测通过：wcp 上带索引 / 不带索引两次跑 `partition[]` 字节相同（14,443 个 cell）而 `refUnits[]` 与信封有差（17,717 vs 17,159、`built` vs `unavailable`），构建器不可用时整份信封是 `Unavailable` 而不是更粗的分区。
5. **第 4 层先记录后替换**——直接以 `units.json.partition` 的 canonical RowSet 对今天的种子 / 扩展 / prune / 地板管线产出归属记录 v0，选择范围一个字节不改；不先造文件粒度临时 attribution。此时只增加记录，不改分配机制。
6. **第 5 层的关系标注 v0**——只消费已经存在的 `attribution.json` 席位集与事实自带的成员资格，从第一版就按注册表规则做 id 集合判定；没有 `(path, span)` 降级，也不得直接读取当前 prune graph 冒充第 4 层。消费精度仍先于任何拓宽可达性的机制落地，否则拓宽会放大文件边界的收录伤害。
7. **第 5 层 `ReadSpec` 与第 6 层义务声明**——**已完成（57B-424）**：census v2 只取两份合法 RowSet，`ReadSpec` 只有 path / span / reason / budget，L6 声明只取 requirements / workset / mechanisms / units；模型只读确定、有界且逐节带 source digest 的 `context/workset.md`，本步不执行任何 `ReadSpec`。
8. **第 7 层调查结果与第 8 层封存分片已完成（57B-429/430/433/431/432）。** P18 四级上界与可离线重导的 content store、evidence / timeline / supplement 的 O(N) 单写者流、`ReadSpec` 执行 / 义务处置、completeness 逐域合取与 NotApplicable 前提验证均已落地；epoch 0 → N 以不可变文件追加并闭合 hash chain，封存身份包含 judgement digest 与截断/脱敏策略版本，报告和 draft receipt 绑定 epoch。
9. **最后替换分配算法**——由读数把关的单向门。

每步的验收都是确定性信号（行数、计数器、字节 diff）；召回类主张三跑取均值。任何机制在单一目标上的读数不构成定律——每个机制点名一个形态不同的第二目标。
