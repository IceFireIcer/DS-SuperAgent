# 主 Agent + Router + Worker：R5 独立产品与 UI 方案

- 日期：2026-11-14。
- 状态：产品架构修正稿；**主 Agent 为独立模型与独立上下文**、Router 负责分解派工、Worker 隔离执行，是本轮确认的目标。现有代码尚未实现该三层，不把方案当实现记录。
- 范围：运行时角色、上下文边界、主对话与只读观察、旧 Bot 退出、实施顺序。只改方案文档和离线报告，不改产品前端、正式规格、profile 或用户数据。

> 设计访谈 Q1—Q14 已全部收敛。Q13 按维护者修正：旧 Bot 架构移除，不提供“旧协作历史”入口，不做旧 ds-bot 产品兼容；Q11/Q12 的可审阅预设与资源导入保留。Q14 已确认输入框“停止生成”只停 Main 回复，后台工作使用目标明确的工作卡停止。详见 [设计访谈记录](decision-frontier.md)。

## 1. 这次纠正了什么

对照原文章、原型与现有代码后，发现一个必须写清的命名差异：

- 原文的“双层架构”把常驻的 **Router 层**同时当作主 Session/orchestrator：它承接人类交互、评估 Trigger、接单、分派并向用户回复。
- 原型的 Glossary 把这一角色称为 **Main Session = orchestrator**；代码和提示词中对应 `orchestrator` 或 Router。
- 当前 `superagent` 实现只有 `router` 与 `worker` 两种模型角色；`NativeSessionRequest.role` 与 `RoleConfig` 会拒绝第三个角色，`ds-bot-host.ts` 也只配置 Router/Worker 路由。

本轮维护者要求的架构更明确：把“面对用户的主 Agent”从 Router 中拆出来，形成真正的三层：

```text
用户
  ↓
主 Agent（独立模型、独立 Session、独立长期上下文）
  ↓ WorkBrief / 工作委托
Router（独立模型与上下文；工作分解、Tickets、Assignments）
  ↓
Worker Sessions（每项工作隔离执行，可再使用子代理）
  ↓ Report / Attention / Outcome
Router
  ↓ 精简结果与需要人的问题
主 Agent
  ↓
用户
```

因此 R3 的“主对话是 Router 产品投影”结论**作废**。R4 把主 Agent 作为真实运行时角色；同一授权工作空间保持一条连续主对话，上下文满后可显式换代并保留身份与连续性。Main 可使用受权的只读查询能力，具体执行和 Worker 分派仍由 Router/Worker 负责。

## 2. 三层角色契约

| 角色 | 独立模型与上下文 | 主要职责 | 明确禁止 |
|---|---|---|---|
| **主 Agent / Main** | 是。独立 model route、可换代 Session、连续主对话；不同隐私空间隔离 | 日常问答、澄清、委托；查询工作状态，按需读取获授权的有界交付物与证据；呈现关键问题和结果；将用户自然语言跟进交给 Router | 不直接创建 Ticket/Worker；不执行文件修改、Shell、浏览器操作；不默认接收或整段导入 Worker transcript；不成为第二个 Router |
| **Router** | 是。独立 model route 与协调上下文；跨 Ticket 但不读主 Agent 全部私聊历史 | 接收 WorkBrief 或已授权来源事件；评估、拆分和关联工作；建立 Ticket/Mandate/Assignment；分派 Worker；处理 handback、跨任务协调、汇总与回传 | 不直接与用户聊天；不把原始 Worker 日志塞回主 Agent；不替 Worker 做任务内实现规划；不修改主 Agent 人格/模型 |
| **Worker** | 是。每个工作独立 Session；执行上下文隔离 | 阅读原始证据与 WorkBrief；在本工作 Mandate 内调查、修改、验证；使用工作所需工具；可在内部使用 Subagent/Agent Team；向 Router 报告 | 不直接对用户发消息；不跨 Ticket 读数据；不修改主 Agent；不自行扩大授权或新建下一层任务 |

