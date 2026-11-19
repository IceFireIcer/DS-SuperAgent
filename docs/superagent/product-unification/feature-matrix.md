# 旧操作到 DS-SuperAgent 独立产品的处置盘点 R5

- Q1—Q14 产品方向已确认；本表记录旧能力的去向，不是实现状态或正式协议规格。
- 沿用上轮按 `ds-bot/src/host/channel.js` 逐项整理的 85 操作清单；本轮不以 route 数量代替协作验收或声明已运行验证。
- 浏览器、MCP、Office、记忆、日程等能力和隐私保护继续接入；旧 Bot 架构、旧聊天历史入口与旧客户端/API 兼容义务已由 Q13 排除。
- “Core”指 Engine 的持久输入、授权、工作身份、Effect/Receipt/历史与 query；具体功能仍通过 bounded adapter 执行。
- 处置分为新能力接入、三层语义重构、删除旧机制、可选配置/资源提取；不建设旧兼容 façade 或旧档案浏览。本轮只改方案，后续在正式规格下实施。
- 九个功能族完整列出 85 个旧操作名称，用来避免误删保留能力，不代表承诺继续提供这 85 个接口。新合同在 to-spec 中明确输入/输出、授权、数据、失败与恢复，不要求旧客户端可用。

## `/api/bot` 85 个 HTTP 操作

