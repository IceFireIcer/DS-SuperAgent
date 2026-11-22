# #181 经典 Agent 同窗切换核对

状态为暂停接线。[实施议题 #181](https://github.com/IceFireIcer/DS-SuperAgent/issues/181) · [经典 Agent 授权决议](https://github.com/IceFireIcer/DS-SuperAgent/issues/174#issuecomment-7060652881)

## 公开接口

- DS-Bot `v0.3.8` 的 `setSurface('agent')` 通过 `surfaceGroups` 卸载产品 Slot，再显示原生界面。DSH `0.2.2-rc.1` 提供 `ctx.uiWorkspace.openSession(target)`，视图立即切到指定 Session 并开始加载历史。授权发生在 Host 的 RPC 层。[DSH Workspace 客户端](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/client/ui-workspace/README.md#use-this-package)
- 当前 Web 客户端的 HTTP 和 WebSocket 连接使用共享的 `browserPeer`，其主体是 `owner`。该版本的 `remoteAccess.registerPolicy()` 只服务非所有者主体，原生 `session.list`、`session.search` 和 `session.control` 对 `owner` 不过滤。产品 Profile 将原生 Session 控制器隔离，浏览器只能通过 Session Reader 读取当前 Main。恢复整个原生控制器会重新暴露未按 Session 筛选的目录以及原生写命令。[DSH Connection](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/client/connection/README.md#browser-authentication-and-request-trust) · [DSH Remote Access](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/api/remote-access/README.md#host-service-remoteaccessservice-ctx-key-remoteaccess) · [DSH Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/api/session-controller/README.md#use-this-package) · [产品 Profile](../../../superagent/cordis.patch.yml) · [Session Reader](../../../superagent/src/session-reader.ts)
- 缺少的接缝在 DSH Web Connection 和 Session Controller 之间。Host 可以通过 `createPeer()` 创建进程内主体并授予 Session 角色，但现有 `uiWorkspace.openSession` 无法为当前窗口的原生会话界面指定该 RPC 主体。公开的 `installConnection()` 支持自有载体和独立 Client Context，采用此路径需要改变桌面连接装配。现有 Slot 装卸和跳转机制无法将原生界面的目录、读写和投影流限定在已授权的独立 Session 上。[DSH 客户端连接接缝](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/client/connection/README.md#use-this-package) · [DSH Web 客户端架构](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/docs/subsystems/web-client.md#remote-communication)
- `0.2.2-rc.5` 的公开契约仍使用共享浏览器 `owner` 主体，Session 策略仍只约束非所有者。[新版 Connection](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/client/connection/README.md#browser-authentication-and-request-trust) · [新版 Remote Access](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/api/remote-access/README.md#host-service-remoteaccessservice-ctx-key-remoteaccess)

## 已验证的权限边界

Windows x64、Node `24.22.3`、DSH `0.2.2-rc.1`，基线 `d346c7f6`。

- 在 `superagent/` 运行 `node --test --test-concurrency=1 test/main-session-reader.test.mjs`，两项测试通过并自然退出。夹具覆盖所有者读取当前 Main、远端主体拒绝、无关 Session 拒绝以及仅产品历史的回退。[Session Reader 测试](../../../superagent/test/main-session-reader.test.mjs)
- 在仓库根运行 `node app/scripts/check-superagent-profile.mjs`，使用隔离 Profile 和 mock 模型，退出码 `0`。真实产品装配下，所有者仅能列出和加载当前 Main。原生创建、直接提交、直接停止、读取 Router、导出和跨 Session 引用均不可用。产品 Main 收发和两个 Worker 工作成功。[Profile 探针](../../../app/scripts/check-superagent-profile.mjs)

同窗切出和返回、无落点提示以及切换期间的 Main 和 Ticket 连续性仍待经典 Agent 路径接通后独立验收。