“主 Agent 不污染”不是一句提示词，而是四个隔离：

1. **模型隔离**：Main/Router/Worker 使用各自 route；Main 的模型可以偏沟通与总结，Worker 用适合执行的模型。
2. **Session 隔离**：主 Agent 的主对话只有自己的 DSH Session；Router 与 Worker 的 Session 不拼进同一上下文。
3. **上下文投影隔离**：Main 默认只收到 Router 的结构化 `WorkReceipt`、关键 `WorkUpdate`、`Attention` 和有界 `WorkOutcome`，不接收完整 Worker transcript、逐条工具输出或大段日志；用户明确要求核查时可按权限读取必要片段。
4. **权限隔断**：Main 可委托、追问、查状态和读有界证据，不能直接创建 Worker 或执行文件修改、Shell、浏览器操作。UI 打开执行详情不会自动注入 Main；明确目标的 UI 停止、当前有效问题卡的明确答案是经鉴权的核心命令，不依赖 Main/Router 推理。三层模型与指令在既有设置页分别配置，不给 Agent 自主修改配置的权限。

### 角色设置与模型生效

复用现有设置页的 `Roles`，分别配置 Main、Router 和 Worker 默认模型与指令，允许三层选择相同模型。配置保存形成新版本；正在进行的模型回合继续原版本，后续合法请求才使用新配置，不因保存而取消、重建或重做已有工作。角色设置是明确授权的管理入口，与 Router/Worker 观察页只读并不冲突。

## 3. 数据流与两条入口

### 3.1 用户会话入口

1. 用户在主对话发消息；产品将稳定事件写入 Engine，并交给 Main Session。
2. Main 判断需要行动时生成 `WorkBrief`：稳定 ID、用户请求依据、目标、约束、验收条件、关联引用、是否有 A/B 多工作意图。
3. Router 接收 WorkBrief，负责把它分解为一项或多项 Ticket；不要求 Main 先替它拆分。
4. Router 为每个 Ticket/Mandate 创建 Assignment，选择 Worker Session；Worker 只看到本工作所需证据。
5. Worker 将进度、问题、结果、证据摘要交回 Router。
6. Router 仅在工作完成、失败、需要用户决定或重要方向变化时主动发送有界 `WorkUpdate`/`WorkOutcome`/`Attention`；Main 负责自然语言回应。普通步骤只更新观察页，独立工作完成即可分别汇报，不等待其他 Worker。
7. 用户后续说“A 先不要发布”时，Main 用 `WorkFollowUp` 带上工作引用与方向变化；Router 把它送到 A，不新建 B 工作。

### 3.2 外部来源入口

- 外部新的人类请求进入其所属 Main，由 Main 理解后委托 Router；不因来自 GitHub/飞书就绕开已确认的用户交互入口。
- 已合法关联的既有工作跟进，以及 PR、CI、设备等环境事件，按归属和订阅受控直通原工作或进入 Router；不先把全文塞进 Main。
- Main 仅收到必要的关键变化摘要，普通消息不逐条唤醒。结果默认回原请求信道；桌面 Main 可查询获授权摘要与关联，但私人背景不自动进入公开 Issue 或群聊，跨隐私范围发布须有明确授权。
- 两条入口都必须由同一 Engine 记录归属、去重、授权和幂等，不能形成两个互不相识的调度器。

## 4. 主 Agent 的上下文预算

第一轮已确认 Main 可查询工作状态并按需读有界证据。进入 Main 的内容限制为：

- 用户消息与用户可见回复；
- Main 自己的 `WorkBrief` 回执和工作索引：Ticket ID、标题、状态、最近摘要、是否等待用户；
- Router 的完成、失败、需要人决定及重要方向变化摘要；普通步骤留在观察视图，不逐条唤醒；
- 需要用户回答的明确问题与选项；
- 用户主动要求核查时读取的受权摘要、必要原文片段或交付物，而不是默认推送完整日志。

