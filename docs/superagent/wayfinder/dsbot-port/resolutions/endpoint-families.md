# 设计 C 类 product endpoint 族边界与首批样板：决定

对应决策：[设计 C 类 product endpoint 族边界与首批样板](https://github.com/IceFireIcer/DS-SuperAgent/issues/140#issuecomment-7001829136)。

## 结论

1. 按同一读模型/同一命令边界聚合；页面只在客户端组合。
2. 团队域保留 `session-changes`、`side-chat`、`learning-decide`、`attention-dismiss`；排除 `exchange-*`、`bot-*`、`room-*`、`agent-*`、`goal-*`、`set-main`。任务板/成员状态转 #135。
3. 远程白名单扩展：所有 C 族允许远程；具体分权按「确定远程客户端执行写命令与设备操控的授权边界」的 `read`/`command`/`device` 三档执行。OAuth state/PKCE、密钥、审计留在 Host；客户端可单独撤销。
4. 首批三个样板族：`connector-registry`、`connector-auth`、`usage-breakdown`。
5. C 族统一 `scope: { role, workItemId? }`，不再接受 `botId`。

## 过滤后的规模

约 59 个静态 C 调用 + 16 个 `computer-*` 子端点，收敛为 35 个族、约 175 个改造点（≈88 人日，±30%）；成员状态与任务板另计。

| 域 | 族数 | 改造点 | 备注 |
|---|---:|---:|---|
| 会话剩余项（changes/side/learning/attention） | 4 | 18 | 不含 Bot/群聊 |
| 模型/Provider | 2 | 7 | provider-save / provider-models |
| 连接器/邮箱 | 7 | 34 | 首批样板在此 |
| IM/手机 | 5 | 30 | 平台适配器 + link |
| 浏览器 | 4 | 20 | 需桌面 bridge |
| 记忆 | 5 | 24 | 扩展现有 product-memory |
| 能力库 | 1 | 4 | 仅 capability-save；capability-bind 排除 |
| 通知 | 1 | 3 | notices-read |
| 工作区资产 | 1 | 4 | workspace-asset |
| 用量 | 2 | 8 | 首批样板之一 |
| 电脑操控 | 3 | 23 | 需 app bridge |
| 合计 | 35 | 175 | ±30% |

## 首批样板

- `connector-registry`：读模型与存储的样板。
- `connector-auth`：外部 OAuth、回调和 pending 状态的样板。
- `usage-breakdown`：DSH session projections 聚合读模型的样板。

## 后续

- 远程写命令与设备操控的授权边界见「确定远程客户端执行写命令与设备操控的授权边界」。
- 浏览器/电脑操控仍受 app bridge 约束；无 bridge 时 fail-closed。
