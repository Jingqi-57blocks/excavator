# Excavator 修改前后对比

> 基线与最终 WCP 报告使用了不同 scanner/snapshot 标识，因此内容差异不能全部归因于代码改造。下表主要比较保证机制和可审计性。

| 维度 | 修改前 | 修改后 |
|---|---|---|
| 自动化测试 | 42/42 | 49/49 |
| 分析范围 | snapshot + request | 独立 `analysis-scope.json` |
| Provider 状态 | 路径与聚合覆盖 | 完整 `provider-status.json` |
| 调查计划 | checklist，主要用于事后审计 | 写作前 `workitems.json`，含状态和受影响文档 |
| 流程证明 | 局部 Evidence + Claim | Evidence → Claim → Trace |
| 运行历史 | 当前状态与聚合 metrics | 哈希链 `timeline.jsonl` |
| 章节更正 | 替换当前文件 | `history/` 保存旧章节和旧 claims |
| 报告伴随文件 | 无统一 companion 目录 | Claims / Coverage / Traces |
| Evidence ID | 依赖固定 ASCII 模式 | 精确 catalog 交集 + Unicode ID 支持 |
| CodeGraph | 可选导航 Provider | 可选导航 Provider + Registry/选择原因 |

## 报告表现

| 指标 | 基线 Overview | 最终 Overview | 基线请假 | 最终请假 |
|---|---:|---:|---:|---:|
| 章节 | 10 | 10 | 12 | 12 |
| Markdown 字节 | 27,935 | 6,518 | 19,150 | 8,837 |
| `事实` 标记 | 41 | 31 | 65 | 43 |
| `推断` 标记 | 15 | 0 | 3 | 0 |
| `不可得` 标记 | 8 | 4 | 10 | 6 |

最终正文更短，不代表调查维度更少。覆盖信息被移入 WorkItems、Claims 和 Traces companion files：

- 85 个 Claim；
- 23 个 WorkItem，全部完成；
- 5 条 Trace、25 个步骤；
- 75 条 Timeline 事件。

## 主要变化

1. **从“内容多”转向“结论可追踪”。** 最终报告减少解释性推断，每个实质事实都有精确 Evidence ID。
2. **从事后 checklist 转向事前覆盖计划。** 23 个调查维度必须逐项处置。
3. **从局部引用转向流程证据。** 创建、审批、撤销、通知和项目边界都有 Trace。
4. **从覆盖当前状态转向保留历史。** 两次人工修订没有覆盖旧文件。
5. **从 Provider 隐式选择转向可审计选择。** 能确认某次运行为何用了或没有使用 CodeGraph。

## 仍然保留的取舍

- 产品 Overview 最终版更紧凑，适合快速阅读，但不再包含基线版的大量解释性段落和图表。
- 完整技术细节位于工程报告和 companion files。
- CodeGraph 提高跨文件和跨仓库召回，但增加冷运行 Context 和源码确认成本。
