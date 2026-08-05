# Excavator 全面验证报告

> 验证日期：2026-08-05  
> Node.js：22  
> 目标：验证报告准确性、完整性、恢复能力、Provider 可选性与性能。  
> 真实工作区：WCP 五个 Git 仓库，2,007 个 Git-aware 候选文件。

## 1. 结论

本轮通用代码、真实工作区准备和最终报告审计均通过：

- 自动化测试：**49/49 通过**；
- 最终 Overview：10/10 章节完成；
- 最终请假工程报告：12/12 章节完成；
- WorkItems：23/23 完成；
- Claims：85 个，全部绑定报告文字；
- Traces：5 条 verified Trace、25 个步骤；
- 最终审计：**0 errors / 0 warnings**；
- Timeline：75 条事件，哈希链有效；
- 最终报告没有建议/修复措辞，也没有检测到敏感值赋值。

报告通过当前静态分析验收，但不宣称证明运行时、部署环境或工作区外系统行为。

## 2. 测试范围

### 2.1 通用自动化测试

49 项测试覆盖：

- Overview、单功能、多功能和组合请求；
- 产品与工程受众；
- 英文 Skill/Prompt 与非英文报告输出；
- Git-aware 文件边界、嵌套 ignore、多仓库规则和 OS 垃圾文件；
- `.env` 排除和安全环境模板；
- CodeGraph 自动发现、显式禁用、显式数据库、status 和 build delegation；
- CodeGraph 与源码 manifest 交集；
- source-only 回退；
- Shared/Feature Context 缓存和零重复读取；
- 搜索回执、源码窗口合并和缓存版本隔离；
- Evidence 路径、行号、digest 和 snapshot；
- Claims、WorkItems、Traces 和 companion files；
- Timeline 篡改检测；
- 章节修订历史；
- 超时、真实 `SIGKILL` 和 resume；
- HTML 动态导航与资源输出；
- Unicode、Scope 和 Provider Evidence ID。

总运行时间约 **4.81 秒**。

### 2.2 真实工作区 Provider 对比

相同请求分别使用 CodeGraph 和完全源码模式，每种模式执行三次冷运行和对应暖运行：

- 产品 Overview；
- 工程请假报告 Context；
- 相同 WCP snapshot 和预算。

### 2.3 最终报告验证

最终报告使用 CodeGraph 导航并逐问题回退源码。额外检查：

- 2,007 个候选文件中的请假/假期测试声明搜索；
- 高风险结论源码复核；
- 双实现与共享表映射；
- 创建、审批、拒绝、撤销、通知、导出和配置路径；
- 角色、对象级授权和静态不可回答项；
- 报告正文、Claim、Evidence、Trace 和 WorkItem 一致性。

## 3. 准确性结果

### 3.1 机械完整性

- Evidence 均属于 snapshot `93d5c4e1bea65591c080`；
- 源码 Evidence 路径、行范围、redacted excerpt 和 SHA-256 digest 有效；
- 74 个 fact Claim、1 个 verified Claim、10 个 unavailable Claim；
- **0 个 inferred Claim**；
- 每个 fact/verified Claim 都引用存在的 Evidence；
- 每个正文实质陈述都被 Claim 覆盖；
- unavailable Claim 不伪造 Evidence，并说明静态范围限制。

### 3.2 人工语义复核

人工逐章检查最终报告，并打开关键业务规则、权限、事务、模型、通知、导出、旧服务和固定字面量源码窗口。复核产生两次收紧：

1. 将“多个代码写入方”改为源码可直接证明的“多个服务实现映射相同业务数据形状”；
2. 删除没有直接调用证据的“供管理计算使用”，保留“简化请假区间接口”。

修订前版本保存在 `history/`，重新组装后审计仍为 0 错误。

### 3.3 真实审计缺陷

首次审计错误地认为 Unicode Feature ID、`SCOPE-*` 和 `PROVIDER-*` 没有出现在 evidence block。根因是固定 ASCII 正则。修复后审计使用 Evidence catalog 精确匹配，并增加回归测试。

这证明真实报告验证能够发现 synthetic fixture 没覆盖到的通用问题。

## 4. 完整性结果

### 4.1 WorkItem 处置

| 状态 | 数量 |
|---|---:|
| found | 18 |
| searched-not-found | 1 |
| cannot-determine | 4 |
| pending / in_progress | 0 |
| 总计 | 23 |

项目级调查包含固定敏感字面量、固定业务 ID、权限极性、共享存储、重复入口、未调用入口、错误处理、未完成行为、功能开关、文档漂移、事务内外部副作用和开放问题。

请假级调查包含功能边界、入口和主流程、授权、验证与限制、状态生命周期、数据、外部副作用、失败模式、配置、测试和开放问题。

### 4.2 Trace 覆盖

已验证 Trace：

