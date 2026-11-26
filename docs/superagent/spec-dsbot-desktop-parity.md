# DS SuperAgent 桌面迁移补齐规格

## Problem Statement

用户从 DS-Bot 0.3.8 切到 DS SuperAgent 后，仍有几条熟悉的桌面路径需要补齐。用户要能从侧栏为下一条 Main 输入选目录，在账户底栏找到设置和连接器，在首次启动时给 Main 配好模型，并用连续语音完成多轮对话。菜单、问题卡和启动交接也要能用键盘完成，并适配减少动态效果的系统设置。

需要用原生 Agent 会话的用户希望在同一个桌面窗口切换并返回原 Main。Main 的回复和已经接纳的工作要在切换期间继续运行。[DS-Bot 0.3.8 前端与功能迁移规格](https://github.com/IceFireIcer/DS-SuperAgent/issues/142) · [桌面迁移等价与验收](https://github.com/IceFireIcer/DS-SuperAgent/issues/165)

## Solution

复用 DS-Bot 0.3.8 的桌面组件、样式和交互，把它们接到 DS SuperAgent 现有的设置、目录授权、Main 提交和工作控制。经典 Agent 模式使用已授权的独立 DSH 原生会话，侧栏提供返回原 Main 的入口。用已确认的交互样板对照行为，并在候选提交的远端 CI 中验证产品构件。[核对桌面用户路径与实际接线](https://github.com/IceFireIcer/DS-SuperAgent/issues/166#issuecomment-7055595551)

## User Stories

### 目录与设置

1. 作为本机桌面用户，我希望从侧栏或 Main 输入框选同一个临时工作目录，以便在组织新工作时看到一致的选择。
2. 作为没有预设目录的用户，我希望能选择一个已获准的目录，以便直接提交第一项本机工作。
3. 作为同时处理多项工作的用户，我希望下一条新工作可以使用目录 B，以便正在目录 A 执行的 Ticket 及其跟进继续使用 A。
4. 作为在窄窗工作的用户，我希望折叠和恢复侧栏后仍能找回所选目录，以便继续未提交的输入。
5. 作为发送失败的用户，我希望保留草稿和目录并看到失败原因，以便重试。成功接纳后，下次输入使用实例默认目录。
6. 作为桌面用户，我希望从账户底栏打开用量、模型与密钥、连接器、自动化任务和设置，以便直达现有页面。
7. 作为配置连接器的用户，我希望有独立的连接器快捷入口，以便直接打开连接器页。
8. 作为首次使用 Main 的用户，我希望看到当前可用的模型配置方式，以便完成 DeepSeek 登录、官方 API 密钥配置或自定义模型设置。
9. 作为正在写草稿的用户，我希望配置模型、取消或遇到失败后仍回到原 Main，以便继续写作。
10. 作为通过远端 Host 工作的用户，我希望桌面只显示我获准使用的设置与目录操作，以便知道哪些动作可用。

### Main 输入与连续语音

11. 作为使用附件或单次听写的用户，我希望在原 Main 输入位添加附件、转写草稿和发送，以便沿用原有工作流。
12. 作为想进行连续语音对话的用户，我希望听到当前这条转录对应的完整 Main 回复，以便确认 Main 回答了本轮的问题。
13. 作为连续语音用户，我希望看清收听、等待、朗读和暂停状态，并在朗读完成后继续说话，以便顺畅交流。
14. 作为遇到问题卡的用户，我希望语音暂停且问题卡接管输入位，以便先回答问题，再由我恢复收听。
15. 作为需要暂时离开窗口的用户，我希望隐藏或最小化时释放麦克风并停止朗读，以便返回后自行决定是否继续。
16. 作为停止当前 Main 回复的用户，我希望语音暂停，以便选择下一步。单独停止某项后台工作时，Main 与语音继续按本轮回执运行。
17. 作为遇到麦克风拒绝或发送失败的用户，我希望看到原因并由我重试，以便确认何时恢复收听。
18. 作为切出 Main 或结束语音的用户，我希望当前语音交互立即结束，以便返回后由我重新开启。

### 桌面交互与经典 Agent

19. 作为键盘用户，我希望用 Tab 和方向键到达控件并看见焦点，以便完成目录、账户、设置和模型操作。
20. 作为打开嵌套弹层的用户，我希望 `Esc` 只关闭最上层，以便逐层返回，焦点回到对应入口。
21. 作为开启减少动态效果的用户，我希望仍能识别按钮、问题卡和角色状态，以便完成与普通动效下相同的操作。
22. 作为使用不同窗口宽度和主题的用户，我希望按钮、状态文字和弹层在可见范围内，以便读清反馈和操作。
23. 作为启动应用的用户，我希望看见启动状态和失败重试选项，以便在 Main 就绪后直接用键盘输入。
24. 作为本机 Host 所有者，我希望从账户菜单进入获准的独立原生 Agent 会话，以便在同一窗口使用原生界面。
25. 作为经典 Agent 模式的用户，我希望通过侧栏按钮回到同一个 Main，以便看到原消息、回执和在途 Ticket。
26. 作为没有权限或可用原生会话的用户，我希望留在 Main 并看到原因，以便继续原来的工作。

## Implementation Decisions

- **复用与接线。** 使用 DS-Bot `v0.3.8`（`5e9b7da8`）的实际客户端和桌面代码，优先使用已同步模块，再取上游缺失部分。名称、动作和存储键适配到 DS SuperAgent。沿用现有 renderer、`/api/product`、Main／Router／Worker 职责和独立产品 Profile。DSH 接线只用公开接口，复用来源按 Apache 2.0 记入 `NOTICE`。[核对桌面用户路径与实际接线](https://github.com/IceFireIcer/DS-SuperAgent/issues/166#issuecomment-7055595551)
- **共享工作目录。** 侧栏和 Main 输入框复用 `FolderMenu`，共同选择下一条新本机工作的临时目录。目录登记只影响以后可选的列表，设置页负责修改实例默认值。接纳回执清除临时选择，恢复默认目录或未选择状态。取消、授权失败、附件约束和发送失败保留原选择。已接纳工作与跟进绑定原目录。远端与自动执行继续按现有授权策略选环境。[确定侧栏文件夹与工作目录的关系](https://github.com/IceFireIcer/DS-SuperAgent/issues/169#issuecomment-7055825360)
- **账户、连接器与模型。** 在工作区已有适配上复用 `AccountLauncher`、`FooterAccount` 和 `ModelChoiceDock`。自动化直达任务列表，独立连接器按钮与菜单共用连接器页，`Connect to Host` 用于远端 Host 连接。仅在 Main 缺可用模型时出示引导。只显示当前 Profile 已注册的公开 DeepSeek 登录入口。浏览器负责输入和提交官方密钥，由 Host 的 `provider-key` 保存。自定义模型优先打开可用的原生设置，否则打开产品 Models 页。登录或配置完成后重读模型可用性，始终保留原 Main 与草稿。[确定底栏账户、连接器与模型引导的分工](https://github.com/IceFireIcer/DS-SuperAgent/issues/170#issuecomment-7056204160)
- **连续语音。** 复用 `VoiceMode` 的收听、等待、朗读和暂停界面。转录走原 Main 的持久化提交，按接纳回执匹配本轮完整回复。普通朗读完成后续听。手动暂停、问题卡出现、停止 Main 回复、最小化或隐藏时立即释放麦克风、停止朗读并废弃迟到转录，等待用户恢复。麦克风拒绝和发送失败显示原因并等用户重试。离开 Main、关闭面板或退出窗口时结束连续语音并清理音频。停止后台 Ticket 只影响目标工作。[确定 Main 连续语音的暂停与恢复规则](https://github.com/IceFireIcer/DS-SuperAgent/issues/171#issuecomment-7060119743)
- **交互等价。** 复用共享弹簧曲线、菜单与对话框进退场、输入控件切换、角色状态和启动交接。键盘顺序跟随界面，方向键在菜单内移动。检查逐层 `Esc`、适用弹层的外部点击、可见焦点、关闭后恢复焦点，以及空态、忙态和失败反馈。减少动态效果时停止角色动画，菜单即时进退，对话框只需淡入，启动交接直接到位。[DS SuperAgent UI 设计标准](https://github.com/IceFireIcer/DS-SuperAgent/blob/50491ff160ccf1a5bc86226d52d2a3e0162ed31f/docs/design/ui-standard.md) · [用交互样板核定桌面动效与键盘验收](https://github.com/IceFireIcer/DS-SuperAgent/issues/172#issuecomment-7063742924)
- **经典 Agent 模式。** 复用账户菜单入口、`setSurface`、`surfaceGroups` 与侧栏返回按钮，替换旧 Bot 落点和动作。仅本机 Host 所有者可以进入，切换前通过公开 DSH 接口确认有已获授权的独立原生会话。权限或落点不可用时留在 Main 并显示原因。切出时关闭产品弹层并结束连续语音，用 `Back to DS SuperAgent` 在同一窗口回到原 Main。保留原回复、消息提交回执和 Ticket，维持每条输入只接纳一次。`Session Reader` 只向 Host 所有者提供当前 Main 的读取权限，Main／Router／Worker 会话由产品管理。公开接口存在缺口时记录缺口并暂停该路径接线。[裁定经典 Agent 模式的入口与权限边界](https://github.com/IceFireIcer/DS-SuperAgent/issues/174#issuecomment-7060652881)

## Testing Decisions

- **产品客户端。** 以挂载后的产品 UI 为主要入口，使用现有 DSH slot 与 `/api/product` 夹具。沿用外壳、模型引导、设置和语音适配器的定向测试。通过用户动作核对页面跳转、状态、权限提示、焦点及回执。语音夹具模拟权限拒绝、转录迟到、提交失败、收到其他回复和收到匹配的完整回复，验证每轮的采集与朗读只在对应状态运行。
- **Host 行为。** 复用现有目录授权、Main 执行环境和 `Session Reader` 集成测试。验证下一条 Main 输入使用所选获准目录，原 Ticket 的工作目录和执行权保持原绑定。用本机所有者、远端主体、有权限和无可用落点的夹具验证经典模式的切换与返回。检查原会话连续性、在途工作和每条输入的接纳次数。
- **交互路径。** 键盘、弹层关闭、焦点返回、状态反馈和减少动态效果均逐路径检查。将目录与输入框、账户与模型、连续语音与问题卡、角色与工作状态、启动交接与重试分配到代表路径，覆盖窄宽 × DeepSeek、Mono、Paper、Moonlight × 浅深共 16 种组合。逐个检查代表状态的可见性、裁切、弹层位置及进退场。离线样板供对照，产品结果以生成客户端和桌面构件为准。[用交互样板核定桌面动效与键盘验收](https://github.com/IceFireIcer/DS-SuperAgent/issues/172#issuecomment-7063742924)
- **远端桌面 CI。** 候选提交推到 `dev` 后，在 GitHub Actions 用 `full=true` 验收，核验运行的 `headSha` 与构件来源。使用隔离 Profile、目录夹具与 mock 模型。Windows x64 验证新装、下载更新、旧进程退出、覆盖安装、重开与数据保留。macOS arm64/x64 验证包启动及 Main 工作流。Linux AppImage/deb 验证发布检查及 Main 收发，并在发送前核对已授权环境就绪。沿用桌面包探针，补齐共存、问题回答、停止回复和停止工作的独立结果。全量服务端测试须自然退出。记录候选 SHA、工作流及步骤链接、平台架构、构件版本与适用指纹、结果和退出状态。通过需要同一候选提交的全部必验结果成功。经典 Agent 依照自己的验收议题留证，现有发布门槛以原发布清单为准。[确定独立桌面验收的证据与门槛](https://github.com/IceFireIcer/DS-SuperAgent/issues/168#issuecomment-7055697055)

## Out of Scope

- 手机 Expo App、配对和中继。[21 · 手机 Expo App](https://github.com/IceFireIcer/DS-SuperAgent/issues/163)
- 旧 Bot 与群聊、旧 Local Agent、团队权限和旧侧栏分组。新 renderer、旧 `/api/bot` 兼容、DSH 安装补丁及访问个人 DSH 或 DS-Bot 数据。[DS-Bot 0.3.8 前端与功能迁移规格](https://github.com/IceFireIcer/DS-SuperAgent/issues/142)
- 真实模型、真实 OAuth、邮件、八平台 IM、外部 MCP 和真实电脑操控指示器事件的验收。本轮将这些项目记录为暂缓。正式发行继续走原发布清单与验收议题。[确定独立桌面验收的证据与门槛](https://github.com/IceFireIcer/DS-SuperAgent/issues/168#issuecomment-7055697055) · [22 · 品牌、命名、安全与最终验收](https://github.com/IceFireIcer/DS-SuperAgent/issues/164)

## Further Notes

- 实施直接取用本地 `temp/DS-Bot` 的固定版本。以已确认的用户路径、接线清单和离线样板检查复用效果。账户底栏与首次模型引导已有工作区适配，可以从这部分核对起步。[桌面迁移等价与验收](https://github.com/IceFireIcer/DS-SuperAgent/issues/165) · [核对桌面用户路径与实际接线](https://github.com/IceFireIcer/DS-SuperAgent/issues/166#issuecomment-7055595551)
