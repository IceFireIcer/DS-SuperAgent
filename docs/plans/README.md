# 设计记录

当前产品行为见[愿景](../vision.zh.md)、[R5 规格](../superagent/spec-r5.md)和各票的实施记录。下表的早期方案供查阅产品演进；其中的安装命令、代码路径和旧协作流程按记录时间理解。

## 记录

| 文档 | 历史主题 |
|---|---|
| [DSH 让步总账](2026-10-13-dsh-concessions.md) | 早期 DSH 插件与客户端限制的处理方式 |
| [角色与权限](2026-10-07-roles-and-permissions.md) | 早期协作者、群管理员和记忆权限模型 |
| [隐私协作者](2026-10-27-private-bots.md) | 早期隐私隔离与授权边界 |
| [群聊](2026-10-07-group-chat.md) | 早期群成员、发言轮次、提及和审批设计 |
| [浏览器、搜索、密钥和连接器](2026-10-08-browser-and-secrets.md) | 早期资源与凭据设计；当前能力见 R5 规格 |
| [浏览器插件](2026-10-21-browser-plugins.md) | 已被产品 Browser resource、lease 和受控 Electron bridge 取代 |
| [上下文与记忆](2026-10-09-context-and-memory.md) | 早期会话分段、压缩、交接和记忆方案 |
| [协作者运行配置](2026-10-10-bot-runtime.md) | 早期角色、模型、工作区和能力配置 |
| [AGENTS.md 维护](2026-10-27-agents-md-upkeep.md) | 从项目工作中审阅持久规则 |
| [长消息](2026-10-16-long-messages.md) | 早期消息正文与附件读取设计 |
| [桌面应用](2026-10-16-desktop-app.md) | 早期桌面外壳、profile、数据位置和更新方案 |
| [工作交接](2026-10-16-bot-handoffs.md) | 早期协作者间派活与交接模型 |
| [结构化视图](2026-10-20-widget-views.md) | 早期结构化内容和交互视图方案 |
| [Side chat（侧边对话）](2026-10-21-btw.md) | 早期侧边提问方案 |
| [消息布局和宽度](2026-10-22-message-layout.md) | 早期聊天布局设置 |
| [手机 App](2026-10-24-mobile-app.md) | 未接线的移动端设想，不代表当前可用功能 |
| [Office 文档](2026-10-27-office-documents.md) | 早期 Office 工具与运行时方案；当前入口见产品文档 |
| [Node 24 单一运行时](2026-11-10-node-24-support.md) | 当前 Node 运行时约束的决策记录 |
| [独立 profile 与聊天界面](2026-11-12-superagent-profile-and-ui.md) | 被单 profile、单包方案取代的过渡设计 |

## 新设计

大功能请在同一个 Pull Request 中附上 `docs/plans/<日期>-<主题>.md`，记录相关 Issue、设计取舍、可验证行为和已知限制。改动已定设计前，先在 Issue 中和维护者确认。
