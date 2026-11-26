# 桌面迁移补齐规格

本规格针对 DS-Bot 0.3.8 迁移的桌面部分，覆盖三张桌面参考图中的用户路径。手机 App、配对与中继沿用各自的验收议题。[DS-Bot 0.3.8 前端与功能迁移规格](https://github.com/IceFireIcer/DS-SuperAgent/issues/142) · [21 · 手机 Expo App](https://github.com/IceFireIcer/DS-SuperAgent/issues/163) · [22 · 品牌、命名、安全与最终验收](https://github.com/IceFireIcer/DS-SuperAgent/issues/164)

## 实施拆分

从本地 `temp/DS-Bot` 的 `v0.3.8`（`5e9b7da8`）复用组件、样式和动效。优先使用已同步的模块，把旧 Bot 名称、数据键和动作适配到 DS SuperAgent。沿用现有桌面界面、`/api/product`、Main／Router／Worker 权限和产品数据隔离，使用公开 DSH API。复用代码按 Apache 2.0 记录来源。[桌面迁移等价与验收](https://github.com/IceFireIcer/DS-SuperAgent/issues/165) · [上游路径与产品接线清单](../superagent/wayfinder/desktop-port-parity/resolutions/path-inventory.md)

| 用户路径 | 复用与接线 | 通过条件 |
| --- | --- | --- |
| 账户底栏、连接器与首次模型 | 从工作区已有适配起步。复用 `AccountLauncher`／`FooterAccount` 和 `ModelChoiceDock`，接现有设置页、公开登录入口及 Host 的 `provider-key`。 | 快捷入口打开现有页面，自动化直达任务列表。Main 缺可用模型时显示可用引导。配置成功后刷新同一 Main，取消和失败保留草稿。[确定底栏账户、连接器与模型引导的分工](https://github.com/IceFireIcer/DS-SuperAgent/issues/170#issuecomment-7056204160) |
| 侧栏与输入框的工作目录 | 复用 `FolderMenu`。侧栏入口和输入框共用下一条 Main 的临时目录选择。实例默认目录在设置中修改。 | 工作已在 A 进行时选择 B，折叠再展开后选择仍在。下一条新本机工作使用 B，收到接纳回执后恢复默认。取消、授权失败、附件限制或发送失败保留原选择，既有工作及其跟进继续使用 A。[确定侧栏文件夹与工作目录的关系](https://github.com/IceFireIcer/DS-SuperAgent/issues/169#issuecomment-7055825360) |
| Main 连续语音与输入切换 | 复用 `VoiceMode` 和输入区控件动效。转录走原 Main 的持久化输入，按接纳回执关联本轮回复。 | 朗读匹配的完整回复，正常结束后续听。手动暂停、出现问题卡、停止回复、最小化或隐藏时释放音频并使迟到转录失效，等用户继续。离开 Main 或关闭语音后结束。验证后台工作停止、附件和单次听写的独立路径。[确定 Main 连续语音的暂停与恢复规则](https://github.com/IceFireIcer/DS-SuperAgent/issues/171#issuecomment-7060119743) |
| 桌面动效与键盘 | 复用 `motion.js`、弹层进退场、角色状态和启动交接行为。 | 每条适用路径通过键盘、逐层 `Esc`、外部点击、焦点返回、状态反馈和减少动态效果检查。窄宽窗口和四主题浅深组合按代表路径抽验。[桌面动效与键盘验收决议](../superagent/wayfinder/desktop-port-parity/resolutions/interaction-parity.md) · [新版离线样板](../superagent/wayfinder/desktop-port-parity/prototypes/desktop-interactions.html) |
| 经典 Agent 切换和返回 | 单独实施及验收。复用 `setSurface`、`surfaceGroups` 和侧栏返回按钮。入口限本机 Host 所有者，进入前确认有已获授权的独立原生会话。 | 权限或落点不可用时留在 Main 并提示。切出后原回复和在途工作继续，返回同窗原 Main，保留消息与回执。验证 `Session Reader` 原有读取范围和远端权限边界。[裁定经典 Agent 模式的入口与权限边界](https://github.com/IceFireIcer/DS-SuperAgent/issues/174#issuecomment-7060652881) |

## 桌面验收

推送候选提交到 `dev` 后，用该提交的远端 GitHub Actions `full=true` 运行验收。使用隔离夹具和 mock 模型覆盖 Windows x64 新装与覆盖升级、macOS arm64/x64 启动与 Main 工作流、Linux AppImage/deb 启动与 Main 收发。记录共存、问题回答、停止回复和停止工作的独立路径，确认全量服务端测试自然退出。证据关联候选 SHA、工作流步骤、平台和构件。真实模型及外部接入记录为暂缓。经典 Agent 路径单独留证。正式发布沿用原发布门槛。[确定独立桌面验收的证据与门槛](https://github.com/IceFireIcer/DS-SuperAgent/issues/168#issuecomment-7055697055)

## 规划时的验收记录

规划时的核对基线为 `dev` 的 `50491ff1`，`main` 为 `a694c903`。本机试用使用 Windows x64 0.2.5 未签名免安装包，目录为 `app/dist-pack/ticket-164-final/win-unpacked/`。

| 项目 | 已验证 | 仍缺什么 |
| --- | --- | --- |
| Windows 本机试用 | `4045860b` 构件的 `app.asar` 指纹与[原记录](../superagent/implementation/dsbot-port-162-164.md#候选构件与发布检查)一致。重跑 `check-packed.mjs --coexistence`，确认仓库外启动、设置、Main 模拟收发、旧存储键和目录夹具隔离、隐藏唤回、退出码 0。 | 真实模型、正式安装和覆盖升级不能用这次模拟试用代替。工作控制上次通过的是更新选择器的脚本副本，不是当前跟踪的 `--controls`。 |
| #164 命名与发布检查 | 原记录有 278 个运行时文件的命名扫描、UI boundary、双语 README 和包内 NOTICE；[`50491ff1` 日常 CI](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/44781780330)通过。 | [`4045860b` 完整 CI](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/44777356955)中 macOS 两架构通过，Windows 安装版在下载更新后未退出，Linux 包 Main 未完成收发；Windows 服务端分片 1、4 失败，分片 3 取消。分片 2 的生成差异已修复，最终提交没有完整通过记录。 |
| 两条服务端回归 | Node `24.22.3` 对 `product-execution.test.mjs` 和 `main-followup.test.mjs` 串行实跑，6 通过、0 失败、自然退出。覆盖远端验证、原工作跟进与同 Ticket 续办。 | 这不是 CI 环境或完整套件复验。不要加大超时或强制退出后将失败算通过。 |
| 总规格的真实接入 | [#154](https://github.com/IceFireIcer/DS-SuperAgent/issues/154#issuecomment-7036668151) 的八个平台已有适配器和模拟协议验证。 | #154 为 `NOT_PLANNED`，不计八平台真实登录、配对和收发验收完成。规格还记录了真实 OAuth、邮件、外部 MCP 和电脑操控指示器待验证；以真实结果逐条收口，不能用关闭的代码票替代。 |

原规格共 22 张子票：19 张按完成关闭，#154 按 `NOT_PLANNED` 关闭，#163 和 #164 开放。这个数字是追踪状态，不是功能通过率。

## 规划时的截图对照

上游基线为 `temp/DS-Bot` 的 `v0.3.8`（`5e9b7da8`）。实际 126 个客户端 JavaScript 文件都在[同步清单](../../superagent/dsh/scripts/sync-client.manifest.json)中。清单包含仅供参考的文件；判断完成要查产品入口、实际挂载、后端动作和失败状态，不看复制数。

| 截图 / 用户行为 | 当前实际 | 补齐目标 |
| --- | --- | --- |
| 图 1：侧栏按钮、角色磁贴、聊天标题 | [产品外壳](../../superagent/dsh/src/client/product-shell.js)保留搜索、Main、Activity、连接 Host、Settings；搜索不是项目文件夹菜单。 | 保留 Main 和工作状态，补工作区/文件夹入口及折叠、展开与键盘交互；上游新建 Bot/群的加号不复活，只有能对应现有产品动作的控件才渲染。 |
| 图 1：首次无模型时的气泡和三个操作 | [原生 Main 标题](../../superagent/dsh/src/client/product.js)显示 `Models need setup`，可进设置；没有上游 `ModelChoiceDock` 流程。 | 将登录 DeepSeek、配置 API key、打开自定义模型设置的引导接到公开登录和现有模型配置；可用性、加载、失败及取消可见，配置成功后回到原 Main，不在浏览器保存密钥。 |
| 图 1：附件、听写、连续语音和发送 | [MainComposer](../../superagent/dsh/src/client/composer.js)已有附件、单次听写、发送和停止回复；没有上游 `VoiceMode` 连续收听、发送、朗读、再听。 | 复用上游输入框的控件和动效行为；连续语音仍用 Main 输入队列而不是另起聊天，暂停/关闭撤掉麦克风和朗读；问题卡出现时暂停，不同时显示两套输入。 |
| 图 2：底栏菜单与独立连接器入口 | 没有上游 `FooterAccount` 菜单；用量、模型、连接器和日程有设置页。`Connect to Host` 不是连接器。 | 恢复独立底栏菜单和连接器快捷入口，跳到现有用量、模型与 API Key、连接器、自动化和设置页；接通登录状态；菜单进退场、焦点、Esc 和外部点击都有验收。 |
| 图 3：经典 Agent 模式与返回按钮 | 上游切换是把界面交还给 DSH 原生外壳；SuperAgent 未挂载切换和返回。现有 [Session Reader](../../superagent/src/session-reader.ts)只允许 Host 所有者读当前 Main。 | 独立设计原生 DSH Agent 会话的权限和身份，支持从当前窗口切换及返回同一 Main。不是把旧 Local Agent、Bot 和群运行时重新接回。 |
| 图 1–3：控件进退场、启动过渡和状态动画 | 主题、动效档、现有通知和角色磁贴已有部分复用；静态截图和全局 token 不能证明按钮转场都在。 | 逐个核对菜单、弹窗、输入区按钮切换、角色状态及启动交接；普通动效和减少动态效果都可用，按[设计标准](../design/ui-standard.md)验收，不直接复制未授权图标或品牌资产。 |

## 建图前的实施设想

此节保留早期设想。实施范围与验收以本规格的「实施拆分」和「桌面验收」为准。

1. **先做可追溯清单。** 从上游的 slots、菜单、设置页、composer、对话卡、弹层、桌面窗口和桥调用列出每个用户动作及其空态/忙态/错误/退出行为。对照当前实际挂载和调用，标为已接线、缺失、需替换后端、范围外或真实环境待验；每个缺口给工单和验收入口。旧 Bot 创建/模型/头像库、群聊、Local Agent 集成和团队权限继续按 #142 排除，不把产品本身的同类能力误列为旧团队功能。
2. **先补日常桌面路径。** 在现有 sidebar、overlay 和 composer slots 接回底栏、连接器和无模型引导，再补附件/语音的操作状态与过渡。沿用 `/api/product`、工作目录授权、Main 持久化提交和原工作控制；不替换桌面 renderer、不新建 `/api/bot`。只有实测可达、功能接通的入口才能进入完成栏。
3. **经典模式单独做规格和试验。** 参考上游切换和返回交互，但它没有解决 SuperAgent 的 Session 权限问题。先用公开 DSH 能力在隔离 profile 做往返试验：经典模式仅访问它获准的原生会话，不可写 Main/Router/Worker，不复用旧存储键，返回不重发消息、不换 Ticket、不停在途工作，远程端不能借切换获得本地权限。若当前 DSH 没有公开能力实现这个边界，记录缺口并停在接线前，不能放开 Session Reader 或补丁修改 DSH。经典模式是对 #142 的补充决定，不并入 #164 偷过验收。
4. **最后用真实桌面包验收。** 每批从上游与产品分别录同一路径的截图或短片，核对可见、可操作、有真实回执；覆盖窄/宽窗口、四主题浅深组合、键盘和减少动作，以及无账号/正常/失败状态。用隔离数据验证 Main 提交、问题与回复/工作停止、切换回来保持原会话。Windows 新装、下载更新、退出安装、重开和数据保留走一条完整链；Linux 包显式核对已授权环境就绪后再提交 Main，失败时分类是真实 Host 问题还是探针时序。运行最新提交的桌面发布门与自然退出的全量服务端检查。真实第三方接入的验收证据另列，不使用用户现有 DSH 或旧产品数据作测试。

每张新票以用户路径验收，而不是以存在文件、截图相似或菜单能打开为完成。#164 留开放直到桌面发布检查真正通过；总规格的其余未验收项另外列账。
