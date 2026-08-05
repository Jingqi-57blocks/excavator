# Excavator 修改后现状报告

> 验证日期：2026-08-05  
> 自动化测试：49/49 通过  
> 真实工作区：五个 Git 仓库、2,007 个 Git-aware 候选文件。

## 1. 当前执行模型

Excavator 现在以源码 Provider 为强制事实来源，并把 CodeGraph 作为完全可选的导航 Provider：

```text
Request
→ Analysis Scope
→ Provider Registry
→ Snapshot
→ Investigation WorkItems
→ Shared / Feature Context
→ Evidence → Claim → Trace
→ Section checkpoints
→ Report + companion files
→ Audit
```

CodeGraph 不存在或被禁用时，运行自动进入 source-only；`codegraph build` 只调用用户已经安装的 CodeGraph CLI，不主动安装软件。

## 2. 新增保证机制

### 2.1 Analysis Scope

每次运行持久化 `analysis-scope.json`，记录：

- snapshot；
- Git-aware 文件边界；
-报告、受众和功能范围；
-输出语言；
-Provider 选择；
-预算和禁止运行目标代码等约束。

“完整性”因此被限定为特定 snapshot、范围、Provider 和预算下的完整性，而不是无边界声明。

### 2.2 Provider Registry

`provider-status.json` 记录源码和 CodeGraph Provider 的：

- available / selected；
-选择原因；
-能力列表；
-数据库路径和 digest；
-CLI 是否存在；
-源码 manifest 与 ignore digest。

### 2.3 Investigation WorkItems

`workitems.json` 在写作前生成项目和功能调查计划。每一项必须完成为：

- `found`；
- `searched-not-found`；
- `cannot-determine`；
- `not-applicable`。

物质性的入口、生命周期和副作用工作项必须关联 Trace。

### 2.4 Evidence → Claim → Trace

Evidence 仍绑定 snapshot、路径、行号和 digest；Claim 绑定报告中的实质陈述；Trace 描述业务流、调用流、数据流、状态流或跨仓库路径。

本次 WCP 最终运行包含：

- 85 个 Claim；
- 5 条 verified Trace；
- 25 个 Trace 步骤；
- 23/23 个已完成 WorkItem。

### 2.5 Append-only Timeline

`timeline.jsonl` 使用 previous digest 形成哈希链，记录：

-准备；
-源码窗口和搜索；
-WorkItem/Trace 更新；
-checkpoint 与修订；
-组装和审计；
-恢复与超时事件。

最终 WCP 运行有 75 条事件，哈希链审计通过。

### 2.6 修订历史

章节再次 checkpoint 时，旧 Markdown 和旧 claims 进入 `history/`。本次人工语义复核收紧了两处措辞，产生了四个历史文件并保留更正轨迹。

### 2.7 Report companion files

每份报告同时生成：

- `*.claims.json`；
- `*.coverage.json`；
- `*.traces.json`。

用户可见 Markdown 保持紧凑，机器审计信息不需要全部堆进正文。

## 3. 审计能力

当前审计除基线规则外，还会拒绝：

- WorkItem 未完成或缺少必要搜索回执；
- 物质流程没有 Trace；
- Trace 引用不存在的文档、Evidence 或 Claim；
- Timeline 被修改、断链或顺序错误；
- Scope 或 Provider Registry 与 run manifest 不一致；
- Claim 声明 Evidence，但正文 evidence block 未引用；
- Unicode 功能名、`SCOPE-*`、`PROVIDER-*` 等 Evidence ID 解析错误。

最后一项是在真实 WCP 报告审计中发现并修复的通用缺陷。

## 4. 结果边界

这些控制能够证明：

- 报告文字、Claim、Evidence、Trace 和覆盖账本之间可反向追踪；
- 源码引用仍属于当前 snapshot；
- 规定调查维度没有被静默跳过；
- 无法确定的内容被显式标记。

它们不能单独证明：

- 运行时行为与静态源码完全一致；
- 外部仓库、网关、数据库约束和部署配置不存在；
- LLM 对源码语义的理解绝对无误。

因此最终验收仍包含人工源码复核，高风险结论不能只依赖机械审计。
