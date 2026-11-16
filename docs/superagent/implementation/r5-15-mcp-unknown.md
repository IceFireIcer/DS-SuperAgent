# R5-15 / #107：MCP 未知结果的持久意图

- 基线：已推送 `dev` `3fa3672`；独立分支 `fix/107-mcp-unknown`。
- CI 等待条件修复：`ef02837` 只改 `worker-mcp-credential.test.mjs`，等待原 Ticket 的持久工具事实，而非后续异步 Main outcome，可独立合入。

实际 `tools/call` 之前，在同 Instance 业务事务中记录 Ticket、Assignment 代次、工作项、Environment、受信工具/资源、原请求 UUID 和规范化输入的 SHA-256；不保存输入原文、凭据或服务端响应原文。UUID 随原 MCP 请求 `_meta` 发出。意图从提交起视为 unknown，只有该次调用收到结果且业务确认持久化成功才标记 confirmed 并解除同 Ticket 阻断。请求超时、中断、进程退出或业务提交结果不明都保留 unknown。Worker 与子代理使用同一持久账本；子代理的事实不依赖父 Worker 的内存 `toolFacts` 或 ready report。SDK 的 header 不匹配重发和多轮自动履行均被关闭，避免一条意图驱动多次 `tools/call`。

当前工作卡、只读工作观察与 Ticket conversation 可以核查 unknown 和原请求身份，成功 ready report 的工具事实也附原 UUID。未知调用无 ready report 仍能显示；显式 Ticket retry、Host 接管、新的同 Ticket MCP 调用和 `report_ready` 均受阻。阻断使用同事务写入的单独索引，不依赖 100/1000 条历史快照第一页；历史页按 100 条游标读取，无关 Ticket 继续运行。

**对账边界**：普通 MCP 服务不保证可以按本产品 UUID 查询原调用结果。未得到能核对原 UUID 的受信服务回执/状态前，此增量不能自动清除 unknown 或重试；没有提供无证据的手动放行，也不宣称远端 exactly-once。真实服务的查询适配、已发请求即时撤销、PostgreSQL/跨进程竞态和完整产品验收仍未完成；#107 保持 OPEN。

Node 24.22.1 隔离 SQLite、虚构 DSH record 与 mock MCP server 验证调用前意图、真实请求 `_meta`、子代理中断与无 ready report、重启后的阻断、1100 条以上历史分页和无关 Ticket 独立运行。Windows 两路并行的 MCP、profile、工作观察与 Main delegation 定向文件共 6/6 通过；TypeScript 和改动文件 lint 通过。没有跑全量 CI、真实租户或 PostgreSQL fixture。