| 功能族 | 旧操作清单（不是全部原样复活的承诺） | 现状责任 | 候选处置与新协作验收 |
|---|---|---|---|
| 状态与模型配置（17） | `state`, `models`, `efforts`, `thinking`, `providers`, `provider-key`, `provider-add`, `provider-models`, `provider-remove`, `set-prefs`, `repo-stars`, `update-check`, `update-install`, `dsh-update-install`, `diagnostics`, `diagnostics-log`, `diagnostics-clear` | `channel.js` 聚合旧 roster/state；模型 provider、DSH profile、updates、diagnostics 分散在 Host/desktop service | 能力保留 + state 语义重构。聚合 Instance/讨论/工作/运行健康与受控配置；Router/Worker 模型配置不伪造 Bot roster；provider secret、revision、冲突与更新行为保留，纯诊断不建 Ticket |
| Bot、Agent、角色（16） | `create-bot`, `update-bot`, `duplicate-bot`, `delete-bot`, `private-release`, `set-main`, `set-flags`, `avatar-library`, `avatar-import`, `avatar-delete`, `add-agent`, `agent-session`, `agent-adopt`, `agent-archive`, `agent-rename`, `remove-agent` | `roster.js` + JSON roster/Agent helpers + avatars/config | 删除长期 Bot/团队治理与旧 Agent adoption 入口；Main/Router/Worker 分别配置模型与指令。名称、模型、指令、技能、形象经审阅后可提取为可选预设，不建立旧联系人，不继承 set-main 管理权，不建设旧历史 UI |
| Group 与成员协作（7） | `create-room`, `update-room`, `delete-room`, `room-progress`, `stop-member-work`, `stop-room-work`, `approval-answer` | 群 relay Session、各 (room, bot) 独立成员 Session、ordered/parallel round、relay、stop 与审批 | 删除旧内部 Bot 群、relay/round 与成员派活。外部群仍可作来源 Thread，Worker 内部 Team 继承授权；停止和问题答复按明确工作/问题目标走新核心。无旧群历史入口或旧群接口兼容 |
| 对话、交付、历史（17） | `exchange`, `exchange-text`, `file-text`, `earlier`, `chat`, `run-stats`, `usage`, `dismiss-question`, `dismiss-view`, `answer-question`, `view-reply`, `send`, `btw-delete`, `side-new`, `side-ask`, `side-cancel`, `side-close` | `channel.js`/`parts.js`/`feed.js`/`side.js`、DSH native Session transcript、usage ledger | 复用聊天/卡片/附件组件，接独立 Main、明确问题卡、只读 Router/Worker 与新工作历史；保留分页、用量、重连和真实回执。删除旧 exchange 派活和旧聊天档案读取要求，不面向原客户端作兼容承诺 |
| 文件夹与工作区（4） | `folders`, `folder-pick`, `folder-list`, `team-workspace` | `folders.js`、`parts.js`、工作目录选择器、团队/个人目录规则 | 能力保留 + 资源 scope 重映射。由 Instance 默认、工作覆盖和显式资源授权解析 Assignment 的 Environment/目录/指纹；旧 Bot/群目录提供迁移候选，不默认全局共享。保留系统选择器，修改配置不追溯搬迁在途工作 |
| 记忆与学习（4） | `memory-view`, `memory-ask`, `memory-forget`, `learning-answer` | `memory.js` / `learning.js` 的 Bot 与 Group 归属、私有/共享权限、学习提案和 background review | 保留查询、遗忘、学习提案/审批、原文与撤权。旧记忆仅在预览归属和明确授权后选择导入新资源，不混入全局/Main，不要求旧聊天归档或完整旧状态兼容；引用召回不冒充长期记忆质量已解决 |
| Secrets、Connectors、Capabilities（12） | `secret-set`, `secret-allow`, `secret-cancel`, `secret-update`, `secret-delete`, `connector-connect`, `connector-disconnect`, `connector-retry`, `capability-save`, `capability-delete`, `capability-approve`, `bot-capability` | `secrets.js`, `connectors.js`, `capabilities.js`、DSH provider/MCP services | 能力与保护保留 + grant 重映射。受控 vault/reference、MCP tools、connector/source 配置继续可用；bot-capability 的目标需版本化转为合法 role/work/Environment scope，不继承旧 Main Bot 权力。凭据不进入响应/prompt/log；来源接收和工具/外发权限分别检查 |
| Schedules（3） | `schedules`, `schedule-create`, `schedule-delete` | DSH `schedule` service + `schedules.js` 再投到旧 Session | 能力保留、投递语义重构。occurrence 作为稳定 Source Event/Input，绑定明确目标与授权而非长期 Bot Session；去重、取消、stop、outbox 和执行/轮询失败分类均保留；不因定时事件解除人工停止 |
| Browser（5） | `browser-wait`, `browser-result`, `browser-takeover`, `browser-give-back`, `browser-stop` | Browser plugin/session + app CDP/BrowserView bridge + UI state | 能力保留 + 资源身份重映射。保留独立 profile/登录态、CDP、卡片、人工接管、stop/unknown；从每 Bot 浏览器改为已授权 Browser resource/Environment 的候选映射。多个工作并发使用的租约与冲突必须明确，不把旧 profile 合并为一个全局浏览器 |
| 控制面总览：以上共 | **85 operations** | 完整旧接口盘点，不是 85 个都要原样活跃 | 每个操作有处置、能力去向与验收/待决证据；协作变化经确认与协议版本化，不假成功、不无声删除、不恢复旧 dispatcher |

## API 外也必须迁移的功能

HTTP route 数不能代表全量功能。产品能力还在以下主动入口/生命周期中运行，须并入 feature inventory 和验收：

