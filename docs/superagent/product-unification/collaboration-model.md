# 协作模型复核：不是把 Bot 改名为 Worker

- 日期：2026-11-14；类型：当前代码事实、既有规格与产品建议的分层记录。
- 结论边界：本轮静态核查，不是新增运行验收。文中的候选产品含义等待维护者确认。
- 上一版计划失效的关键假设：把“保留现有 UI/功能”当作“必须保留原 Bot 团队的调度与交互语义”。

## 1. 用户指出的问题成立，但要说准

Super-agent 并不是“只有一个模型、不能有多个 Agent”。它仍由多个 Agent/Session 支撑；区别在于**用户与系统怎么协作，以及系统按什么对象组织工作**。

- DS Bot：用户面对一组长期具名 Bot；每个 Bot 在私聊、不同群里有自己的上下文。Bot 互相请求、群 relay 调用成员、结果按发送者/群关系回传。
- Super-agent 三层目标：用户面对独立 Main，Router 保持工作关联与协调，具体执行交给隔离 Worker；一项复杂工作内部才可能有 Agent Team。第一轮已确认 Main 可问答、查状态和按需读取有界证据，实际文件修改/Shell/浏览器操作仍交给 Worker。
- Router 不是 Main Bot：Main Bot 是旧产品的团队管理权限角色，可以有多个；它不是旧系统全部消息的必经中央调度器。
- Worker 不是长期联系人：它属于授权工作与当前执行安排，Session 可以复用或换代，不应由侧栏某个 Bot 的长期身份永久占有。

官方文章本来就区分了轻量 Router 与深入拆解单任务的 Team Lead，也明确同一聊天页面可以在底层分派多个 Worker。见 `super-agent-references/super-agent reference/super-agent.md:64`、`:74`、`:87`、`:120`、`:139`。

## 2. 并排比较

| 维度 | DS Bot 现有模型 | Super-agent 规格与核心模型 |
|---|---|---|
| 用户的协作对象 | 长期 Bot 团队，私聊或群内找成员 | 同一个连续协作者，执行者是内部细节 |
| 工作如何划分 | 向目标 Bot/成员 Session 发 request，exchange/work 关联上下游 | 事件研判形成 Ticket，Assignment 绑定执行；不是一个 UI Session 永远一个任务 |
| 上下文身份 | Bot 当前私聊 part，以及每个群内独立 part | 三层目标为独立 Main/Router/Worker Session；当前核心仍仅有 Router/Worker；均与工作身份、Thread 分离 |
| 协调者 | Bot 相互请求，群 relay/round 管理群内调用；Main Bot 负责团队治理 | Main 面对用户并委托，Router 轻量处理工作间关联、分解和派工；关键摘要回 Main |
| 跟进路径 | 目标 Bot 当前私聊或群成员 Session 的 inbox/turn | 稳定事件经订阅 fan-out 给合法 owner；范围外 handback 后再研判 |
| 同层协作 | message_bot/post_to_group/@ 与结果回传 | 通常各自推进；经关联 Thread 得到事实或经 Router 受控协调，不要求 Worker 点对点聊天 |
| 单任务内部拆解 | 旧工具主要鼓励向其他长期 Bot 派活 | Worker 可在本工作授权内使用子代理/Agent Team |
| 用户可见输出 | 多个 Bot 在私聊/群中发言，round 可结束后再有 late reply | 主要结果/Attention 统一组织与可靠交付；受控确认/回答是窄例外，执行细节按需查看 |
| 停止与恢复 | Bot 私聊、群成员、整个群、sender/exchange 等位置关系 | 持久 Ticket stop、Assignment 代次、Mandate、输入消费、未知效果与恢复事实 |
| 配置与资源导入 | 原 Bot 身份、私聊/群和资源在旧产品中存在 | 新产品不兼容旧运行/历史模型；只在审阅授权后提取配置/资源，不恢复旧身份、权限或派活 |

这不是“旧系统没有停止/恢复/可靠性”。旧源码已有这些保护；差别是**它们围绕 Bot/位置/turn/exchange 建模，而新核心围绕授权工作与执行代次建模**。

## 3. 本轮核查到的旧代码事实

