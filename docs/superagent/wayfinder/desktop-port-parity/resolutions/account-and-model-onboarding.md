## Resolution · 复用账户底栏和首次模型引导

维护者确认两处都从 `temp/DS-Bot` 的 `v0.3.8` 复用并直接适配，旧产品命名改为 SuperAgent。沿用现有主题、动作和权限，不引入第二套设置或认证。

- 复用 `AccountLauncher`／`FooterAccount` 的菜单和键盘交互。用量、模型与密钥、连接器、自动化任务、设置分别指向现有页面，自动化直达 `scheduled-tasks`。独立连接器按钮打开同一连接器页；`Connect to Host` 仍只负责远端 Host 连接。菜单关闭、跳转再返回均将焦点交回入口，远端连接不增加本机设置权限。
- 复用 `ModelChoiceDock` 的 Main 气泡和选择按钮。只有 Main 缺可用模型时显示；DeepSeek 登录使用当前 Profile 已注册的公开 slot，未提供入口时不展示。官方 API key 使用现有 `provider-key` 由 Host 保存；自定义模型进入可用的原生模型设置，否则提供诚实的产品 Models 设置入口。已登录不等于有可用模型，成功后重读设置；取消、失败和跳转不重开 Main 或丢弃草稿，不在浏览器存储密钥。
- 适配代码和生成的客户端均在工作区，未推送。本裁定不计为真实登录、真实模型或完整桌面通过；[确定独立桌面验收的证据与门槛](https://github.com/IceFireIcer/DS-SuperAgent/issues/168#issuecomment-7055697055)仍适用。

验证：Node 24 的底栏、模型引导、设置和翻译共 12 项定向测试通过。隔离 Chromium 加载新生成的客户端后验证自动化和连接器跳转、焦点返回、模拟 `provider-key`、配置状态刷新以及 Main 草稿和浏览器存储边界。未运行真实 DeepSeek 登录，未触发远端 CI。
