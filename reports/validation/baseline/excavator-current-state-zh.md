# Excavator 修改前现状报告

> 基线日期：2026-08-05  
> 基线自动化测试：42/42 通过  
> 基线代码：可选 CodeGraph Provider 已实现，但尚未引入 WorkItem、Trace、Append-only Timeline 和完整 Provider Registry。

## 1. 执行模型

基线版本会建立 Git-aware 源码快照，按需打开 CodeGraph SQLite 数据库，生成共享项目 Context 和可复用的 Feature Context，再为不同受众创建英文写作 Prompt。源码是最终事实来源，CodeGraph 只用于导航。

已有主要产物：

- `snapshot.json`：源码与忽略规则边界；
- `evidence.json`：源码、图、搜索和派生证据；
- `checklist.json`：调查假设及最终处置；
- 章节 Markdown checkpoint；
- 章节级 claims 文件；
- `run.json` 和 `metrics.json`；
- Markdown 报告与 `audit.json`。

## 2. 已有质量控制

基线审计已经能够拒绝：

- 重复或缺失 Evidence ID；
- Evidence 属于其他 snapshot；
- 非法源码路径、行号或失效 digest；
- 实质报告文本没有 claim；
- claim 引用不存在的证据；
- 未完成的调查清单；
- 没有完整零命中搜索回执的 `searched-not-found`；
- 没有限制证据的 `cannot-determine`；
- 当前状态报告中的建议和修复语言。

## 3. 已有恢复与效率能力

- Shared Context 和 Feature Context 按 snapshot 缓存；
- 多受众复用同一 Feature Scope；
- 搜索回执和源码窗口缓存；
- 相邻或重叠源码窗口合并；
- 快速重复执行不会覆盖旧运行目录；
- 章节原子 checkpoint；
- 子进程被强制终止后从首个未完成章节恢复；
- CodeGraph 自动发现、显式指定或明确禁用。

## 4. 基线限制

### 4.1 调查覆盖主要在写作后审计

`checklist.json` 在准备阶段创建，但没有把负责人、受影响文档、执行状态、开始/完成时间和流程依赖建模为第一等工作项。

### 4.2 Claim 没有完整流程对象

Claim 可以引用局部 Evidence，但没有独立的调用流、业务流、状态流、数据流或跨仓库 Trace。局部源码能够证明某一步，不一定足以证明段落描述的完整流程。

### 4.3 运行历史不是 append-only

`run.json` 和 `metrics.json` 只表示当前状态和聚合指标，不能回放搜索、源码读取、checkpoint、更正、超时、恢复和审计的历史顺序。

### 4.4 Provider 状态是瞬时信息

可以看到有效 CodeGraph 路径和覆盖率，但没有持久化 Provider 的能力、选择原因、数据库身份、CLI 状态和失败原因。

### 4.5 修订会替换当前文件

旧章节和旧 claims 没有统一历史目录，不能重建结论为什么发生变化。

## 5. 基线报告

- `generated/wcp-product-overview-baseline.md`
- `generated/wcp-leave-engineering-baseline.md`

两份报告内容较长，但机器可审计能力主要停留在章节 claims 和 checklist；覆盖计划、完整流程和修订历史没有独立伴随文件。
