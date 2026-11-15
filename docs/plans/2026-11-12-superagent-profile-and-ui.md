# Super-agent 独立 profile 与聊天界面

- 日期：2026-11-12
- 相关：T55 / #83、T56 / #90、T59、T60

## 为什么

新核心已经能用公开 Engine 完成 Router/Worker 工作，但桌面应用仍启动旧的 `ds-bot` profile。现有 `ds-bot` Host 可以通过 `botExecutionAdapter` 接入新 Engine，但这条路径只覆盖 1:1 聊天，而且没有把新核心装进桌面产品。

直接改现有 `ds-bot` profile 会同时影响用户已有的团队、群聊和数据。我们需要一个独立 profile，让新核心和旧团队并存，并且可以单独验收。

`ds-bot` 前端是团队界面，但维护者已决定：Super-agent 直接复用并修改现有的 `ds-bot` 前端，不再维护复制出来的独立前端包。未接线的入口保留并明确返回失败，不能通过删除页面来隐藏。

## 已定的行为

- 新增独立 DSH profile `ds-superagent`，与 `ds-bot` profile 并存。两个 profile 各自使用独立的 profile 目录、业务数据库和 Session 数据。
- `ds-superagent` profile 只通过 DSH 公开入口装配：`@deepseek-ai/dsh/profile-boot`、`dsh-app-boot`、bundle patch 和客户端 `dsh.client` 清单。不修改 DSH 安装或依赖其内部文件。
- 复用现有 `ds-bot` 聊天界面，通过 `ds-superagent/ds-bot-host` 的 `botExecutionAdapter` 把 prompt、stop、resume、question 和 chat 投影接到新 Engine。
- 产品 profile 只挂载 `ds-superagent` 和 `ds-bot`。未来界面修改直接改 `ds-bot/src/client/`，再生成 `ds-bot/client.js`。
- 完整的 `ds-bot` 入口继续显示；未接线的群聊、浏览器、附件、steer、记忆、日程、用量、密钥和团队管理动作明确 fail-closed，不删除页面。
- v1 的核心交付是单会话发起、确认、结果、Attention 回答、stop、resume、重连补读和证据展开。
- 新旧 profile 由应用启动配置显式选择。开发期使用 `DS_BOT_PROFILE=ds-superagent`，发布期再决定设置入口或独立安装包。
- 切换 profile 不迁移在途工作，不重放旧队列，不读取用户自有 DSH 数据。
- 只用公开 DSH API。固定 DSH 版本；每次升级先启动 `ds-superagent` profile 并发一条 mock 消息，再跑旧插件回归。

## 不做什么

- 不修改 `deepseek-harness` 源码或其安装目录。
- 不把 `ds-superagent` 作为现有 `ds-bot` profile 的替换补丁；两个 profile 并存。
- 不复制前端，不创建独立 UI 包，也不创建第二套桌面壳。
- 不复制 `/api/bot` 的全部 85 个端点。新接口只覆盖 v1 行为。
- 不把群聊、浏览器、附件或 steer 显示为已支持。
- 不迁移用户的真实团队、群聊或 Session；真实迁移仍由 T50—T53 的范围内处理。

## 已知限制

- 第一阶段仍运行旧 `ds-bot` Host 作为协议和聊天投影层。它只证明 Engine 已接上，不证明旧核心已经移除。
- 独立 `ds-superagent-ui` 会产生界面分叉；该分叉已于 2026-11-13 停止并删除。
- Engine 当前的 `botExecutionAdapter` 只支持 Bot 私聊；群聊和团队语义仍 fail-closed。
- 真实模型、真实 GitHub/飞书、托管 Host 和第二设备组合仍由 T57、T58 验收。
- DSH 客户端 slot 或主题接口变化会影响复制的前端；升级冒烟只能发现启动和基本挂载失败，不能替代完整视觉检查。

## 变更

- 2026-11-12：初版。确定独立 profile、两阶段前端接线、v1 范围和 DSH 升级保护。
- 2026-11-13：维护者决定直接改 `ds-bot` UI；删除独立 `ds-superagent-ui`、窄 UI host、`/api/superagent` 路由和相关测试/依赖，恢复完整 `ds-bot` 界面。
