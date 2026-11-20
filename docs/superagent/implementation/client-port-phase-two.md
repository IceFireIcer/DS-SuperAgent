# DS Bot 0.3.8 客户端迁移（阶段二）

2026-11-20 · [迁移规格 #142](https://github.com/IceFireIcer/DS-SuperAgent/issues/142)

| 工单 | 已落地 | 验收边界 |
| --- | --- | --- |
| [#151](https://github.com/IceFireIcer/DS-SuperAgent/issues/151) | Main/Router 固定、活跃 Worker Session 动态成员；Work 视图在既有 1000 条读取预算内聚合全部 Work Items，并按 running/waiting-delivery/waiting-human/delivered/stopped 分组。停止先确认再走 `work-stop`；备注使用结构化 `followUp` 进入用户跟进，备注草稿跨轮询和分组保留。 | 客户端定向测试覆盖五分组、停止命令载荷、备注失败关闭、轮询状态和真实产品壳入口。没有把活动搜索的观测结果混入成员 dock。真实 Host 长轮询、网络乱序和远程设备未作为本票证据。 |
| [#152](https://github.com/IceFireIcer/DS-SuperAgent/issues/152) | 启动窗、place、picker、日志、通知、下载、电脑指示器、材质 CSS 和打包辅助脚本迁入。启动窗负责数据/引擎/页面阶段与失败重试，主窗交接后使用现有产品窗口；失败页支持未完成产品恢复的撤销。浏览器 cookie、凭据和记忆导入继续使用各自隔离流程。 | 旧 Bot 团队启动导入不迁移，也不读取 `~/.dsh` 或旧 Bot 存储；`onImport` 和启动页模型导入动作已拒绝，启动页不再提供团队复制。真实 Electron 启动窗/主窗交接、系统通知、picker、下载、日志轮转、pack/dist 和安装包矩阵仍需环境验收。 |
| [#153](https://github.com/IceFireIcer/DS-SuperAgent/issues/153) | 连接器注册/保存/导入、GitHub/飞书 Host OAuth、固定本机回环回调、邮箱账号、规则、搜索、读取、回复、IMAP/SMTP transport 和持久待审批回复。OAuth 参数只来自 Host 配置；来源目标和账号可显式选择；失败路径返回可读错误。 | OAuth 回调只绑定 `127.0.0.1:38517`，远程客户端只收到不透明登录状态。GitHub/飞书真实 OAuth 应用、真实 IMAP/SMTP 邮箱、附件和线程差异未运行，不能声称真实授权或真实邮箱已完成。 |
| [#154](https://github.com/IceFireIcer/DS-SuperAgent/issues/154) | 飞书、钉钉、企微、QQ、微信、Discord、Slack、Telegram 八个适配器接入登录、配对、收发和重试；配对消息进入 Main，不依赖旧 Bot/群运行时；二维码和登录状态有 TTL，错误与凭据按平台字段脱敏。 | 全部平台目前只有 mock 协议和契约验证。真实 token、Gateway/Socket/Stream 回调、开放平台审核、真实二维码扫码和真实账号收发都未验收，因此不宣称 8 平台真实可用。 |
| [#155](https://github.com/IceFireIcer/DS-SuperAgent/issues/155) | 能力库支持保存、删除、审批、绑定、解析和重启恢复；MCP/技能/能力包按 role/workItem/environment scope 注入，Worker MCP 只存在于真实本地 WorkItem + Environment，技能内容进入 Main/Router/Worker 指令。绑定不会绕过凭据 grant，审批撤销不再依赖资源仍为 active。 | 真实外部 MCP 服务、真实模型、真实 Worker 和 PostgreSQL 未接入本票验收。页面与本地 loopback mock MCP 契约已覆盖，不能把 mock 授权撤回当成真实外部服务验收。 |

## 验证

- Node 24.22.3 隔离服务端定向 **55/55**：Main 委托/控制、连接器与邮箱、IM 契约、能力库、产品 Host 和客户端网关。
- Node 24.22.3 客户端定向 **18/18**：任务板与产品壳、连接器设置、IM/微信二维码、能力库、i18n 和中文翻译完整性。
- Node 24.22.3 桌面定向 **45/45**：启动窗/主窗、恢复回滚、唤醒失败、picker、下载、通知、日志、电脑指示器和包装配。
- 隔离 `ds-superagent` profile 冒烟最终通过；Main 的本地 Worker 工作、原生 Session 拒绝、观察历史和导出拒绝均由 mock 模型验证。首次运行在旧回执断言处瞬时报错，复跑通过，因此不作为全量稳定或真实模型证据。
- `npm run typecheck`、`npm run build`、`npm run lint`、`dsh/scripts/build-client.mjs --check`、UI 边界检查和 `git diff --check` 通过。
- 未运行全量 CI、真实 Electron 包矩阵、真实飞书/GitHub OAuth、真实 IM 账号或真实邮箱；这些环境门槛仍归 #152–#154 及发布验收。
- 双轴复核见[记录](reviews/client-port-phase-two.md)。