| 功能面 | 旧实现/入口 | 新核心接入计划 |
|---|---|---|
| Bot 可调用的 team tools（至少 `list_bots`, `message_bot`, `stop_bot`, `create_bot`, `update_bot`, `list_bot_models`, `create_group`, `update_group`, `delete_group`, `post_to_group`, `ask_user`, `show_view`, `list_capabilities`, `save_capability`, `delete_capability`） | `ds-bot/src/host/tools.js` 的 Session scoped tool registry | 分开角色配置、工作控制、内部委派、人工问题/Views 和能力管理；message_bot 不能原样成为 Worker 自主派活总线，Main Bot 管理工具不直接授给 Router；核对旧工具对 DSH subagent/workflow 的屏蔽，保留新工作合法内部委派 |
| Group/memory/browser tools（`group_relay`, `read_own_chat`, `read_group_chat`, `remember`, `forget`, `recall`, `read_browser` 等） | `groups.js`, `memory.js`, `browser.js` 在 DSH tools/events/session scopes 安装 | 删除 group_relay 及旧私聊/群档案模型；记忆、浏览器与新产品原文读取按受权资源接入。外部群是来源、内部 Team 属于 Worker，不恢复旧 Bot 群或给 Main 默认注入执行全文 |
| DSH hooks / Agent events | `turns.js`, `parts.js`, `resume.js`, `permissions.js`, `feed.js`, `usage.js`, `memory.js`, `capabilities.js`, `learning.js` 注册 hooks/effects | 按作用分类为 DSH runtime integration hooks / Core event projections / Feature adapter side-effects。逐项 owner；不要留第二套执行回合、第二份 work state 或旧用户 follow-up dispatcher |
| 搜索、压缩与上下文连续性 | `chat-index.js`, `parts.js`, memory recall/FTS、DSH compaction hooks | 历史与召回 adapter 可在迁移核心后提供 read capabilities。DSH per-session policy 缺口只能靠公开上游 API 或 product-owned bounded strategy；不得 patch DSH |
| Office、文件附件、图像与表单 | `office-skills.js`, `office.js`, attachments, `deep-view` views | Core 对文本、文件/image refs、Office operation、structured view/answer 建消息与授权 contract；附件内容存 Environment/context store，不在 API 中丢块；保持 UI card/view schemas |
| Browser host/app bridge | `browser/session.js`, `browser/mount.js`, `app/bot-views.mjs` 等 | 保留 Host bridge/desktop CDP 生命周期作为 capability implementation，Core 管 operation scope、deadline、cancel、review 和投影；旧 Browser UI action routes 映射到 capability ledger |
| Scheduler、updates、diagnostics、usage | DSH services 和 app/host timers | 后台管理功能用可靠的 Core effects/source event semantics；纯配置/诊断保持 read/config services；不要所有操作硬塞成用户任务 Ticket |
| Mobile | `mobile/` Expo skeleton；既有移动端计划与 Host 协议 | 保留客户端能力目标，不假定已接通；适配同一工作/讨论投影和来源权限，而不是复制 Bot 队伍调度；撤销、补读、卡片与新语义要端到端验收 |
| 外部 sources / hosted / remote device / Watchdog / Supervisor | Super-agent modules and separate T25–T58 work; not all production desktop wiring | 仅按产品需要开启；对应 Instance/Environment/source/Host/Role setup 明确实例化与授权。模块“存在”不等于 desktop profile 已部署 |

## 必须维持的用户行为基线

- 现有 UI 是组件与能力基线，不是旧协作语义永不变的要求。菜单、成员、停止范围等有变化须由维护者确认并配套新场景；本轮未改产品 UI。
- 每个保留能力至少有正常、拒权、数据缺失、新历史、重复、中断/恢复、stop/撤权及 UI 回显场景；删除的旧机制验证无遗留入口或输入消费，不再要求旧客户端可用。
- 功能 adapter 明确 “在哪运行、读写哪套数据、属于谁、如何停止、失败/unknown 怎么呈现、在 Core 怎样查到 effect/result”。
- DSH 自身能力（model providers, native Session/loop, extension slots, host filesystem/process) 继续从 DSH 公共 API 取服务。Super-agent 是产品业务核心，不是 DSH Runtime 替代品。
- 保留能力验证新模型下的用户价值、权限、错误与自身历史；删除旧架构不要求兼容验收。85 项有处置不等于已实现，也不允许借此丢弃已要求的浏览器/记忆等能力。
- 新产品协议、运行入口和数据归属明确；移除旧 profile/兼容层时审查引用，避免误删公共 DSH 接缝或保留能力。本轮不实际删除代码/数据。
