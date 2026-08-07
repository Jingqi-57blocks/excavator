# 待裁决清单

> 角色：规划层挂起项账本（见 `docs/development.md` 的 P 节点）。每项由规划层起草，随 feat→main 的 PR（触点一）一并呈给用户裁决；裁决后移除或转入 Linear。

## 2026-08-06 · 批次 A 评审产生

1. **证据 ID 扫描器的边界语义**（PR #7）：修复后，"以分隔符结尾且不在证据目录中的 token"完全不再产生 finding（修复前会产生一条伪 ID 假错误）。若希望此类 token 仍以截短形式被报出，需把 lookahead 放宽为 `(?![\p{L}\p{N}_])`。当前判断：接受现状——消除伪 ID 级联的收益大于目录外 typo 静默的损失。留此备选。

2. **脱敏逻辑变更 × 历史 run 重审**（PR #8 范围外发现）：`auditEvidenceCatalog` 将存档摘录与**当前**脱敏结果逐字比对，因此任何脱敏变更都会让升版前的历史 run 在重审时报 `stored excerpt does not match`。可选：版本感知比对 / 迁移工具 / 记录为已知限制。与批次 C 的"证据层级检查统一"（同样使存量掉绿灯）性质相同，建议合并为一次"存量兼容策略"裁决。

3. **grant_type 类同行过度脱敏**（PR #8）：兜底规则不区分键值位——敏感词出现在值位时，同行的非敏感键名字面量（如 `"grant_type"`）会被一并脱敏。fail-closed 方向，已用测试钉住。消除需引入键值配对解析，暂不做。

## 2026-08-07 · 批次 E 评审产生

4. **`FACT-*` 前缀不在伪 ID 扫描集**（PR #10 范围外发现）：`evidenceIdsInSection` 的正则前缀集为 `S|CG|FG|GIT|SEARCH|SCOPE|PROVIDER`——目录内的 `FACT-*` 引用能被识别，但章节中引用**不存在**的 `FACT-*` 不会被判为伪 ID。归批次 C 审计对账一并处理（与"枚举章节行数对账"同域）。

## 2026-08-07 · Wave 0 演示实测产生

5. **特征作用域漏"接口实现/第三方封装"，且 node-cap 装噪声挤出核心文件**（Wave 0 leave 实测，范围外发现）：
   - 演示实测在正确的 5 根目标（`excavator-test-repos/wcp`）上跑 leave/engineering，用 gold 真值集（84 项，developer mustFind 66 条）对账。**改造本身验证有效**：预算派生生效（`maxGraphQueries=140`、`maxSourceWindows=300`、`maxFeatureNodes=220`）；事实包对每类目自曝 `incomplete/truncated` 警告（coverage-honesty 生效）；作者代理顺警告用 `source`/`search` **投研补回 25 条**（数据模型 `model/leave.go`、状态常量 `constant/leave.go`、`service.go` 里 9/11 状态迁移、校验、异常）——"事实包起点 + 源码兜底投研"模型成立。
   - **缺口不是"边界太宽"泛论，而是三处精确盲区**（严格召回 29/66=44%，另 ~10 条 gold 证据为目录级、精确行匹配给不了分，语义召回更高）：
     - **①接口→实现（DI 接线）**——主因：`brdg_impl.go`（1184 行，独占 7 条）、`approvement.go`（1 条）**从未被打开**。代理到达接口 `brdg_abst.go` 与编排 `service.go`，但无静态调用边穿透到具体实现，审批路由/额度规则/副作用尽在此。
     - **②第三方封装**：`third_party/{ses,cron,s3}.go`（5 条，集成/激活）。
     - **③跨仓 Node 内部 + 兄弟子模块**：`wcp-service/services/notificationService.js`（2 条）、`leaveHistory/*`（2 条）。
   - **噪声挤占佐证**：entrypoints=405 被单个 `handlers.go` 路由表灌满（item[0..2]=`POST /forgot-password`、`GET /token`、`GET /*any`，皆非请假），220 node cap 先被噪声（auth oauth2、通用 UI）占满。
   - 缺口按成因分三类（避免误判缓解手段）：**作用域漏**（文件根本没进 scope）——`brdg_impl.go`+`approvement.go` 共 8 条，目录同胞纳入可补；**窗口漏**（文件已在 scope、代理已打开，但没窗到 gold 那几行）——`router.go` 3、`service.go` 2、`brdg_abst.go` 3、`constant/leave.go` 1，需覆盖深度/窗口引导，非作用域问题；**跨边界解析漏**——`third_party/{ses,cron,s3}`、`notificationService.js` 共 7 条，需跨调用解析（Phase 2）；余为目录级 gold（匹配器给不了分）。
   - 处置：中期解法归 **Phase 2 目标解析**（按模块边界，非目录/图节点）。短期缓解待裁决，按性价比排序：(i) **目录同胞纳入**——scope 命中 `leave/router.go` 即拉全 `internal/handlers/leave/*.go`，近零成本把 `brdg_impl.go`/`approvement.go`（8 条）纳入作用域，**若代理随后窗读并引用**，严格召回预计 44%→~56%（29→37）；(ii) 为接口补"查实现（implementors）"导航查询；(iii) 检测到 `truncated` 时抬高/派生 `maxFeatureNodes` 并优先 feature 相关节点。**不当场设计**。
   - 与本演示解耦：脱敏/预算/事实包三项正确性修复已评审已测试，本演示只是加分证据；上述盲区另立 issue，不阻塞触点一合并。
