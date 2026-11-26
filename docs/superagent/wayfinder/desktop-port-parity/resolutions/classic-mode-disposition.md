## Resolution · 经典 Agent 模式的入口与权限边界

复用本地 `temp/DS-Bot` v0.3.8 的账户菜单入口、`setSurface` 切换、`surfaceGroups` 装卸顺序和侧栏返回按钮。切出时关闭产品弹层并结束连续语音，保留独立的返回入口。将旧 Bot 的落点、状态键和动作换成 SuperAgent 对应项，返回按钮使用 `Back to DS SuperAgent`。[核对桌面用户路径与实际接线](https://github.com/IceFireIcer/DS-SuperAgent/issues/166#issuecomment-7055595551)

- 仅本机 Host 所有者可以切换。进入前用公开 DSH 接口确认有独立、已获授权的原生落点。权限或落点不可用时留在 Main 并显示原因。
- 经典界面只访问已获授权的独立原生会话。`Session Reader` 的读取范围为 Host 所有者的当前 Main，Main、Router 和 Worker 的产品会话继续由现有产品路径管理。
- 在同一窗口返回切出前的 Main，沿用现有 `openMain` 的产品路径。切换期间原回复和 Ticket 继续运行，返回时显示原消息、回执和工作状态，每条输入仍只提交一次。
- 单独验收同窗切出和返回、落点不可用时留在 Main、本机与远端权限、原回复和 Ticket 的连续性。使用隔离数据和 mock 模型留证。[确定独立桌面验收的证据与门槛](https://github.com/IceFireIcer/DS-SuperAgent/issues/168#issuecomment-7055697055)
