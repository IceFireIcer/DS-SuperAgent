# DS-SuperAgent 独立产品：三层运行时与 UI 方案

> 历史方案记录：本文记录 R5 规格形成前的设计收敛，不是当前实现状态。当前产品以 [R5 正式规格](../spec-r5.md)、[实施记录](../implementation/README.md)及代码为准。

- 修订：R5，2026-11-14，三轮访谈 Q1—Q14 收敛；Main / Router / Worker 三层，移除旧 Bot 架构，不做旧 ds-bot 产品兼容。
- 当时状态：产品决定已确认，R5 正式规格正在发布；本目录不构成当前代码验收证据。
- 原始范围：该轮只更新文档、MMD 与 `temp/product-unification/index.html`，未修改产品运行代码、用户数据、profile 或 GitHub Issues。

## 先纠正上一版

上一版把“保留 UI 与全部功能”扩大成了“长期 Bot、Main Bot 与群内派活也要逐项等价保留”，相当于让新核心重新承载旧 Bot 团队。这与原 Super-agent 规格并不相同。

Super-agent 技术上仍使用多个 Agent/Session，但不是把多个固定 Bot 作为用户要组织的团队：Router 做全局连续性与工作间协调，Worker 按工作隔离执行，Worker 内部才可以使用 Agent Team。已有工作相关事件按订阅直通执行者，结果按统一规则交付。角色、聊天页、工作、执行安排和 Session 不能一一等同。

因此本目录改为先区分三件事：**复用 UI 组件、保留产品能力、重建协作语义**。旧群内轮次、Main Bot 管理和 Bot 互派不再作为已批准的新核心验收要求，也不在本轮擅自删除。

本轮续核还区分了“同 Thread 可关联多个已有工作”与“一条复合请求能建立多个新工作”。后者尚缺明确接受/分项契约，已进入计划阶段 1–2；不会只复用旧桥或多次接受原事件就宣称完成。

## 三层角色与主对话

维护者明确：**主 Agent 有独立模型和独立上下文，负责对用户交互并向 Router 派活；Router 再分解工作、建立 Ticket/Assignment，派给隔离的 Worker Session；Worker 细节不回灌主 Agent。**

这不是把 Router 换个“主 Agent”标签，也不是只把 Router 的日志做成主对话。它新增一项运行时角色和一组协议：`WorkBrief`、`WorkReceipt`、`WorkUpdate`、`Attention`、`WorkOutcome`。主 Agent 只有自己的长期会话、用户可见摘要和工作索引；Router 的协调上下文与 Worker transcript 不进入主上下文。

原文章与原型把 **Router 层 / Main Session / orchestrator** 当作同一个常驻角色，属于双层架构；已核查的当前代码也只支持 Router/Worker。新方案明确增加独立 Main，后续 to-spec 需修改 D01/D17、角色配置、会话装配、产品投影和只读授权；不能把方案当成已实现。

UI 继续复用现有前端组件：主对话默认可交互；Router 过程只读；Worker 自动出现、只读且不抢焦点，完成后保留新工作历史。旧 Bot 联系人、Main Bot 管理、Bot 互派和内部群轮次从新产品移除，不创建替代 renderer。

### 三轮访谈已确认

同一授权工作空间维持一条连续主对话，不同隐私范围隔离；Main 可问答、查状态和按需读取有界证据，文件修改/Shell/浏览器操作交给 Worker；外部新的人类请求进入 Main，既有工作跟进与环境事件受控直通；仅关键变化主动通知 Main；明确目标的 UI 停止直接进受信核心。

第二轮进一步确认：Worker 自动新增侧栏条目但不抢焦点，完成后保留历史；明确问题卡答案直接提交核心；Main 故障时授权工作继续、事实可读、新自然语言输入排队；三层模型/指令复用现有设置页独立配置且不改变在途回合；结果回原信道、跨隐私范围分享需要明确授权。

第三轮确认：旧配置可审阅后提取为角色预设；记忆、浏览器与凭据按预览、原归属和明确授权选择导入；输入框“停止生成”只停止 Main 回复，停止后台工作用工作卡。Q13 按维护者修正为**移除旧 Bot 架构，不保留旧协作历史入口，不做旧产品兼容**。完整回答见 [设计访谈记录](decision-frontier.md)。

## R5 产品边界：没有旧 ds-bot 兼容包袱

