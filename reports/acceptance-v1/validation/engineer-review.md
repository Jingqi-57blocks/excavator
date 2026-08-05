# 技术人员角色验收

## 验收目标

以开发者和技术负责人身份，检查报告除业务行为外，是否覆盖仓库和 runtime、技术栈、路由与调用方、控制流、状态与一致性、认证授权、数据库模型、事务、文件和外部通信、错误与部分成功、配置和任务、依赖范围、测试及当前技术问题。

## 结果

- 工程报告：**7/7 通过**。
- 平均质量得分：**99.3/100**。
- 显式源码路径引用：**13/13 报告全部存在，行号范围有效**。
- 高风险和关键数字源码断言：**75/75 通过**。

| 报告 | 大小 | 行数 | 表格 | Mermaid | 得分 | 结果 |
|---|---:|---:|---:|---:|---:|---|
| `01-wcp-engineering-overview.md` | 22,352 B | 280 | 4 | 1 | 100.0 | 通过 |
| `02-leave-engineering.md` | 22,954 B | 322 | 14 | 2 | 100.0 | 通过 |
| `03-worklog-engineering.md` | 18,176 B | 272 | 1 | 3 | 95.0 | 通过 |
| `04-billing-engineering.md` | 11,037 B | 201 | 6 | 3 | 100.0 | 通过 |
| `05-performance-engineering.md` | 8,668 B | 175 | 3 | 3 | 100.0 | 通过 |
| `06-recruitment-engineering.md` | 8,338 B | 171 | 4 | 3 | 100.0 | 通过 |
| `07-identity-engineering.md` | 8,983 B | 181 | 3 | 3 | 100.0 | 通过 |

## 技术判断

- Overview 覆盖五个 Git root、React/Vite、Node/Express/Sequelize、三套 Go/Gin/GORM 服务、MySQL、OAuth2、共享数据和外部依赖。
- 请假覆盖 14 个请假 API、4 个额度 API、十类假期、九个状态、四级审批、额度 transaction、附件、LATAM 任务和新旧实现。
- 工时覆盖 Node CRUD、Go 聚合/账单、两套 ORM、软删除、Jira、Slack、SES、导出和快照。
- 账单覆盖 Billing/Invoice 双状态机、row lock、折扣、人工账单、Bill.com、文件和事务后通知。
- 绩效覆盖独立服务、公开客户 key、阶段映射、对象权限、远程 auth、cron 和通知。
- 招聘覆盖 project-space/resource-pool、职位 transaction、多套候选状态、S3、Beisen、AI 和客户分享边界。
- 身份覆盖 OAuth2 授权码、PKCE、JWT、client/redirect、consent、配置和业务服务授权交接。

## 调试中发现并修正的事实

1. 绩效权限 helper 的实际名称是 `CheckIsMROfUser`，报告已按当前源码修正。
2. 当前请假路由是 14 个 `/v2/leaves` 入口和 4 个 `/v2/holidayhour` 入口。
3. 拉美 PTO 生产常量的全职提醒阈值是 166，而 `alert_test.go` 当前使用 200；报告把该矛盾列为请假当前问题。
4. 尝试运行 `go test ./internal/tasks/latam_pto` 时，隔离环境需要下载 Go 1.23.10 toolchain，因网络不可用而阻塞；没有把该测试写成通过。

## 第一版允许的小问题

- CodeGraph 对工时、请假、账单、招聘和身份均达到 500 节点上限，范围存在泛词噪声；报告通过直接源码断言收紧语义。
- 本轮对 13 份报告使用独立验收 harness，而没有为每份报告建立完整的 Excavator claims/workitems/timeline authoring run。
- 未安装 WCP 依赖、未启动服务、未连接数据库或外部系统；运行时性能和数据质量不在通过结论内。
- WCP 自身自动化测试没有全面执行；通过结论指向报告生成与静态事实准确性，不等于 WCP 业务代码测试全部通过。
## 目标问题归因检查

目标项目的风险/当前问题章节只保留可归因于 WCP 源码、测试或文档的现状。CodeGraph、Excavator、未解析关系、源码回退和静态审阅限制仅出现在覆盖章节或验收报告；本轮检查为 0 处混入。

