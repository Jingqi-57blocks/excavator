# 待裁决清单

> 角色：规划层挂起项账本（见 `docs/development.md` 的 P 节点）。每项由规划层起草，随 feat→main 的 PR（触点一）一并呈给用户裁决；裁决后移除或转入 Linear。

> **本文只留「仍待裁决 / 仍是活约束」的条目。已合入 main 的批次记账（含其残差与「记档不修」清单）迁至
> [`docs/decision-archive.md`](./decision-archive.md)——迁移而非删除：那些是付过学费的读数，只是不再需要裁决。**

## 协调项 · 57B-351 × 57b-329 合同收敛

- **`sides` 需并入 Claim 合同**（57B-351 落地）：本切片给 `SectionClaim` 增补可选字段 `sides?: string[][]`（跨源比较声明的按侧证据分组）。分支 `57b-329` 的 `schemas/` v1 Claim JSON Schema 目前无此字段。两分支收敛时，需在该 Schema 补 `sides`（可选、additive；每组为 `evidenceIds` 的非空、两两不相交子集）。属协调项，非本切片改动。

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

## provital 真跑（Perl/Catalyst，两份中文 overview）暴露的引擎问题（2026-08-16，全部已复核）

首次在 Perl/Catalyst 目标上跑完整 authoring（product 10 章 + engineering 13 章，audit **0 error / 2 warning**，
1102 claim / 141 证据 / 3 trace / 12 次 supplement）。以下每条我都独立复核过，不是转述。

### 一、`claims scaffold` 的产出会被 `audit` 判红——引擎自相矛盾（最严重）

两侧用了**两种不同的规范化**：`substantiveSegments`（scaffold 用）把 `*` **删掉**，
`normalizeText`（`assurance.ts:949`，audit 用）把 `*` **替换成空格**。实测：

```
scaffold statement:  本项目产品名为 CMS3000，其源码自述为内容管理系统
audit 规范化可见文本: … CMS3000 ，其源码 …          ← 逗号前多一个空格
includes() → false → "claim claim-N statement is not present in section N"（error）
```

**只要正文含 `**加粗**` 就复现**，而 `writing-rules.md` 要求「Each chapter uses clear bold lead-ins」——
**两条引擎规则直接冲突**。`claims-scaffold.ts:5-6` 的文档承诺「a scaffold can never drift from
`auditSectionClaims`」对段落覆盖检查成立，对 statement-present 检查**不成立**。
撰写方实测约 30 条同因 error，只能把正文的 `**` 全删掉换绿。

同源第二形态：**marker 后跟非终止标点**。`…写在代码里 \`事实\`：` 规范化后成 `…写在代码里 事实 ：`，
同样失配；marker 后跟 `。`/`；` 才安全。撰写方踩出的纪律「marker 只允许出现在句末且紧跟 `。`」
**不在 SKILL 也不在 writing-rules 里**。

**修法方向**：两处共用同一个规范化函数（这与 §外部调研里「canonicalize 应是一道闸而非各处的便利函数」同型）。

### 二、中文 marker 词表是 4 个精确字面串，且未文档化

`assurance.ts:911-918` 只认 `` `事实` `` / `` `验证` `` / `` `推断` `` / `` `不可得` ``。实测
`` `已验证` `` **不认**（`验证` 前一个字符是「已」不是反引号）、`` `不可用` `` **不认**。
而 writing-rules 说「render naturally in the requested language」——自然本地化会写出 `已验证`/`不可用`，
结果整章被判「has substantive statements but no evidence-level marker」（error）。
`不可得` 中文读起来别扭，但它是唯一被接受的串。**词表须进 SKILL/writing-rules，或放宽为「反引号内含该词」**。

### 三、比较词表里的裸 `/镜像/` 与 `/等价/` 在中文里几乎全是假阳性

`claim-comparison.ts:67-68` 是**裸模式**（同文件 65-66 行那两条要求连接词，这两条不要求）。
`镜像` 在中文里就是 container image，`等价` 常用于语义等价。实测三条假阳性
（「上层镜像把时区固定为 Europe/Vienna」「生产镜像把实例目录做成挂载点」等），
撰写方只能把「镜像」改写成「容器层/容器定义」**牺牲术语准确性换绿**。
**修法**：这两条要求连接词上下文（与 65-66 行一致），或按语言分表。

### 四、「不给出修复建议」这句免责声明本身被 recommendation 闸拦成 error

契约要求 §9「Do not include remediation」，作者自然会写一句声明，而检测器只做正则匹配、
不看否定语境：`recommendation language is not allowed: /修复建议/g`。改写后又因成了新的实质段落
而触发「unclaimed substantive statement」。**修法**：加否定前瞻，或允许章节导语白名单。

### 五、导航层产物不进 evidence catalog → 12 次 supplement 里大半的成因

`native-graph`（1606 Perl 文件 / 6769 subs / 动态派发 37295）与 `framework`（controller 60 /
actions 639 / schema 209）**不在 run 的 evidence catalog 里**，任何引用其数字的断言无法绑定 claim。
撰写方最初写进正文的计数全部要么删掉、要么用 `excavator search` 回执重新取数
（且数字会变：56 而非 70——回执按 `^## Script (Python)` 头计）。
**候选**：prepare 阶段把这两个子命令的产物折叠进 catalog，标 navigation-only、只允许 `推断` 级。

