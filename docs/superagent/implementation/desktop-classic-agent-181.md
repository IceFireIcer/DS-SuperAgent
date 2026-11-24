# #181 经典 Agent 同窗切换与返回

复用 DS-Bot `v0.3.8` 的账户菜单入口、`surfaceGroups` 装卸顺序和侧栏返回。桌面在现有窗口切换到已授权的 DSH 原生 Session。产品继续处理 Main 的提交回执和 Ticket，返回时打开原 Main。[实施议题 #181](https://github.com/IceFireIcer/DS-SuperAgent/issues/181) · [经典 Agent 授权决议](https://github.com/IceFireIcer/DS-SuperAgent/issues/174#issuecomment-7060652881)

## 桌面授权

- DSH `0.2.2-rc.1` 的 `openSession()` 负责导航。桌面主进程通过公开的 `/connect` 获得独立 Peer，将其凭据用于指定窗口发往本机 Host 的原生 HTTP 和 WebSocket 请求。打开、续期和关闭经典模式通过现有 `/api/product`，由主进程持有的凭据和该 Peer 身份共同验证。[DSH Connection](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/client/connection/README.md#browser-authentication-and-request-trust) · [桌面传输](../../../app/src/classic-agent.mjs)
- 桌面 Host 只接受该 Peer 的 DSH WebSocket。Session 通知按当前界面过滤，原生审批和提问按会话核对，退出 Classic 会取消该会话的待答回调。普通 HTTP Session Reader 仅可读取当前 Main。窗口销毁、重载或 Peer 断开时撤销授权。[桌面 Gateway](../../../superagent/src/desktop-session-gate.ts) · [Session Reader](../../../superagent/src/session-reader.ts)
- 原生界面的“新会话”只在 Classic 授权期间创建会话，并绑定到当前已授权的 Workspace。Session Reader 只列出和读写该 Workspace 的 Classic 会话；传其他 Workspace、目录或 Main／Router Session 会拒绝。关闭 Classic 或 Peer 断开后，这些额外会话同时失去访问权。
- 以实例默认工作目录的规范路径登记 DSH Workspace，让原生空白会话获得编辑资格。客户端确认工作区和会话已可用，再关闭产品弹层及语音并切换。Classic 的模型选择只记录在当前会话。同一实例和目录重进可恢复这段原生会话。[会话授权](../../../superagent/src/classic-session.ts) · [切换实现](../../../superagent/dsh/src/client/product.js)

## 初始接口核对

- DS-Bot `v0.3.8` 的 `setSurface('agent')` 通过 `surfaceGroups` 卸载产品 Slot，再显示原生界面。DSH `0.2.2-rc.1` 提供 `ctx.uiWorkspace.openSession(target)`，视图立即切到指定 Session 并开始加载历史。授权发生在 Host 的 RPC 层。[DSH Workspace 客户端](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/client/ui-workspace/README.md#use-this-package)
- 当前 Web 客户端的 HTTP 和 WebSocket 连接使用共享的 `browserPeer`，其主体是 `owner`。该版本的 `remoteAccess.registerPolicy()` 只服务非所有者主体，原生 `session.list`、`session.search` 和 `session.control` 对 `owner` 不过滤。产品 Profile 将原生 Session 控制器隔离，浏览器只能通过 Session Reader 读取当前 Main。恢复整个原生控制器会重新暴露未按 Session 筛选的目录以及原生写命令。[DSH Connection](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/client/connection/README.md#browser-authentication-and-request-trust) · [DSH Remote Access](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/api/remote-access/README.md#host-service-remoteaccessservice-ctx-key-remoteaccess) · [DSH Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/api/session-controller/README.md#use-this-package) · [产品 Profile](../../../superagent/cordis.patch.yml) · [Session Reader](../../../superagent/src/session-reader.ts)
- 初次核对确认 `uiWorkspace.openSession()` 只负责导航。重开后，在 Electron 主进程用公开的 `/connect` 为窗口建立独立 API Peer，继续使用现有 DSH renderer。[DSH 客户端连接](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/client/connection/README.md#use-this-package)

## 已验证的权限边界

Windows x64、Node `24.22.3`、DSH `0.2.2-rc.1`，基线 `d346c7f6`。

- 在 `superagent/` 运行 `node --test --test-concurrency=1 test/main-session-reader.test.mjs`，两项测试通过并自然退出。夹具覆盖所有者读取当前 Main、远端主体拒绝、无关 Session 拒绝以及仅产品历史的回退。[Session Reader 测试](../../../superagent/test/main-session-reader.test.mjs)
- 在仓库根运行 `node app/scripts/check-superagent-profile.mjs`，使用隔离 Profile 和 mock 模型，退出码 `0`。真实产品装配下，所有者仅能列出和加载当前 Main。原生创建、直接提交、直接停止、读取 Router、导出和跨 Session 引用均不可用。产品 Main 收发和两个 Worker 工作成功。[Profile 探针](../../../app/scripts/check-superagent-profile.mjs)

- `node app/scripts/check-superagent-profile.mjs --check-classic` 通过。探针检查原生 Workspace 实际成员、独立原生收发、无可用目录和未授权 Peer 拒绝、产品 Session 原生写入拒绝、关闭和断连撤权。原 Main 的在途回复正常完成，相同命令重复提交只触发一次模型调用。[Profile 探针](../../../app/scripts/check-superagent-profile.mjs)
- 桌面传输、回调生命周期、启动握手、Profile 装配和 Session Reader 的 9 项定向测试通过。[桌面传输测试](../../../app/test/classic-agent.test.mjs)

## Windows 打包往返

Windows x64 `0.2.5` 解包构件在隔离 Profile 下使用 mock 模型运行 `node app/scripts/check-packed.mjs <exe> --classic`。`app.asar` SHA-256 为 `8c5e955de59f6055fefc838533e56b500ed4c3c0eedfc26a3570fe6a2c10fa7b`，包内客户端 SHA-256 为 `c0b7c0a11403ecbf9def371aaf090958daa74af541ab43b3e1443fba2ab5b031`。

- `Tab` 和方向键可操作账户菜单，`Esc` 将焦点交还账户按钮。开启减少动态效果后，可以用键盘切入 Classic。产品弹层卸下，原生输入区可收发，侧栏返回按钮即时显示。[打包探针](../../../app/scripts/check-packed.mjs)
- 原 Main 的回复和 Ticket 在 Classic 期间完成。返回同一窗口后，焦点回到原 Main 输入框，保留原 Session、输入回执和 Assignment。探针确认原输入只出现一次，Classic 消息保留在独立会话。应用正常退出，退出码为 `0`。[打包探针](../../../app/scripts/check-packed.mjs)
- 主视图切换等产品槽位完成卸载后再打开原生 Session。挂载测试覆盖授权拒绝、导航失败后撤回授权和恢复 Main，以及远端已配对客户端不提供入口。客户端 bundle 与相关挂载共 7 项测试通过。[Classic 挂载测试](../../../superagent/dsh/test/product-classic-agent.test.js)
