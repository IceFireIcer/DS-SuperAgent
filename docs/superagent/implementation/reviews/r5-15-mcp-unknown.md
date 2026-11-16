# R5-15 MCP unknown：本地双轴自检

固定基线 `3fa3672`；规格是 #107 与 `docs/superagent/spec-r5.md` D06/D12/D13、A18/A21；规范是 `AGENTS.md` 与 `CONTRIBUTING.md`。当前没有可调用的并行审查子代理，本记录仅是本地双轴自检，不冒充独立审查。

## Standards

两种数据库沿用现有 `Storage` 事务协议和共享 `RecordKind` 白名单，没有新表、DSH 补丁、真实密钥、用户 DSH 数据或产品 UI 改动。调用请求的原文仅在内存和原 MCP 请求内，数据库及错误只保留安全身份、SHA-256 与固定错误码。先行 CI 等待条件修复独立提交。Node 24 定向 6/6、typecheck、改动文件 oxlint 通过；未跑全量 CI。

## Spec

Worker/子代理在外部请求前持久登记 unknown；仅原请求的确定响应加成功业务提交才能解除阻断，失去响应后不会生成另一 UUID 自动尝试。同 Ticket 的显式 retry、Host 接管、再次工具调用和 ready report fail closed；工作卡与观察事实能核查原 UUID，不依赖第一页历史记录。无关 Ticket 可执行。真实 MCP 服务若无按原 UUID 查询的机制，无法证明已执行或未执行，不自动对账或放行；PostgreSQL fixture、真实租户、多进程竞态和在途副作用撤销尚无验收证据，#107 不关闭。