- `ds-bot/src/host/roster.js:80`：Bot 创建时建立 Session 并以其 ID 为长期身份锚点；这不代表后续只有该一个 Session。
- `ds-bot/src/host/parts.js:266`：Bot 私聊当前 Session 与历史 segments 可换代，Bot 身份仍保留。
- `ds-bot/src/host/groups.js:248`：每个 `(room, bot)` 建独立群成员 Session；不是所有成员共享一个模型上下文。
- `ds-bot/src/host/roster.js:442`、`ds-bot/src/host/groups.js:1348`：群还有自己的 relay Session，合成 group_relay；它不是覆盖所有私聊的全局 Router。
- `ds-bot/src/host/tools.js:153`、`:228`：message_bot 私聊请求要自包含，经 exchange 投递；群内调用改为群 @，不进入目标私聊。
- `ds-bot/src/host/tools.js:17`：旧团队工具隐藏 goal/subagent/workflow/send_message 等原生调度入口并引导 message_bot。直接把这套工具策略装到 Worker 上，会把新架构拉回 peer Bot 模型。
- `ds-bot/src/host/groups.js:1057`、`:691`：admin/everyone/@ 决定 speakers，ordered round 与成员实际工作生命周期不是一个事件。
- `ds-bot/src/host/roster.js:611`、`ds-bot/src/host/tools.js:284`：Main Bot 可以多个，主要体现团队管理与停止权限；不能按名字推断它就是 Router。
- `ds-bot/src/host/groups.js:1258`、`:1280`：停止群成员/整个群只影响对应位置；同一 Bot 的私聊和其他群仍可继续。
- `ds-bot/src/host/resume.js:178`、`:321`：旧恢复有独立 inflight/exchange 与结果核查逻辑；executionAdapter 启用时会绕过旧投递恢复路径，不应两套同时消费。

以上由独占读取旧 Bot 源码的只读子代理核查。主代理只读文档和当前桥接文件，另一只读子代理只读 Super-agent 核心文件；没有并发读写同一源码。

## 4. 新核心不能退让的关系

- **Instance 是共享上下文/权限边界**，不是“一个 Bot”，也不是“整台电脑所有人的数据”。
- **Thread ↔ Ticket 是多对多**：同一个聊天讨论可有 A/B 两项工作，同一 A 可以跟踪桌面讨论、PR 与 CI 等多个 Thread。
- **Ticket → Assignment → Session/Environment** 分开；更换执行安排不等于丢失工作身份，也不保证半个 shell 从原点续跑。
- **新候选与已有工作上下文分开**：已有归属先直通；context-only 不获 owner 权、不解 stop；owner 全部 handback 后才重新 Eval。
- **Router 不是每条事件的 LLM 中转站**：轻量候选/跨任务协调、批处理与必要 notice；直接投递由程序机制完成。
- **主要交付与执行日志分开**：Report/Attention 支撑结果；Outbox 负责用途、目标与回执；不能简单将所有 Worker transcript 作为聊天回复广播。
- **角色配置与权限分开**：可有名字、模型、技能、专长，不因此变成长期 Bot，旧记忆/浏览器/secret 也不会自动共享。

正式依据：`docs/superagent/spec.md:153`（D01）、`:169`（D02）、`:199`（D04）、`:211`（D05）、`:278`（D10）、`:301`（D12）、`:364`（D17）、`:372`（D18）；以及既有 `wayfinder/resolutions/collaboration-state.md`。

### 当前代码机制与尚需接线的差别

另一只读子代理在核心源码确认了以下机制及缺口；这里不把规格目标写成当前已实现状态：