默认不进入 Main 的内容：

- Worker 的逐条 tool call / tool output、Shell 输出、完整 diff、测试日志；
- Router 的内部推理和原始批处理全文；
- 其他 Instance、其他用户、其他 Ticket 的私密数据；
- 旧 Bot 私聊/群成员消息的全文迁移内容。

这与“可以看过程”不冲突：UI 可以从 Engine 的受权只读投影加载 Router/Worker 细节；阅读行为不把内容自动写进 Main Session。

## 5. UI：主对话 + Router 过程 + Worker 执行

继续复用现有 `ds-bot` UI 组件，不创建替代前端。结构：

```text
┌───────────────────────┬─────────────────────────────────────────┐
│ DS-SuperAgent         │ 主 Agent / DS-SuperAgent 主对话          │
│                       │                                         │
│ ● 主对话       默认   │ 用户：修复 A，并独立调查 B               │
│                       │ 主 Agent：我会分别推进 A 与 B            │
│ 执行过程              │ [工作 A：修复登录异常] [工作 B：调查性能] │
│   Router        只读  │ [需要你回答的问题 / 交付结果与证据]      │
│                       │                                         │
│ 正在执行 (2)          │ 这里只显示主 Agent 的对话与有界摘要，     │
│   修复登录异常  执行中│ Worker 原始日志不灌进主上下文            │
│   调查性能瓶颈  等待中│                                         │
│                       │                                         │
│ 已完成 / 历史    折叠 │                                         │
│ 角色预设 · 资源       │                                         │
│                       │                                         │
│ 工具与资源 · 设置     │ [消息、附件、语音与受控工作操作]         │
└───────────────────────┴─────────────────────────────────────────┘
```

- **主对话**：同一授权工作空间内连续的 Main 主对话；默认显示、唯一日常输入区；发送用户消息，呈现 Main 的回复。切换执行视图不会另建 Main，不同隐私范围不混用。
- **Router 过程**：只读查看 WorkBrief 如何被分解、生成哪些 Ticket、为何关联/拒绝/交回、Worker 分配与状态；没有输入框或 steer。
- **Worker 执行**：由真实 Ticket/Assignment/Session 自动生成；可查看步骤、工具事实、输出、设备、报告、证据；不能直接聊天、审批、重试或重放工具。
- **工作卡片**：由 Engine 的 WorkLink 投影；主对话看到摘要和“查看执行详情”入口，点开只打开只读视图，不把详情写回 Main。
- **问题卡**：Worker 向核心提交受权 Attention，经 Router 组织成主对话中的结构化问题，Main 可用自然语言解释。用户明确选择可直接提交给受信核心，核验工作、用户权限、当前问题及版本后送回原工作，不让 Main/Router 改写原始答案；问题过期或已变更时拒绝旧答复，执行观察区不提供回答输入。
- **自动出现**：Worker 开始时在左侧新增条目和状态提示，不弹窗、不切走主对话、不抢焦点；刷新/重连按工作身份重建，不按一次 Session 创建一个“新 Bot”。
- **明确停止**：在主对话/产品工作卡片上选定工作后，停止直接调用经授权的核心命令，先持久记录停止并传播取消，再通知 Main/Router；目标不明的自然语言停止才先澄清。输入框“停止生成”只终止 Main 当前回复，已提交/已派出的工作继续；若委托提交结果未知，按原稳定身份对账，不用停止回复猜测它未提交。全部停止如提供，须独立显示范围。
- **Main 暂不可用**：主对话明确标记模型故障，核心状态、结果、待处理问题卡仍可展示，已授权工作继续。已确认的停止和有效问题卡答复保持可用；新自然语言输入持久排队，恢复后补读，不将系统事实卡冒充 Main 回复，也不重复交付已经展示或已发送的内容。