- 项目组成边界；
- 请假创建；
- 请假审批；
- 请假撤销；
- 请假通知与导出副作用。

共 25 个步骤，每个步骤关联 Evidence。

### 4.3 测试覆盖搜索

对 2,007 个候选文件执行 Go、JavaScript 和 TypeScript 请假/假期测试声明搜索：

- candidate files：2,007；
- matches：0；
- truncated：false。

因此报告写成“没有定位到匹配的业务测试用例”，而不是“项目没有测试”。

### 4.4 CodeGraph 与源码召回差异

| 指标 | CodeGraph | Source only |
|---|---:|---:|
| 请假边界文件 | 96 | 8 |
| 图节点 | 260 | 0 |
| 图关系 | 273 | 0 |
| Evidence items | 47 | 30 |
| Shared Context | 73,137 B | 47,713 B |
| Feature Context | 108,198 B | 13,725 B |

纯源码模式找到直接关键词文件；CodeGraph 进一步找到了前端调用、旧服务、通知、导出、工时、账单和后台任务等关系。CodeGraph 对 1,726 个可索引源码文件覆盖 1,639 个，覆盖率 **94.96%**；未索引位置仍由源码回退。

## 5. 性能结果

### 5.1 三次冷暖对比

| 指标 | CodeGraph | Source only |
|---|---:|---:|
| 冷运行 ms | 881 / 846 / 751 | 609 / 745 / 659 |
| 冷运行中位数 | **846 ms** | **659 ms** |
| 暖运行 ms | 236 / 244 / 202 | 215 / 282 / 277 |
| 暖运行中位数 | **236 ms** | **277 ms** |
| 冷运行图查询 | 13 | 0 |
| 冷运行源码窗口 | 40 | 27 |
| 冷运行源码字符 | 53,938 | 49,234 |
| 暖运行图查询 | 0 | 0 |
| 暖运行源码窗口 | 0 | 0 |

结论：

- Source-only 冷准备更快、更轻；
- CodeGraph 冷准备增加关系召回和后续源码确认；
- 两种模式暖运行都没有重复图查询或源码读取；
- CodeGraph 是召回/导航 Provider，不是保证提速的缓存层。

### 5.2 最新真实 smoke

四文档计划（产品与工程 Overview、请假产品与工程）验证：

- CodeGraph cold prepare：856 ms；warm：256 ms；
- 真正 source-only cold prepare：856 ms；warm：254 ms；
- 两者暖运行 graph queries=0、source windows=0；
- source-only 通过 `EXCAVATOR_NO_CODEGRAPH=true` 显式验证。

测试过程中发现原 smoke 工具没有显式关闭自动发现，导致最初的“源码模式”仍使用 DB；测试工具已修正。

### 5.3 最终产物阶段

- 报告组装：约 **0.18 秒**；
- 最终审计：约 **0.45 秒**；
- 两页 HTML 构建：约 **0.07 秒**。

`run.json` 的总墙钟时间包含人工源码复核、Evidence 补充、语义修订和多次审计，不作为模型自动写作性能基准。当前环境没有独立、可重复的模型 API authoring benchmark，因此本报告不声称验证了不同模型的生成延迟。

## 6. 恢复与历史结果

- synthetic fixture 中真实子进程 `SIGKILL` 后，从第一个未完成章节恢复；
- 完成文档修订不会复用过期 author timer；
- 快速重复运行生成不同 run directory；
- 最终 WCP Timeline 75 条，hash chain 有效；
- 两次语义修订生成四个 history 文件；
- 当前报告重新组装和审计后状态为 complete。

## 7. 安全与通用性检查

- 产品代码和 Skill 中未加入 WCP 特定路径、ID 或业务规则；
- 测试中的“请假管理”只是通用多语言功能名；
- 最终报告未出现建议、推荐、修复建议或下一步措辞；
- 未检测到 API key、password、private key 或 AES key 的实际赋值；
- 固定密钥只报告“存在固定字面量”，不暴露值；
- `.DS_Store`、Apple resource fork、`Thumbs.db`、真实 `.env`、证书和工具目录仍在固定排除边界中。

## 8. 最终产物

- `generated/wcp-product-overview-final.md`
- `generated/wcp-leave-engineering-final.md`
- `generated/html/`
- `generated/companions/`
- `generated/audit.json`
- `generated/run-summary.json`
- `provider-comparison-summary.json`

## 9. 已知边界

- 静态分析不能确认生产流量、实际启用任务、数据库实例和约束、消息送达、对象存储 ACL、历史数据质量或工作区外调用方；
- CodeGraph 是有损索引，94.96% 覆盖不等于语义完整；
- Source-only 当前 Feature fallback 更依赖词汇命中，复杂跨文件功能的召回明显低于 CodeGraph；
- 机械审计能证明证据链和覆盖账本一致，不能替代人对源码语义的判断；
- 最终报告是 snapshot 当前状态，不是运行时验收报告。