| 观察 | 当前源码证据 | 对计划的影响 |
|---|---|---|
| 一个 NativeSessions 对象串行维护一个 Router；Engine 接收外部注入的 sessions | `superagent/src/native-sessions.ts:27`、`:72`；`superagent/src/engine.ts:201` | 一 Instance 一逻辑 Router 是规格不变量，不是这些类自动保证的全产品单例；装配、跨 source 与重启连续性必须验证 |
| 接受工作保存 Trigger/Decision/Mandate/Ticket/Intent；assign_worker 面向 Ticket，不从 Bot roster 选人 | `superagent/src/engine.ts:486`；`superagent/src/execution.ts:693` | 新核心已有工作中心机制，不需要改成 Bot 名册调度 |
| 同一来源事件的普通 acceptSource/评估接受复用接受回执；一条评估 item 只有一个 receipt | `superagent/src/engine.ts:348`、`:464`、`:514`；`superagent/src/source-evaluations.ts:8`、`:243`、`:327` | “同一条 A+B 请求产生两项新工作”需要明确扩展契约；同 Thread 多订阅不证明复合请求分解已实现 |
| 合格人工跟进在订阅 fanout 中生成 WorkInput 并 relay；owner 是 Ticket 对事件的归属 | `superagent/src/work-inputs.ts:260`；`superagent/src/source-evaluations.ts:261` | 直通不是省略权限检查；一个 Thread 可多个 owner，范围判断与方向变化需验收 |
| handback_input 记录当前 Input 的交回；显式 requeueSourceEvent 要求所有 owner 已交回 | `superagent/src/execution.ts:1372`；`superagent/src/work-inputs.ts:407`、`:422`；`superagent/src/engine.ts:2271` | 未核实自动重新唤醒 Router/改派链；不能写成“调用 handback 就已自动重派”，阶段 3 补端到端证据 |
| delegate_subagent 是当前 Assignment 下的一层委派，子执行不拥有 Ticket 的交付/人工提问权 | `superagent/src/execution.ts:1181`；`superagent/src/subagents.ts:129`、`:313` | Worker 内部委派不等于长期 Bot 团队，也不能宣称任意嵌套 Team 都已支持 |
| addTicketNote、queueAnswer 等 API 存在，但已核查工具表未完整接线；note 保存不自动 relay | `superagent/src/engine.ts:2314`、`:1693`；`superagent/src/execution.ts:668` | 共享 Router 上下文不证明跨任务事实协调已完整；阶段 3 单列查证、受控投递与唤醒 |
| RoleConfig 当前是 Router/Worker 两份角色模板；还有 botExecutionProfiles 的消费接缝 | `superagent/src/config.ts:5`、`:64`；`superagent/src/execution.ts:1313` | 不能把任意多个旧 Bot 配置当作现成完整角色库；新的角色选择与资源 scope 尚需设计 |
| Ticket ended 和 Outbox 真正送达不是同一事实 | `superagent/src/deliveries.ts:64`；`superagent/src/outbox.ts:54` | 验收分别查工作结果与平台回执，不以 ended 证明用户收到消息 |

特别要区分“投递给 owner”与“判定这句话属于该工作”。当前 fanout 可以把同 Thread 的合格人工输入交给多个 owner，且不先经 LLM 判定语义范围。用户说“只改 A”并不证明接收层已只投给 A；新竖切必须验证范围内承接、其他 owner 的交回/不越界、歧义提问和重新研判。不能仅加一张 Thread→Ticket 表就宣称同窗多任务已经成立。

### 同一讨论多工作，不等于一条复合请求能新建多工作

定点复核确认了三个不同层级：

1. 不同来源事件可以各自被接受；多个已存在 Ticket 可以订阅同一 Thread。这证明输入与讨论的多对多基础，不证明一条消息会被拆为两项新工作。
2. 同一原生事件普通重复调用 acceptSource，即使换 commandId，也复用接受记录；若改变目标/环境等接受指纹则冲突。配置 Intake Policy 时还必须走评估入口；batch 支持多个不同事件，不接收同一事件的 A/B 工作项列表。见 `superagent/src/engine.ts:348`、`:378`、`:464`、`:514`；`superagent/src/source-evaluations.ts:243`、`:327`。
3. attachSourceEvent 可把完整原事件投给两个已存在 Ticket，但它不创建 Ticket、不产生各自独立的分项 scope。manual requeue 在所有 owner 已交回后能派生 trigger 并重新接受原全文，这也是重新研判，不是 A/B 分解。见 `superagent/src/engine.ts:2181`、`:2271`；`superagent/src/work-inputs.ts:182`、`:324`、`:422`、`:704`。

因此不能简单说“一事件永远只能一票”，也不能说“多订阅已经解决一条消息多任务”。后续规格必须定义复合请求分解的稳定工作项身份、各自 Mandate、原始证据引用、幂等与部分创建失败重试，以及 ownership、跟进和交付关系。不通过伪造多个来源消息或滥用人工 requeue 绕过这个缺口。

## 5. 当前接线为什么还不等于最终协作

`superagent/src/ds-bot-host.ts:100`–`:120` 的 factory 按 UI sessionId 派生不同 instanceId，再创建 Engine。虽然底层业务存储可共享，领域 Instance 仍按私聊拆开；共享 SQLite 文件不等于共享 Router 与任务协调。

`superagent/src/ds-bot-adapter.ts:151`–`:162` 在同 scope 没有绑定时 acceptSource，之后复用原 receipt；`:537`–`:544` 的 binding key 固定来自 Bot ID/UI Session。因此这条桥是“旧聊天入口到一个工作绑定”的窄集成，不是已经完成通用的多任务关系判断。