## 6. 只读与权限边界

只读不能只靠隐藏按钮：

- 主对话写命令：`WorkBrief`、`WorkFollowUp`、`WorkControl`、`AttentionAnswer`，并要求来源归属、工作目标和用户授权。明确停止与问题卡答案由受信 UI 直接到核心，Main/Router 接收事实通知；自然语言中的歧义仍由 Main 澄清。
- 观察视图读命令：Role-scoped transcript、ticket summary、assignment status、tool facts、report/evidence、outcome；按 Instance + role + Ticket 归属过滤。
- Router/Worker 观察区不允许 prompt、steer、retry、cancel、approval、tool replay、fork-and-prompt 等写动作。用户回到主对话或明确的产品控制卡片发起授权操作；已明确目标的 UI 停止可直接到核心，不等待 Main/Router 推理。
- 当前 gateway 的 `read`/`command` 权限粒度是 Instance，不足以表达角色视图；需要新增角色感知授权/查询投影，或在产品层建立同等服务端检查。
- `getSessionHistory` 当前只是通用读取，不验证 Session 属于哪个 Instance/Ticket/角色；不能直接暴露给客户端。工单读取的归属检查也不能自动推导为 Router 全量历史访问权。
- 前端隐藏、快捷键、上下文菜单和原生 DSH composer 都可能成为旁路；普通 Agent Session 页面不能直接当作只读 Router/Worker 页面。

## 7. 主 Agent / Router 协议的最低契约

以下不是已实现接口，而是 to-spec 必须补齐的边界：

| 对象/命令 | 方向 | 最低要求 |
|---|---|---|
| `WorkBrief` | Main → Router | 稳定委托 ID、Main Session/Turn、原始用户依据、目标、约束、验收、证据引用；同一 ID 重试不重复建工作 |
| `WorkReceipt` | Router → Main | 接单/拒绝原因、建立的 Ticket 列表、关联已有工作、需要 Main 知道的下一步 |
| `WorkUpdate` | Router → Main | 仅关键状态/方向变化、责任方、用户可见摘要；普通步骤不逐条唤醒 Main，不回传 Worker 全量日志 |
| `Attention` | Router → 主对话问题卡及 Main 通知 | 结构化问题、选项、关联工作、回答所需授权；UI 可直接提交原始选择，核心拒绝过期/失权回答，不等待模型改写 |
| `WorkFollowUp` | Main → Router | 引用原工作/Ticket、方向变化、来源依据；由 Router 决定直通或重新研判 |
| `WorkControl` | Main → Router；明确 UI 停止可直接进核心 | 明确目标和用户授权；不得按“最近一个 Worker”猜；已确认的 UI 停止不等待模型，恢复和重试交互另按规格收敛 |
| `WorkOutcome` | Router → Main | 成功/失败/未知/等待、交付物引用、可验证证据摘要、后续可选动作 |

其中 `WorkBrief` 不能被 Router 当作新的用户原文；Router 必须保留原始用户事件和 Main 的委托依据，Worker 读取原始证据。Main 的摘要是导航，不是事实替代品。

## 8. 失败、重连与代次

- Main 失败：已授权的 Router/Worker 工作继续；主对话标记 Main 暂不可用并展示持久状态、结果和待处理问题卡，明确停止与有效问题答复保持可用。新的自然语言输入持久排队；恢复后按稳定输入/outcome 身份补读，不重发已提交 WorkBrief、不重复建工或送达，也不把事实卡冒充模型回复。
- Router 失败：Host 恢复逻辑接管同一逻辑 Router；Main 显示“协调暂不可用”，不把 Worker 结果伪造成成功。
- Worker 失败/换代：保留 Ticket/Assignment/Session 关系；旧代迟到回调无效；主对话只收到有界失败摘要。
- 用户停止：已明确工作目标的 UI 操作先由受信核心持久记录停止并传播取消，再通知 Main/Router；自然语言歧义先澄清。重连、重试或 Worker 完成都不能自动解除停止；停止请求已记录与执行已实际静止分别显示。
- 外部结果未知：Router 向 Main 回传 `unknown` 与责任方；Main 不把“没收到回执”说成失败，也不擅自重做。
- 同一工作重复出现：按 WorkBrief/Ticket/Assignment 身份去重；刷新不能让 Worker 变成新的 Bot 联系人。