- 新产品只采用 Main/Router/Worker，不保留旧团队 roster、Bot 私聊派活、群 relay/round 或旧 Main Bot 权限。
- 不提供“旧协作历史”入口、旧 profile 选择/回切、旧客户端/API 兼容 façade，也不以完整旧数据库/Session 格式迁移作为发布前置。
- Q11/Q12 的可选导入保留：只提取经审阅的配置与资源，重新绑定新产品的角色和权限，不恢复旧执行者、旧任务或旧历史 UI。
- 新产品自身的主对话、Router/Worker 执行和工作历史继续可查。去掉旧架构不等于删除用户磁盘上原软件的数据。
- 浏览器、MCP、Office、附件、记忆、日程、来源、远端与常驻等保留能力按新模型接入；85 项旧操作继续用作处置清单，不是旧协议兼容承诺。

决定依据见 [ADR 0002](../../adr/0002-independent-product-without-legacy-bot-compatibility.md)。

## 阅读顺序

1. [两种协作模型与上一版错误](collaboration-model.md)：事实、源码证据、边界及需要人决定的问题。
2. [新的实施顺序和阶段门](plan.md)：先验证任务中心协作，再迁入产品能力；全部是候选工作顺序。
3. [85 个旧操作的处置盘点](feature-matrix.md)：新能力接入、语义重构或移除旧机制，不承担旧协议兼容。
4. [三层运行时、主 Agent 上下文隔离与 UI 方案](ui-three-tier-plan.md)：角色契约、WorkBrief、Main/Router/Worker 数据流、布局、只读权限与旧入口退出。
5. [协作对比图](collaboration-comparison.mmd)、[新请求与直通跟进](event-routing.mmd)、[三层目标架构](three-tier-runtime.mmd)、[三视图导航](ui-navigation.mmd)、[实施依赖](implementation.mmd)、[切换与回退](cutover.mmd)。
6. [R5 正式规格与测试边界](../spec-r5.md)：三层角色、工作协议、用户控制、D01/D17/D18/D20 的显式替代、测试 seams 与验收场景。
7. [R5 实施票与旧计划交接](../r5-tickets.md)：36 张已创建的 GitHub 票、直接阻塞和旧计划关闭依据；[已批准拆分正文](../r5-tickets-draft.md)保留逐票验收条件与旧能力处置归属，发布回读结果以记录中的 `verified` 为准。

## 已有依据与未定事项

- 原 [v2.1 规格](../spec.md) 的工作授权、恢复、来源直通等机制继续复用；D01/D17 的人类交互职责需拆成 Main 与 Router。
- D18 的旧档案/完整切换要求、D20 的双 profile/旧团队完整 UI 要求与 Q13 决定冲突，后续 to-spec 必须明确替代。本轮保留原正式规格作为历史基线，不悄悄修改其决定。
- DS-SuperAgent 使用自己的产品配置与运行入口，复用现有前端组件；不再把旧产品兼容、旧档案读取或回切旧核心列为交付目标。
- 不把所有桌面窗口合并为一个隐私范围；Instance 是可共享上下文的边界，一个产品可以有隔离的个人/团队 Instance。

## Ask Matt 路线

前期使用 `ask-matt → grill-with-docs（grilling + domain-modeling）`：代码和规格中的事实由代理核查，产品取舍由维护者决定。**不重新询问已定的核心架构**：v2.1 已确认连续协作者、Router/Worker 和允许替换旧 Bot 调度。上轮把这个方向再次写成等待批准的根问题，是多余的决策门，现已纠正。

现有 Wayfinder 的核心决定不重新发明。若产品边界确认后仍存在可精确定义的多轮阻塞决定，再按已有 GitHub tracker 的 Wayfinder 流程建图；不是因为有 85 个 route 就必定另建地图。边界已经收敛，`to-spec → to-tickets` 已按维护者批准推进；不代替用户重新决定产品问题。

## 规格与实施票已发布

Q1—Q14 均有明确答案，不再扩展产品问卷。三层模型、三视图、直接控制、有界上下文、来源/隐私、可选导入和独立产品边界已综合为 [R5 正式规格](../spec-r5.md)，并发布到总 Issue #1。36 张纵向票为 #93—#128；截至 `adaf2ba`，R5-01—R5-11 与 R5-13（#93—#104）已合入 `dev` 并关闭，R5-12 与 R5-14—R5-36 仍开放。旧 G01—G14 及 T56 因被替代关闭；T55/#83 和 T58/#92 的整体产品与托管验收继续保留。当前 blocker 就绪集合见 [R5 实施票索引](../r5-tickets.md)，开始后续工作前应以 GitHub 实时关系为准。
