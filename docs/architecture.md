# Excavator 架构与 src/ 职责地图

> 目的：让"每个文件负责什么、数据怎么流"一眼可见。方向与阶段护栏见 `direction.md`，开发流程见 `development.md`。

## 一、是什么

Excavator = **确定性 Core（`src/`）+ AI 撰写层（`skills/excavator/` 技能 + agent）**。

- **Core**：零 npm 运行时依赖、零模型调用、Node ≥22.5 直跑（type-stripping）。负责**记录与校验**——固定源码快照、抽取确定性事实、绑定证据、执行审计。
- **AI 层**：模型按 SKILL 通过 Core 的 CLI 驱动调查与撰写。负责**推理与表达**。

这条分工是"报告可辩护/可审计/可复现"的根：一切最终事实都能追回源码，模型的自由只在语言表达层。

## 二、一次 run 的数据流

```
prepare   → 快照 + 共享上下文 + per-feature scope + 事实包 + cross-feature
authoring → 逐文档：begin → search/source 取证 → checkpoint(claims) → workitem → trace
assemble  → reports/ (+ claims/traces/coverage companions)
audit     → 校验整条保证链
```
全过程事件 append 进哈希链 `timeline.jsonl`；`metrics.json` 记计数与耗时；run 落在 `<workdir>/<project>[-<hash>]/runs/<run-id>/`。

## 三、保证链（Assurance）

```
Analysis Scope → Investigation WorkItem → Evidence → Claim → Trace → 报告段落/表格行
```
`audit` 是**硬闸**：证据存在+digest 匹配+被章节引用、标记齐（fact/verified/inferred/unavailable）、material flow 有 verified trace、快照/provider 身份不漂移、timeline 哈希链完整。`ASSURANCE_VERSION` 对严格检查升级做**版本门控**，历史 run grandfather。

## 四、src/ 职责地图（23 文件 / ~6000 行）

### 编排 / 共享基础
| 文件 | 职责 |
|---|---|
| `run.ts` | **运行生命周期编排**：prepareRun / searchSourceEvidence / 有界 source / checkpoint / workitem / trace / assembleRun / auditRun / resumeRun / runStatus。串起整条流水线 |
| `cli.ts` | CLI 命令分发 + 参数解析（prepare/report/overview/feature/begin/search/source/checkpoint/workitem/trace/assemble/audit/resume/status/codegraph/help） |
| `types.ts` | 全局类型（ReportRequest / PreparedContext / SectionClaim / Evidence / Trace / WorkItem / ChecklistItem …） |
| `util.ts` | 通用助手：哈希、slugify、`projectWorkspace`（per-target 目录）、`nowIso`、`runIdTimestamp` |
| `budgets.ts` / `defaults.ts` | 预算常量（maxFeatureNodes 等） / `DEFAULT_WORKDIR`（`.work`） |

### 快照 & 源码
| 文件 | 职责 |
|---|---|
| `snapshot.ts` | 快照身份：文件扫描、忽略规则、digest；固定源码边界 |
| `source.ts` | 源码 provider：快照内搜索（`search`）+ 有界源窗（`source`）+ `TEXTUAL_EXTENSIONS` + `selectProjectDocuments` |
| `document-scoring.ts` | 项目文档选材打分（契约面优先、README 降权） |
| `workspace-residue.ts` | 旧 workdir 布局残留告警 |

### 上下文 & 事实
| 文件 | 职责 |
|---|---|
| `context.ts` | **上下文构建**：共享上下文 + per-feature scope + 事实包编排 + cross-feature 接线；产出 `PreparedContext` |
| `factpack.ts` | 确定性事实包（entrypoints/entities/states/config-keys/jobs/external-calls 六类枚举 + coverage/truncation） |
| `cross-feature.ts` | 确定性跨功能关系（共享文件/实体/配置键集合求交，零模型） |

### CodeGraph（可选导航索引）
| 文件 | 职责 |
|---|---|
| `codegraph.ts` | `GraphReader` 接口 + `CodeGraphIndex`（单库）+ 查询面 |
| `codegraph-set.ts` | `CodeGraphSet`：per-module 多库扇出（输出层无法表达跨模块边） |
| `codegraph-command.ts` | `codegraph build/status` + per-module 库路径解析 |
| `module-detection.ts` | module 边界探测（go.mod / package.json；叶子 marker、≥2 才拆） |
| `providers.ts` | provider 选择（source / codegraph，单库 vs 多库） |

### 保证链（Assurance）
| 文件 | 职责 |
|---|---|
| `assurance.ts` | **审计引擎**：`ASSURANCE_VERSION`、`auditRun` 各检查、checklist、workitems、traces、claims、事实包对账、可读性 advisory、`substantiveSegments`、`markersIn` |
| `assurance-artifacts.ts` | `analysis-scope` 等保证工件构建 |
| `claim-comparison.ts` | 比较 claim 忠实性（`sides` 结构校验 + 比较词表 advisory） |
| `claims-scaffold.ts` | `claims scaffold` stub 生成（复用审计同款分段） |
| `timeline.ts` | append-only 哈希链时间线读写 |

## 五、Core 之外

- **`packages/excavator-html`**：最终 Markdown 报告 → 静态 HTML 站。独立工具，**只读 `reports/`**，不碰 Core 缓存/证据/源码；默认输出 `<run>/html-reports/`。
- **`eval/`**：确定性 knowledge-diff 评测 harness（run 工件 → 归一化 Knowledge → 对照 `expected-knowledge.json` 语义 diff）。**不属 Core 运行时**；可用 dev/eval 工具，但不得进 `src/`。

## 六、硬约束（改动前必读）

- Core（`src/`）**零 npm 运行时依赖、零模型调用**；外部能力（CodeGraph、未来 Tree-sitter/FTS5 索引）走"外部程序 + 产物文件"，隔在 Core 之外。
- 所有检查表达为**框架无关不变式**（禁目标名/路由/表硬编码）；测试用合成夹具。
- `skills/**` 只英文（CJK 词表只能进 `src/`）；新硬门走 `ASSURANCE_VERSION` 版本门控。

## 七、已知结构债（跟踪中）

- `run.ts` / `assurance.ts` / `context.ts` 各 ~700–780 行，占近半代码；进一步按职责拆分随 **57B-359 调查/撰写解耦**重塑边界时顺势做（见 **57B-361** src/ 子目录重组）。