`superagent/src/ds-bot-adapter.ts:506` 也只授权可核验归属的 Bot 私聊；群入口并没有因 UI 还在就具备新协作含义。

这些是接线事实，而不是要求整体推翻现有 Domain Engine。需要分清**产品边界装配、既有机制未接线，以及复合请求等确需扩展的核心公开契约**；不能只换一个 factory 就宣布任务协作已完成，也不能再将窄桥变成 85 个 route 的总模板。

## 6. 旧计划要撤回的推论

1. “保留原 UI”不推出“所有菜单和对象含义一字不变”；原组件复用与协作语义确认要分开。
2. “所有功能接入”不推出“旧 Bot 互派/群轮次也是新核心必须照抄的机制”；能力应保留，冲突的协作方式需显式重构。
3. “统一核心”不等于“把多个 Bot 的 Engine 装到一个共享 DB”；要验证同讨论多工作、跨 Thread 连续与 Instance 隔离。
4. “同线程跟进回原任务”不能成为“同窗口任何新要求都塞回一个 Ticket”；范围外 handback、多 owner 与歧义需正确处理。
5. “统一回复”不等于屏蔽证据，也不要求每次确认都再唤醒 Router LLM；受控窄入口保留，任意直接发信禁止。
6. “按 Bot 资源隔离很有用”不推出“必须保留 Bot 为领域主对象”；新资源 scope 仍要显式设计，不能改名后全局共享。

## 7. 建议新的首要验收

先从现有聊天界面验证：主 Agent 把同一讨论里的 A/B 委托给 Router → Router 拆成两个工作并行 → Worker 只向 Router 报告 → 主 Agent 只收到两项有界摘要 → A 跟进可跨信道 → 范围外 handback → 停 A 不停 B → 重启不解除 stop → 用户可打开只读证据但不污染主上下文。

随后迁入原能力，并逐项验证它们不带回旧 dispatcher。85 个操作继续盘点，但指标变成“全部有确认处置和用户价值验收”，不是“85 个旧语义无条件复活”。

## 8. 已定架构与新增产品决定分开

用户面对连续协作者、内部采用 Router/Worker，以及可以替换长期 Bot 调度，已经是原 v2.1 的确认方向。本轮是在纠正计划偏离，不要求维护者再次批准同一架构，也不重开原 Wayfinder 地图。

维护者确认独立 Main/Router/Worker 三层；Q1—Q14 已全部收敛。Main 面对用户并委托 Router，Worker 的执行全文不默认回灌 Main；UI 只读查看不自动污染主上下文。Q13 进一步明确：DS-SuperAgent 独立演进，旧 Bot 架构移除，不保留旧协作历史入口或旧 ds-bot 兼容义务。

这与原文章/原型的**双层**命名有一个关键差别：原文把常驻 Router 层称为主 Session/orchestrator，它也承接人类交互；当前代码同样只有 Router/Worker 两种模型角色，`RoleConfig` 与 `NativeSessionRequest.role` 会拒绝第三个角色。R4 是把 Main 从 Router 中拆出的明确新架构，后续必须在正式规格中替代 D01/D17 的相关表述。

- Main 接收用户消息，生成稳定 `WorkBrief` 交给 Router；Router 负责分解、关联、Ticket/Mandate/Assignment 和 Worker 协调；Main 不直接建票、派工或调用执行工具。
- Router 只向 Main 回传 `WorkReceipt`、有界 `WorkUpdate`、`Attention`、`WorkOutcome`；完整 Worker transcript、工具输出和内部日志不进入 Main 上下文。
- `getSessionHistory` 当前是通用 Session 读取，不验证 Instance/Ticket/角色归属；gateway 的 `read`/`command` 权限按 Instance 划分。Router/Worker 的只读观察需要新的角色感知查询/授权，不能直接暴露原始 Session 或依赖前端隐藏按钮。
- Router 的来源直通仍然保留：外部环境事件可从 Source 进入 Router；只需把用户相关变化以有界事件通知 Main，不能让每条 CI/PR 事件污染主对话。

三层设置、来源分流、关键通知、明确停止/问题答复、Main 故障行为、跨信道隐私和 Q11/Q12 可选导入都有明确产品答案。下一步将字段、去重/恢复、授权查询与验收综合为正式规格，并显式替代 D01/D17/D18/D20 冲突约束；不再重问产品方向。移除旧架构不等于删除用户原数据，也不意味着放弃已要求的浏览器/MCP/Office/记忆等能力；本轮只更新方案。