### 六、`reading` 对纯 overview run 无信息量（与 57B-411 同一缺口）

`reading` 返回 `No feature-associated read residual`——overview run 无 feature scope，读义务分母为空。
**这与 57B-411 的 census 只按 feature 建是同一个缺口**：overview 恰恰最该有全局模块视图。
下一片（①③）应把 overview 路径纳入。

### 七、本次形态记录（非缺陷）

CodeGraph 在此目标上**等于零**：11.5% 覆盖、语言只有 JS/Python/YAML/XML、routes 候选空集、
97977 条未解析引用。所有「谁调用谁 / 是否可达」结论靠 source window + 零截断 search 回执建立并标 `验证`。
两份报告的覆盖章已如实写明。**这印证了 native-graph/framework 两个子命令的必要性，不是缺陷。**

### 八、剩余 2 条 advisory 的措辞偏向问题

`condition residual: 20 of 28 …` 逐条看多是「已在角色表整体陈述过的成员判定」与「值已在正文、
但 claim 绑在整句而非单个条件」。当前措辞容易被读成「漏了 20 个业务条件」。措辞应区分
「投资提示」与「覆盖缺口」。

## census 分母继承 snapshot 准入（2026-08-16，57B-411 实测，范围外记账）

模块级范围记账的 census 查询 join `allowed_files`，而该表由 snapshot 的文件集一次性固定。
后果：**只在图里、不在 snapshot 里的文件对 census 不可见**——写 57B-411 的测试时实证到，
往 CodeGraph 插了 `billing/invoice.ts` 节点但没在 target 里建真实文件，census 里就没有 `billing` 行。

这意味着 **`maxFiles` 截断会静默缩小 census 分母**，而那正是 `external-architecture-review.md`
里引的 deepwiki-open 失败形态（规划视图与索引视图共用过滤器、但共用点在过滤之后）。
今天不构成缺陷（census 的诚实边界就是「已索引且在 snapshot 内的模块」），但**若将来把
zero-hit advisory 硬化成闸，必须先让 snapshot 截断本身可见**，否则分母被缩小而闸门照绿。

## 证据 marker 词表有三处定义，语义各不相同（2026-08-16，57B-412 评审指出）

`markersIn`（接受**英文裸词** `\bfact\b`）、`EVIDENCE_MARKER_TOKEN`（只匹配**反引号形态**）、
`EVIDENCE_MARKER_WORD`（`assurance.ts:581` 附近）——同一份词表三处定义、三种语义。
**新增一个 marker 词需三处同步，漏一处就是静默行为差异。**

57B-412 只合并了 segmenter 与 audit 折叠共用的那一处（TOKEN），**没有**动 `markersIn`——
它接受英文裸词，与 TOKEN 语义不同，合并会改 marker 检测行为，属范围外。
合并前须先确定三种语义哪些是有意的。

## segment 去重发生在折叠之后（2026-08-16，57B-412 评审构造，祖父条款）

`substantiveSegments` 用 `new Set` 去重，而去重在**折叠之后**。于是仅装饰不同的孪生句
（`配置项 on\`off\`切换 …。配置项 on off 切换 …。`）在 legacy 折叠下折成同一字符串被合并——
当代 2 个 segment、legacy 1 个。

**不是新开的洞**：旧 `normalizeText` 就是 legacy 折叠，主线两侧同折叠、同去重，本来就接受这个形状。
**明确不修**：加「换代不得减少 segment 数」的前置约束会把主线本来绿过的归档 section 强推回当代判定
而翻红，恰好破坏本修复要保的后向兼容。已钉成有记录的代价测试。

**我在这里犯的错值得单记**：我曾把「segment 数与世代无关」当成**可证的安全性质**钉进测试，
论证只覆盖了 `semanticLength` 过滤（那确实与世代无关），**漏了折叠后去重这一步**；测试全绿
仅因夹具恰好避开碰撞。**把假性质当证明钉下来，比什么都不钉更糟。**

## 测试里的墙钟断言在 CPU 争用下假失败（2026-08-16，范围外记账）

`tests/run.test.ts:191`「a timed-out checkpoint keeps the section it was given」断言
`elapsed > 5ms`，实测在并行跑差分脚本/多 agent 时报 `9ms > 5ms` 假失败；同类还有
`redaction-business-evidence.test.ts` 的 `< 5000ms` 线性性能断言。**今日出现 4 次**，
每次都要重跑一遍才能确认是否真失败——它污染的是「测试失败如实报告」这条纪律的信号。

修法候选：① 把绝对墙钟阈值换成「相对同一次运行内的基线倍数」；② 标记为串行执行；
③ 用注入的时钟替代真实计时。**不在本片顺手改**（CLAUDE.md：范围外不顺手修改），记此备后续。

## 删章必扫交叉引用（教训，2026-08-13）
从报告删除某章（如 provital 删 §13 DB）后，正文里对该章的**交叉引用会悬挂**（provital §7 残留 "see section 13 for the pointer"，指向已删章）。删章不是只切那一段——**必须 grep 全文 `section N`/`§N`/`chapter N`/章名 交叉引用并一并修**。将来做 57B-382 收尾（从 engineering-overview 模板移除 §13）时，模板/写作规则里若有对 DB 章的交叉引用也要同步清；自动化删章逻辑应内建"扫并修交叉引用"。