## 9. 独立产品与旧架构移除

- 新主 Agent 与 Router 不继承旧 Main Bot 管理权；旧名称、模型、指令、技能和形象可审阅后提取为可选角色预设，不自动建立旧 Bot 身份或额外 Main。
- 新产品移除旧 Bot 联系人、内部群轮次、Bot 互派、团队管理、旧 profile 选择和兼容路径；不设置旧私聊/群聊历史入口，也不提供原 ds-bot 的客户端/API/完整状态格式兼容。
- 只保留新产品自身 Main/Router/Worker 的工作与执行历史；Q6 的“完成后可查历史”不指旧 Bot 聊天档案。
- Q12 的私有记忆、浏览器和凭据先保留归属，经预览和明确授权后选择导入新资源，不自动合并到 Main 或全局资源。这是可选初始化，不要求完整迁移旧软件。
- 去掉旧架构不是清空用户磁盘数据，也不自动重放旧未完成工作；本轮只变更方案，后续实现用隔离虚构资料验证。
- 原前端的可用组件与能力继续复用；浏览器、MCP、Office、附件、记忆和日程按新角色/资源接入，不以“不兼容”为由删除已要求的能力。产品升级和故障恢复只面向 DS-SuperAgent 自身，不回切旧 dispatcher。

## 10. 实施顺序上的变化

1. **阶段 0 综合已确认契约**：Q1—Q14 已收敛；将三层、三视图、直接控制、来源分流、隐私、可选导入和无旧兼容写入正式规格，不再重新开产品问卷。
2. **阶段 1 先做 MainSession 与 WorkBrief**：主 Session 持久化、WorkBrief 稳定 ID、Router receipt、主上下文投影、Main/Router 恢复与去重；不做 UI 美化。
3. **阶段 2 做真实竖切**：主对话发 A+B，Router 分解为两 Ticket，两 Worker 并行，Worker 只回 Router，Router 只回 Main 有界摘要；UI 同时出现只读 Worker 条目。
4. **阶段 3 补跟进/问题/停止/unknown**：自然语言由 Main 澄清和委托；明确 UI 停止及问题卡答复直接到受信核心并通知 Main/Router；Router 将工作输入交给 Worker，Main 模型故障不阻断已有工作和明确操作。
5. **阶段 4 补角色设置与只读协议**：三套 model routes、角色提示词、只读观察 API、资源 scope 与角色预设；新 UI 不建立旧 Bot 历史或兼容入口。
6. 后续按新产品完成能力接入、可选资源初始化、旧架构移除及独立发布；不要求旧档案、旧 API façade 或旧 profile 回切作为前置，仍验收已保留能力和新产品自身的恢复。

## 11. 本方案的原始资料对照

- 原文章的双层架构明确把 Router 层当作人类交互入口，原型 Glossary 用 Main Session/orchestrator 指同一角色；这不是当前的三层实现。
- 当前 `NativeSessions`、`RoleConfig`、生产工厂与 Engine 只有 Router/Worker 两类角色，因此 R4 是明确的**新增角色与协议变更**，需要后续 to-spec 修改 D01/D17 及其依赖，而不是只改 UI 文案。
- 本文件保留对原 Router/Worker 协作、Ticket/Assignment、来源直通、恢复和权限机制的复用；新增的是主 Agent 的独立会话与有界回传，不是另造一套执行引擎。
