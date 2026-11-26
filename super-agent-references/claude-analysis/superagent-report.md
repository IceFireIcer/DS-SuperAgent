# DeepSeek Super-agent 研究报告：文章设计与原型实现对照

本报告依据两份一手材料：

- 文章《Super-agent 设计探索：迈向更自主的 Agent 系统》（`super-agent reference/super-agent.md`，DeepSeek Harness 团队），含 15 张配图。下文引用文章时标注小节标题，例如「§2.1 Router 层」。
- 原型仓库 `dsh-superagent-prototype/`（deepseek-ai/dsh-superagent-prototype），TypeScript 实现。引用格式为相对仓库根目录的 `路径:行号`，文中路径均省略前缀 `dsh-superagent-prototype/`。

两者的关系先说清：原型 README 明确声明它是"研究原型，仅供参考，不是 DeepSeek 官方产品"，并且"与内部版本及文章所述实现不完全相同，文章中讨论的部分设计是未来方向，本原型未实现"（`README.md:3-5`）。因此本报告把"文章说了什么"和"原型做了什么"分开写，再逐项对照。

## 1. 问题与四个基础特征（文章 §1）

### 1.1 要解决的问题

文章的出发点是：以 Coding Agent 为代表的单任务 Agent 已证明模型能用工具解决复杂问题，但主流 Agent 仍以"单一 Session"为基本单位，Session 之间彼此独立。用户并行推进多项工作时，必须手动切换并记住各 Session 的上下文。作者观察到一个人通常只能同时跟进 **3 到 5 个活跃 Session**，于是"单任务的上限取决于模型能力，多任务的上限取决于人的注意力"（§1 Super-agent）。

仅在本地单会话 Agent 上用 CLI、MCP 或外部连接器做扩展，仍会受制于三类问题：单会话同步阻塞、多任务上下文混乱、本地设备离线即停止（§1）。文章的结论是打破 Agent 与单次手动会话的绑定，把 Agent 变成一个"跨会话保持上下文、同时推进多项复杂任务且互不干扰的连续实体"，并把这种形态及其系统架构称为 **Super-agent**。

### 1.2 两个具体示例

- **IM 与 GitHub 之间的连续性**（图 01）：用户 B 在 IM 群里提出"正文、代码和终端字体分别配置"，维护者 @Super-agent 后，它在 IM 回报 PR 已就绪；用户 B 追问字号能否也分别配置，它在 IM 回复"已加进同一个 Pull Request"；随后维护者在 GitHub 评论"设置项太多，能否折叠"，设计师又在 GitHub 提出"不必单开分区"，它都在 GitHub 上回应并修改；最后在 IM 通知"Pull Request 已合并"。同一个任务跨两个信道推进，用户无需关心背后是哪个 Session。
- **无人 @ 的主动修复 PR**（图 02）：在日常消息很多的产品用户群里，用户 A 反馈"macOS 桌面端窗口未聚焦时点击会话会被识别为双击并进入重命名"。没有人 @ 或指派 Super-agent，它在后台静默复现并排查代码，随后提交修复 PR，附前后对比截图，并给出根因：Electron 默认吞掉激活窗口的那次点击，下一次点击带 `detail=2`，因而被识别为双击。
- **投机执行示例**（图 09，§3.4）：群内还在讨论"波浪号被渲染成删除线"应在训练中解决还是改渲染规则时，Super-agent 已提交 PR，只把 `~~文字~~` 渲染为删除线；用户 B 质疑依据时，它回答 Pandoc 和 markdown-it 只支持 `~~`，GFM 额外接受单个 `~`。

### 1.3 四个基础特征

| 特征 | 文章定义（§1） | 文章中的例子 |
| --- | --- | --- |
| 连续 | 用户在 IM、GitHub 评论等熟悉界面交互，感觉始终只有一个 Agent，不需要去想"Session X 的上下文里有没有 Y" | 先在 IM 提方案 A，再在 PR 评论里改为方案 B，它能理解并调整方向 |
| 高效 | 响应迅速，并行、高质量地完成多个复杂任务；不等上一个命令完成就能接受下一条指令 | — |
| 主动 | 不等逐条指令，持续观察环境事件并主动推进值得处理的事项，不需要介入时保持安静 | 图 02、图 09 |
| 持久 | 始终在线，直接接入用户真实工作环境，长期运行中遇异常自动恢复 | — |

文章认为单个 ReAct Loop 无法同时满足这四点，需要五个模块组成的基本框架：双层架构（§2，连续与高效）、事件驱动（§3，主动）、面向人的交互（§4，连续与高效）、计算/状态/环境分离（§5）与 Watchdog（§6，持久与自愈）。文章还提出一个判断：无论面向个人助手还是软件开发，只要目标是"持续在线、并发响应环境事件"的系统，底层就可能采用相近架构，而且其中许多问题与传统计算机系统长期讨论的问题高度相似（§1）。

## 2. 文章提出的架构

### 2.1 总体结构（图 03）

图 03 是全文的总架构图，标号 [2]–[6] 对应 §2–§6。图中的组件与连线如下：

- **[3] 环境事件 (Trigger)**：群消息 / PR / CI，进入 **[3] 两级过滤**（Fast / Slow Path）。
- 过滤后的事件有两条去向：经 **[2] Router 层**（标注"共享上下文，全局路由与交互"），或沿蓝色虚线"**订阅直通**"直接进入 **[2] Worker Session 1**。
- Router 层向下派生 **Worker Session 1…N**（各自"隔离上下文"），向右连接 **[4] 多信道交互**（IM / GitHub / 邮件）。
- Worker Session N 连接 **[5] 执行环境**（"轻量 daemon 原地接入"，虚线框）。
- Router 与所有 Worker 都连到底部的 **[5] Session 数据库**（"持久化存储所有 Session 状态"）。
- **[6] Watchdog**（"外部监控与自愈"）以虚线连向 Session 数据库，位于主系统之外。

这张图给出了一个正文没有直接写出的信息：只有 Router 层直接连接多信道交互，Worker 与外部信道之间没有连线。正文对应的说法是"Worker 不会直接与人类交互……而是向 Router 层汇报状态、由 Router 层统一向用户回复"（§2.2 Worker 层）。

### 2.2 双层架构（§2）

**核心权衡**：连续性与吞吐量之间的根本 Trade-off（§2 双层架构）。所有事件交给一个 Session，上下文最连续，但受单个 ReAct Loop 串行速度限制，且多任务细节混杂；每个事件新开一个 Session，吞吐最高，但缺少全局上下文，结果割裂，且多个 Session 各自回复用户会造成混乱。解法是把"维护全局连续性"和"高并发执行"拆到两层（图 04：左侧 IM、GitHub、邮件/日程连接 Router 层，右侧 Router 层连接三个隔离上下文的 Worker Session）。

**Router 层**（§2.1）：
- 常驻的全局路由层，承接所有入口的人类交互；充当全局的**序点（Sequence Point）**、协调点和记忆。
- 为避免成为瓶颈，它不直接执行任务，只做交互与分派，"甚至可以不配备 Bash 工具"。
- 与 Agent Team 的区别：Team Lead 要深入单个复杂任务的拆解与高频协调；Router 只处理任务之间的高层关联与分派。反过来，若用提示词约束 Agent Team 的主会话不亲自执行、只对外交互和分派，它也可视为双层架构。
- Router 任务往往不复杂，"使用较轻量的模型往往就能兼顾速度与效果"。
- 实现上不必局限于单个 Session，部分逻辑甚至不必调用 LLM；团队选择了单个常驻 LLM Session。
- **批处理（Batching）**：上一轮推理期间到达的 Trigger 积压下来，在下一轮一并注入。Router 每步是"长输入、短输出"，合并后在 Prefill 阶段并行计算，单次请求耗时增长远慢于 batch 大小，所以积压越多，单个决定分摊的推理时间越低；上限取决于上下文长度与模型一轮能准确处理多少 Trigger。

**Worker 层**（§2.2）：
- 各 Worker 上下文隔离，挂载完整执行工具，专注单一任务；因直接决定结果与代码质量，通常配置能力最强的模型。
- 同层 Worker 之间通常不直接通信。冲突多发生在同一 PR 等共享工作环境中，只要它们都订阅了对应 Thread，就会收到相同事件，有机会自行发现和解决冲突；少数跨任务协同由 Router 中转。
- Worker 内部可以再建 Subagent，或本身就是 Agent Team，对 Router 透明。
- 同一结构适用于个人助手：前端只有一个聊天页维持交互连续，底层为每个话题分派 Worker。

文章还强调"双层"是逻辑职责划分，Session 应是系统的实现细节而非用户的认知负担；让用户手动管理 Session 是"从底层 LLM API 延续下来的设计惯性"（§2）。

### 2.3 事件驱动（§3）

**Trigger**：群聊消息、邮件与日程提醒、代码审查评论、CI 结果等半结构化环境事件（§3 事件驱动）。

**两级过滤**（§3.1，图 05）：事件流"高噪音、低触发率"，每个事件都调用大模型在延迟和成本上不可承受。借鉴 **Fast Path / Slow Path**：
- 程序层策略（Fast Path）：按事件来源、群组范围、用户或机器人白名单等确定性条件用代码准入，例如对不同来源设置"仅响应明确请求""作为候选事件"或"直接忽略"。
- 语义层策略（Slow Path）：通过准入的候选事件交给 LLM，按提示词写的策略判断是否行动；它同时是面向人的自然语言扩展点。
- 图 05 的例子：Trigger 1（闲聊群"中午去食堂还是点外卖？"，非监听群）被程序层拦截，不调用 LLM；Trigger 2（用户群"新版本界面看着挺清爽"）和 Trigger 3（用户群"切换会话时偶发白屏"）被放行；语义层静默 Trigger 2、触发 Trigger 3，Trigger 3 进入"开始路由"。

**Thread 与订阅直通**（§3.2，图 06、图 07）：
- 同一 PR、同一 IM 话题、同一封邮件串下的连续事件构成 **Thread**。图 06 给出两个例子：Thread #08（IM 群话题，Trigger #39 张三"切换会话时页面偶发白屏"→ #40 李四"复现了，控制台报空指针异常"→ #42 张三"@Agent 帮忙定位修复一下"）与 Thread #15（GitHub PR #128，Trigger #51 PR 提交 → #54 CI 状态变更"unit-test 运行失败"→ #58 代码审查评论"这里需要补充空值判断测试"）。
- Router 根据某 Thread 的初始事件创建 Worker 后，该 Worker 直接订阅该 Thread。**已订阅（Fast Path）**：后续事件由程序直通 Worker，不经 Router；若超出当前任务范围，Worker 可取消订阅或交回 Router 重新分派。**未订阅（Slow Path）**：Router 仍可观察，但只判断和分派尚未被订阅的新事件。图 07 画出这两条路径：初始事件（Slow Path）→ Router 层"创建 Worker 并建立订阅"→ Worker；同一 Thread 后续事件经粗蓝线"后续事件直通（Fast Path）"直达"已订阅该 Thread"的 Worker。
- Thread 与 Worker 的订阅是**多对多**：一个 Worker 可订阅多个相关 Thread，一个 Thread 也可被多个 Worker 订阅，新事件同时直通所有订阅者。

**上下文组织：Inline & Spill 与链式召回**（§3.3，图 08）：
- 把有限的上下文窗口当作 **Cache** 管理。**Inline**：把近期很可能用到的信息直接内联进窗口，省去工具往返。**Spill**：把超出预算或低频的完整信息留在窗口外，只保留引用或摘要。"浪费上下文窗口，就是浪费模型的智能。"
- 结合 **局部性（Locality）**的三步：从最少信息开始（ID 和摘要）；按局部性逐步 Inline 关联信息（紧密关联对象的 ID、内容前 50 字、IM 前后相邻消息与被回复消息、评审讨论中的相邻评论）；超出上限则 Spill（截断并保留续读入口）。
- **链式召回（Chain of Recall）**：给 Trigger、Thread、Worker Session 等对象赋唯一 ID，注入时内联紧密关联对象的 ID，使对象构成引用图；每次召回的结果同样遵循 Inline & Spill，又内联下一跳的摘要与 ID，模型可逐跳展开。图 08 画出完整一跳链：Trigger #42（Inline 注入"前 50 字与相邻消息"，含 `thread_id: #08`、`worker_id: #03`）→ `read_trigger(#42)` 续读 Spill 部分；→ `read_thread(#08)` 得到"近期事件摘要"与 `trigger_ids: [#39, #40]`、`worker_ids: [#02, #03]`；→ `read_trigger(#40)`；→ `read_worker(#03)` 得到任务进度摘要与 `thread_id: #15`；→ `read_thread(#15)` 到达关联 PR。它缓解了 Router 在长程中丢失先前信息的问题。

**提前行动：投机执行**（§3.4，图 09）：借鉴 **投机执行（Speculative Execution）**，在不确定结果是否被采用时根据环境信号在后台提前尝试，用额外后台算力换取更少的人类等待与介入；有价值就交付，没有就丢弃。例子是个人助手提前核对日程冲突并备好回复草稿，以及团队在 DeepSeek Harness 内部用户群配置的"静默复现并修复"策略：只有确认问题并找到简单修复后才交付，否则全程保持安静。

### 2.4 面向人的交互（§4）

**全双工：异步 ReAct Loop**（§4.1 全双工交互，图 10）：经典 ReAct Loop 中，模型调用同步 `run()` 后循环阻塞，直到工具返回，期间无法响应新输入（半双工）。解法是把耗时命令与子任务工具改成异步的 `start()` 与 `stop()`。图 10 上下对比：上半为"用户消息 1 → LLM Call 调用 run() → 同步阻塞等待工具返回 → 工具调用结果 → LLM Call 回复用户"；下半为"用户消息 1 → LLM Call 调用 start() → 立即返回 Started 通知 → 用户消息 2 → LLM Call 即时回复 → 新消息投递完成结果 → LLM Call 交付任务结果"，后台工具在下方异步执行。完成结果作为一条新的事件消息投递进会话；模型也可调用 `stop()` 终止过长的后台命令。文章明确说明：**这一机制已在 DeepSeek Harness 中实现，但尚未默认开启**。

**多信道交互**（§4.2）：双层架构把冗长推理和密集工具调用隔离在 Worker 内部，由 Router 统一对外。此外按信道用提示词定制规范：
- IM 等即时通讯：低打扰，只在需要决策或验收时通知，只问直接问题、给简短结论；验证过的硬性规定是**单次回复不超过 100 词**。
- GitHub、邮件、文档等异步信道：结构化、高信息密度，例如 PR 按项目规范写问题背景、改动说明与验证结果。

### 2.5 计算、状态与环境的分离（§5）

- **计算与状态分离**（§5.1）：推进 Agent Loop 的计算可以无状态，需要持久化的是会话状态。计算放入云端无状态弹性容器，Session 等状态存入数据库；容器可水平扩展、重启、替换，连续性由持久化存储保障。
- **计算与执行环境分离**（§5.2，图 11）：广义上下文包含执行环境本身。在云端重建沙箱同步环境成本高且易遗漏（未提交的修改、私有凭据、内网依赖、特定硬件或工具链），要求用户迁往云端成本又过高。方案是 Agent Loop 在云端运行，重状态的执行环境留在原地，端侧只部署一个**不保存会话状态的轻量 daemon**，只执行命令、返回结果。文章将其与 Anthropic 的"脑手分离"（Decoupling the brain from the hands）对照：思路一致，区别在于后者面向托管沙箱与客户 VPC，这里首先接入用户日常使用、可能间歇在线的个人机器，因此提出 **BYOM（Bring Your Own Machine）**，同时也支持云端托管或按需创建的环境。Agent 可在设备间切换，设备重新上线后可由云端自动触发待执行的任务。
- 图 11：上层为"Agent Loop（云端无状态弹性容器）"与"Session 数据库（持久化状态存储）"双向连接；虚线以下三个执行环境"个人开发机""云端托管 / 按需环境""间歇在线的个人设备"，各自运行"端侧 daemon"。

### 2.6 Watchdog（§6）

持久在线的分布式系统难以仅靠内部逻辑保证长期可靠，需要主系统之外的独立外部控制回路，即 **Control Loop**。Agent 系统里，进程存活探测不够，因为很多异常是模型陷入无效循环或偏离目标，所以既要监控基础设施，也要监控任务进展。团队在主系统外配置独立的 **Watchdog Session**，由定时消息驱动：处理接口报错、状态恢复失败等基础设施故障，并由模型判断各 Worker 是否有实质进展、方向是否偏离；偶发外部故障则持续复查直至恢复。Watchdog 本身是具备完整工具能力的 Agent Session，维护者可以用自然语言问它故障原因，或让它在线修正主系统行为（增删提示词、调整触发规则）（§6 Watchdog）。

### 2.7 初步实验（§7）

文章强调实验基于合成负载与简化环境，结果仅作初步参考（§7 初步实验）。

**消融实验**（§7.1，图 12、图 13）：约 300 条消息/次，其中约 20 条是工作请求，其余为闲聊、跟进、叫停和 CI；编码工作用只消耗时间的工具代替，因此衡量的是调度与协作能力；每方案 5 次。对比四种方案：Super-agent、去掉直通的 Super-agent、单 Session + Subagent 工具（中性提示 *"Use a subagent for a piece of work when appropriate..."*）、单 Session + Subagent 工具（提示优先委派）。

| 结果 | 数值 |
| --- | --- |
| Super-agent 任务完成时间 | p50 12.4 分钟，p95 15.7 分钟 |
| 单 Session + 中性提示 | 5 次运行一次都没有调用 Subagent，所有工作在主 Session 中进行并被新消息打断，p95 29.5 分钟 |
| 单 Session + 提示优先委派 | 5 次中 4 次委派，仍慢于 Super-agent；1 次判断工作"很小"而自己执行，形成紫色长尾 |
| 去掉直通 | 完成时间与完整版基本一致，但 Router 决定数增加约 30%，总读缓存 token 从 2323 万增至 3177 万（约 +37%） |

图 12 是工作请求累计到达曲线与四种方案累计完成曲线（5 次均值；消息间隔和工作时长按 1/4 缩放，模型调用耗时为真实值）。图 13 是四种方案任务完成时间分布的对比（注：从工作请求到结果消息的耗时）。文章的结论是：Super-agent 以更多 token 换取更短更稳定的完成时间；直通不提升完成质量与速度，但为 Router 节省了可观的 token 和推理开销。双层架构在系统层面解决了"单 Session 依赖提示词和模型临场判断是否分工"的问题。

**Router 批处理压测**（§7.2，图 14）：Router 用真实模型、Worker 用 Mock 模型，Trigger 到达速率从约 1 条/分钟升到约 40 条/分钟：平均 batch 从 **1.0 升至 2.8**，单次请求耗时仅从 **2.5 秒增至 3.9 秒**，单个决定分摊推理时间从 **6.4 秒降至 1.6 秒**。因此当前团队规模下无需过早水平切分 Router。

图 15 是招聘海报，与架构无关。

### 2.8 开放问题（§8）

- §8.1 扩展：当前是"单常驻 Router Session + 订阅直通 + Worker 间不直接通信"的简化组合；Router 何时水平切分、Worker 何时需要直接通信、采用何种拓扑尚无定论；Router 的事件判别、批量分派、上下文召回可做系统与模型的 Co-design 专项训练；跨月运行时长程记忆成为主要瓶颈。
- §8.2 脱离 Session 后如何协作：以聊天窗口为中心是路径依赖，交互可更多发生在领域特化界面，如直接在 GitHub Issue 与 PR 中工作；界面上的一个会话在底层未必对应一个 Session。
- §8.3 上下文边界与 A2A：组织配备 Super-agent 实际是在划分上下文共享与隔离的边界，需要共享的共用一个实例。
- §8.4 安全与隐私：事件驱动增加了接触不可信输入的风险；§5 的设计默认云端与端侧彼此受信任，一旦云端 Agent Loop 被入侵或遭提示词注入，所有连接的端侧设备都有被控制的风险；即使未被攻破，凭据进入模型上下文也有泄露风险，需要让 Agent 在不接触凭据本身的情况下使用凭据。

### 2.9 文章援引的经典计算机系统思想

文章自述"没有提出全新的理论，而是将计算机系统中经典的工程思想应用到了 Agent 系统的构建中"（§9 结语）。正文明确使用的概念如下：

| 概念 | 用在哪里 | 出处 |
| --- | --- | --- |
| 序点（Sequence Point） | Router 作为全局序点、协调点和记忆 | §2.1 |
| 批处理（Batching）/ Prefill 并行 | 积压 Trigger 合并为一次 LLM 调用 | §2.1、§7.2 |
| Fast Path / Slow Path | 两级过滤；订阅直通与 Router 冷启动 | §3.1、§3.2 |
| 订阅（发布-订阅式的多对多路由） | Thread 与 Worker 的订阅关系 | §3.2 |
| Cache | 把上下文窗口当作 Cache 管理 | §3.3 |
| Inline & Spill（借自编译优化） | 事件注入与工具返回的组织 | §3.3 |
| 局部性（Locality） | 优先 Inline 时空相邻的内容 | §3.3 |
| 引用图上的多跳检索 | 链式召回 | §3.3 |
| 投机执行（Speculative Execution） | 后台静默复现与修复 | §3.4 |
| 半双工 / 全双工、异步调用 | 异步 ReAct Loop | §4.1 |
| 无状态计算 + 持久化状态（存算分离） | 云端弹性容器 + Session 数据库 | §5.1 |
| 外部控制回路（Control Loop）/ Watchdog | 独立 Watchdog Session | §6 |

## 3. 原型概况

`dsh-superagent` 是 DeepSeek Harness（DSH）的一个插件 bundle，运行在单独的 DSH profile 里，自带一个 Web 面板（`docs/006-deployment.md:5-11`）。`src/` 约 15,600 行 TypeScript、约 100 个文件，分为：

| 目录 | 内容 | 依据 |
| --- | --- | --- |
| `src/core/` | 领域引擎：`engine.ts`（唯一入口）、`intake.ts`、`evals.ts`、`tickets.ts`、`assignments.ts`、`replies.ts`、`model.ts` 等 | `docs/007-architecture.md:44-50` |
| `src/app/` | 组合根 `runtime.ts`、SQLite `store.ts`、持久化副作用队列 `effects.ts`、`sessions.ts`、`assessment.ts`（MasterAssessor）、`resources.ts`、`tools/` | `docs/007-architecture.md:29-42` |
| `src/executor/` | `dsh.ts`（DshExecutor、WorkerSlots）、`background.ts` | `docs/007-architecture.md:197-207` |
| `src/sources/` | GitHub 与飞书 Source 实现及注册表 | `docs/001-domain.md:66-71` |
| `src/client/` | 面板前端（React/TSX） | `docs/005-panel.md` |
| `src/infra/` | 命令执行、环境变量、健康状态、文本分页 | — |
| `src/admission.ts`、`limits.ts`、`deployment.ts`、`kv.ts` | 准入表默认值、数值上下限、机器配置、KV 键表 | 见下文各节 |

术语对应：文章的 Router 在原型里叫 **main Session**（代码与提示词中为 `orchestrator`），文章的 Worker 叫 **Executor Session**（代码中为 `worker`）（`docs/001-domain.md:80-81`）。

## 4. 文章概念到原型的映射

下表是本报告的核心对照。"实现程度"一栏分三档：已实现、部分实现/换了做法、未实现。

| 文章概念 | 原型对应 | 实现程度 | 依据 |
| --- | --- | --- | --- |
| Router 层（单个常驻 Session） | main Session，preset `dsh-superagent-router` | 已实现 | `docs/003-execution.md:29`；`src/app/sessions.ts`（`ROUTER_PRESET`） |
| Router 不执行具体任务、可不配 Bash | main Session 仍有 `bash`、`read` 等 DSH 工具；"不读代码"只是提示词规则，不是工具限制 | 换了做法（靠提示词约束） | `docs/007-architecture.md:507`；`docs/004-prompts.md:77` |
| Router 用轻量模型 | Eval 与 Execution 设置可分别指定模型，否则用 profile 默认模型 | 可配置 | `docs/006-deployment.md:26`；`src/app/role-models.ts` |
| Worker 层、上下文隔离 | 每个 Ticket 一个 Executor Session `worker-<ticket id>` 和一个目录 | 已实现 | `docs/003-execution.md:25` |
| Worker 内部可建 Subagent | Worker subagent 使用 DSH `standard` preset | 已实现 | `docs/003-execution.md:29,47`；`cordis.patch.yml:17-18` |
| Worker 并发 | `WorkerSlots`，`maxWorkers` 1–16，人的消息可多占一个槽 | 已实现 | `src/executor/dsh.ts:169-194`；`src/limits.ts:6` |
| Worker 不直接与人交互 | **不一致**，见 §4.1 | 与文章不同 | `src/core/replies.ts:10-15`；`docs/004-prompts.md:83` |
| 批处理（Batching） | 每个 Thread 的 Eval 串行，期间到达的 Trigger 合并到下一批；`orchestrator_route` 一次接受 1–20 个决定 | 部分实现，粒度不同 | `docs/001-domain.md:43`；`src/core/evals.ts:22`；`docs/007-architecture.md:503` |
| Trigger | `Trigger`：不可变事件，带 Source 元数据 | 已实现 | `src/core/model.ts:23`；`docs/001-domain.md:28` |
| 两级过滤 Fast Path | Source `scope` 过滤 + 确定性 gate（白名单、准入表、bot 列表） | 已实现 | `src/core/intake.ts:1-12`；`docs/002-authorization.md:9-16,56-75` |
| 两级过滤 Slow Path | main Session 的 assessment（`orchestrator_eval*`），规则写在 `prompts/admission.md` | 已实现 | `docs/004-prompts.md:57`；`docs/007-architecture.md:209-215` |
| Thread | `Thread` 聚合：按时间排列的 Trigger，同时最多一个 Eval | 已实现 | `src/core/model.ts:157`；`docs/001-domain.md:29` |
| 订阅直通（Fast Path） | Subscription fan-out：订阅 Thread 的新 Trigger 直接送达 Ticket，不经 Eval | 已实现 | `docs/001-domain.md:37`；`docs/002-authorization.md:20` |
| 多对多订阅 | Subscription 是 Ticket 与 Thread 的多对多关系，由 Thread 持有 | 已实现（订阅方是 Ticket 而非 Session） | `docs/001-domain.md:37,41` |
| Worker 取消订阅或交回 Router | `orchestrator_thread_unrelated`、`orchestrator_trigger_handback` | 已实现 | `docs/007-architecture.md:519-528` |
| Worker 订阅相关 Thread | `orchestrator_thread_follow`（仅作上下文，不授予权限） | 已实现 | `docs/002-authorization.md:40-42` |
| Inline & Spill | Trigger 卡片内联；只有被截断时才附读取指针；`STUB_CHARS = 50` | 已实现 | `docs/004-prompts.md:61`；`src/app/assessment.ts:37,198` |
| 链式召回 | `orchestrator_read` 的资源 `trigger/<id>`、`thread/<key>`、`ticket/<id>` 互相内联关联 id | 已实现 | `docs/007-architecture.md:550-558` |
| 投机执行 | Policy 规则 + accept mode（默认 `observe` 只记录不执行） | 部分实现，默认关闭 | `docs/002-authorization.md:91-105` |
| 异步 ReAct Loop | 前台命令 5 秒后转后台 job，job 完成后唤醒 Executor；main Session 有 `noWait` 守卫 | 换了做法 | `cordis.patch.yml:49-50`；`docs/003-execution.md:27,33`；`src/app/sessions.ts:72-84` |
| 多信道（IM / GitHub / 邮件 / 日程） | 只有飞书和 GitHub | 部分实现 | `docs/001-domain.md:66-71` |
| IM 消息 ≤100 词 | 聊天消息默认一句话，硬上限 100 词 | 已实现（提示词） | `docs/004-prompts.md:79` |
| 计算与状态分离（云端无状态容器） | 单机单进程，本地一个 SQLite 文件，状态目录加锁 | 未实现 | `docs/007-architecture.md:450-452`；`src/app/runtime.ts:93` |
| 执行环境分离、端侧 daemon、BYOM | Executor 在同一台机器上以操作者 OS 用户运行 | 未实现 | `docs/006-deployment.md:13-19` |
| Watchdog Session（模型判断进展） | 另一个 profile 里的每小时 `status` 检查，只看退出码 | 部分实现，只覆盖基础设施 | `docs/006-deployment.md:133-141` |

### 4.1 与文章不同的做法

**Worker 会直接对外发言。** 文章说 Worker 不直接与人交互，由 Router 统一回复（§2.2 Worker 层），图 03 中也只有 Router 连向多信道交互。原型的做法不同：

- `Replies` 的消息类型里，`acknowledgement` 明确是"an Executor's acknowledgement of a person's request it works on"（`src/core/replies.ts:10-15`），Executor 有专门的 `orchestrator_ack` 工具（`docs/007-architecture.md:524`）。
- 004 要求 Executor 在开始实质工作前，"as a reply under the original message"确认一次（`docs/004-prompts.md:83`）。
- Executor 通过 agent 账号的 `gh` 和机器人的 `lark-cli` 直接开 PR、回复评审（`docs/003-execution.md:78`；`prompts/worker.md:6-8`）。

不过，Executor 向人提问时仍走结构化通道：它把一个具体问题放进 `orchestrator_report human_action`，main Session 原样转发（`docs/004-prompts.md:84`；`prompts/handoff-worker.md:1`）。所以原型保留了"Router 是对话的协调点"，但没有把 Worker 与外部信道完全隔开。

**订阅的主体是 Ticket，不是 Session。** 文章说 Worker Session 订阅 Thread（§3.2）。原型把订阅挂在 Ticket 上，Executor Session 只是 Ticket 通过 Assignment 绑定的执行端，并且被明确排除在领域之外（`docs/001-domain.md:41`）。拒绝的概念表也写明"Ticket 的状态不跟随 DSH Session"，因为一个 Ticket 可以被交接、恢复或由多个 Executor 执行（`docs/001-domain.md:56`）。这让重启、重试后的订阅关系不依赖某个 Session 是否存活。

**Router 的工具没有被裁掉。** 文章说 Router "甚至可以不配备 Bash 工具"（§2.1）。原型的 main Session 除 14 个应用工具外还有 DSH 的 `skill`、`bash`、`read`、`read_image`、`job_output`、`job_list`、`job_kill`，007 原文："Avoiding code reads is a prompt rule, not a tool restriction"（`docs/007-architecture.md:507`）。约束靠 `prompts/orchestrator.md:4`（"Workers investigate and implement; never add implementation plans"）和 `noWait` 守卫实现。

**异步 ReAct Loop 换成了"超时转后台"。** 文章的方案是 `start()`/`stop()` 两个异步工具（§4.1）。原型没有这两个工具，而是利用 DSH 的 shell 配置：两个 preset 的前台命令 `timeoutMs`/`maxTimeoutMs` 都是 5000，超过 5 秒即转为后台 job（`cordis.patch.yml:49-56,149-155`；`docs/003-execution.md:27-29`），job 或 subagent 完成后结果会唤醒 Executor（`docs/003-execution.md:33`），终止靠 DSH 的 `job_kill`。main Session 一侧再加 `noWait` 守卫，拒绝 `sleep`、超过 30 秒的 shell 超时和超过 5 秒的 job 等待（`src/app/sessions.ts:72-84`）。效果接近全双工，机制不同。

**批处理的粒度是 Thread。** 文章描述的是 Router Session 跨所有 Trigger 的积压合并（§2.1）。原型的串行与合并单位是 Thread："its running Eval, which runs serially and merges Triggers that arrive meanwhile into the next batch"（`docs/001-domain.md:43`）。跨 Thread 层面，main Session 可在一次 `orchestrator_route` 调用中处理 1–20 个决定（`docs/007-architecture.md:503`），assessment effect 最多同时 4 个（`docs/007-architecture.md:174`）。原型没有复现文章 §7.2 那种对 Router 整体的批处理测量。

### 4.2 文章描述但原型没有实现的部分

- **存算分离与云端部署**（§5.1）：原型是单进程、单 SQLite 文件 `<stateDir>/orchestrator.sqlite`，只有 Store 能打开（`docs/007-architecture.md:452`），启动时用 `proper-lockfile` 锁住状态目录（`src/app/runtime.ts:93`，stale 30_000 ms）。没有无状态计算容器，也不能水平扩展。
- **端侧 daemon 与 BYOM**（§5.2）：Executor 与 main Session 在同一台机器、同一个 OS 用户下运行，preset 为 `danger-full-access`（`src/app/sessions.ts:152`；`docs/006-deployment.md:19`）。没有远程执行设备，也没有"设备上线后触发任务"。
- **模型驱动的 Watchdog Session**（§6）：原型的"每小时检查"放在另一个日常 profile 里，按 `scripts/dsh-superagent status` 的退出码 0/1/2/3 决定是否重启或通知（`docs/006-deployment.md:115-141`）。它不判断 Worker 是否有实质进展、方向是否偏离，也不在线修改提示词或触发规则。
- **邮件、日程、个人助手场景**（§1、§3.4、§4.2）：只有 GitHub 和飞书两个 Source，而且只服务一个 GitHub 仓库（`README.md:7`；`docs/006-deployment.md:24`）。008 给出了新增 Source 的完整示例（`docs/008-cookbook.md:5-17`）。
- **长程记忆**（§8.1）：原型没有归档或压缩机制，007 写明"Nothing deletes old records yet, so these grow without bound"（`docs/007-architecture.md:484`）；读缓存 `TextCache` 只在内存中，重启即失（`docs/007-architecture.md:482`）。
- **凭据不进上下文**（§8.4）：原型做到了执行变量"None contains credentials"（`docs/003-execution.md:65`），但也明说账号包装脚本和目录"establish defaults, not a security boundary. A worker can still execute a program by absolute path"（`docs/003-execution.md:80`）。007 的开放问题里，"哪些 Trigger 字段可信"仍未决（`docs/007-architecture.md:616`）。
- **实验**：原型仓库没有文章 §7 的消融或压测脚本。`tests/followups.spec.ts:268` 有一处注释提到 "The benchmark's case"，但那是单元测试里的一个场景，不是基准实验。

### 4.3 文档与代码的一致性

我抽查了文档中带具体数字或名称的说法，没有发现实质矛盾：

| 文档说法 | 代码 |
| --- | --- |
| main Session 14 个、Executor 6 个应用工具（`docs/007-architecture.md:492,519`） | 代码中 18 个不重复的 `orchestrator_*` 名称，`orchestrator_read` 两者共用（`src/app/tools/`） |
| 后台工作每轮最多 30 分钟（`docs/003-execution.md:35`） | `BACKGROUND_LIMIT_MS = 30 * 60_000`（`src/executor/dsh.ts:32`） |
| 人的消息可多用一个槽（`docs/003-execution.md:59`） | `this.max() + (by === 'person' ? 1 : 0)`（`src/executor/dsh.ts:194`） |
| 准入表默认值 inferred / ignore / ignore（`docs/002-authorization.md:65-69`） | `ADMISSION_DEFAULTS`（`src/admission.ts:13`） |
| 文本页 4,000 单位（`docs/007-architecture.md` Read resources 一节） | `limit ?? 4000`（`src/app/resources.ts:87`） |
| 只能从 schema 10 升级（`docs/007-architecture.md:486`） | `SCHEMA_VERSION = 11`、`OLDEST_SCHEMA = 10`（`src/app/migration.ts:20-22`） |

有一处细节上代码比 004 更严。004 写的是守卫拒绝 "job waits over 5 seconds"（`docs/004-prompts.md:78`）。代码里的 `routed()` 判断 main Session 当前是否用 `dsh-superagent-router` preset（`src/app/sessions.ts:274-280`）。如果不是（例如旧的 main Session 仍在 `standard` 上），守卫还会拒绝两类调用：没给 `timeoutMs` 又不在后台运行的 bash 命令（`src/app/sessions.ts:82`），以及 `wait: true` 但没给 `timeout_ms` 的 `job_output`（`src/app/sessions.ts:84`）。004 没有写这两条，但 007 有说明：`standard` 的默认值会把一步卡住 60 秒（shell）和 30 秒（job 等待），所以必须显式给超时（`docs/007-architecture.md:515`）。两份文档合起来与代码一致。

## 5. 原型自身的设计

### 5.1 哲学（docs/000）

核心原则一句话：**"Take as little human attention as possible, and give as much value as possible."** 项目的每一部分都按它消耗的注意力来衡量，消息、通知、问题、设置、面板元素、一段文档都算，不能给出超过成本的价值就删掉（`docs/000-philosophy.md:3-7`）。

对 Agent 的约束：
- 只在被请求或书面规则允许时行动；请求必须直接 @ Agent，且来自允许的人（`docs/000-philosophy.md:11`）。
- 只在人必须行动或能用到结果时说话；确认一次并说明要做什么；工作时保持安静（`docs/000-philosophy.md:12`）。
- 一次只问一个具体问题，且用结构化形式，避免问题埋在长报告里（`docs/000-philosophy.md:13`）。
- 按影响而不是按工作量决定何时停下：本地改动能到可评审就停，需要设计决策的改动停在一个明确问题上（`docs/000-philosophy.md:14`）。
- 如实报告：草稿标未完成，失败报失败，不绕过限制来避免提问（`docs/000-philosophy.md:15`）。

对设计的约束：概念要少，业务需求变成某个概念的属性或一段提示词，不新增概念（`docs/000-philosophy.md:19`）；设置要少，几乎所有团队都适用的值就用默认值（`docs/000-philosophy.md:20`）；面板只展示需要人处理的内容（`docs/000-philosophy.md:21`）；编号文档按顺序读，后一份只建立在前一份之上（`docs/000-philosophy.md:22`）。

责任一节把边界说清楚：Agent 用团队每天看到的账号评论、开 PR、发消息，每条消息都消耗同事的注意力，操作者对此负责（`docs/000-philosophy.md:26`）。具体要求：从短白名单开始，主动工作先只记录、确认没问题再放开；Agent 吵的时候缩短提示词或暂停，而不是发更多消息去解释；不用它制造数量；自己读它以你的名义发的内容，错了就在提示词里改（`docs/000-philosophy.md:28-31`）。最后一句："The goal is the right help at the right time, and nothing at any other time."（`docs/000-philosophy.md:33`）

README 对原型定位的原话是"Research prototype for reference only, not an official DeepSeek product"，代码"grew out of our team's day-to-day development work, with much of the engineering done by coding agents"，并且"it is not identical to our internal version or the implementation described in"文章，文章讨论的部分设计是未来方向、原型未实现（`README.md:3-5`）。

### 5.2 领域模型（docs/001）

流程：Source 产生 Trigger → Trigger 进入 Thread → 订阅该 Thread 的 Ticket 收到上下文扇出；人的消息若已到达某个 Ticket 就留在那里，其余 Trigger 进入 Eval；Eval 以 accept（带 Mandate）或 stop 作用于 Ticket，或以 ignore / unavailable 只记录；Ticket 通过 Assignment 绑定 Executor，通过 Channel 写回 Source（`docs/001-domain.md:7,9-19`）。

核心概念与规则：

| 概念 | 定义与关键不变量 | 出处 |
| --- | --- | --- |
| Source | 事件流；一个 kind 是可复用实现，一个 instance 是一份配置 | `docs/001-domain.md:27` |
| Trigger | 不可变事件，带 Source 自己的元数据；同一 Trigger 接受两次只产生一个 Ticket；审计与幂等的单位 | `docs/001-domain.md:28` |
| Thread | 按时间排列的 Trigger，Source 定义哪些 Trigger 构成一个 Thread；同时最多一个 Eval；可有多个 Ticket | `docs/001-domain.md:29` |
| Correlation | 一个 Trigger 属于多个 Thread 时的关系；只增加上下文，从不路由 | `docs/001-domain.md:30` |
| Channel | Thread 的写侧；确认、回复、PR、解决评审都是写 | `docs/001-domain.md:31` |
| Policy | 版本化的研判规则加上每个 Source 的部分（谁能发起工作、如何同步、哪些 bot 可成候选） | `docs/001-domain.md:32` |
| Eval | 对一批 Trigger 的判断，两层：gate 与 assessment；输入是批次、Thread 快照、该 Thread 上所有 Ticket（含已结束的）和当前 Policy；无状态 | `docs/001-domain.md:33` |
| Mandate | accept 授予的内容：Policy 版本、范围、强度、匹配的规则、发送者身份、Source 如何收到该 Trigger；不可变，更宽的范围意味着新 Ticket；Ticket 结束不结束它 | `docs/001-domain.md:34`；`src/core/model.ts:126-134` |
| Ticket | 授权工作的单位；只有 Eval 能创建；状态 open → ended，人的消息可恢复，除非被人停止 | `docs/001-domain.md:35` |
| Assignment | Ticket 与一个 Executor 实例的绑定；一个 Ticket 随时间有多个；pending → running → ended；只有最终报告能从 Executor 一侧结束 Ticket | `docs/001-domain.md:36` |
| Subscription | Ticket 与 Thread 的多对多，由 Thread 持有；匹配的 Trigger 扇出给每个存活的订阅 Ticket，不检查发送者 | `docs/001-domain.md:37` |

"人"不是领域概念：Trigger 只携带 Source 给出的 actor 标识，白名单是 Source 在 Policy 中的一部分，跨 Source 的身份映射是提示词文本（`docs/001-domain.md:39`）。Executor 及其 Session、目录也在领域之外，通过 Assignment 连接（`docs/001-domain.md:41`）。

聚合边界：Source 持有读位置；Thread 持有订阅、串行运行的 Eval（期间到达的 Trigger 并入下一批）和 Decision 历史；Ticket 持有 Assignment、Channel 和 Input（`docs/001-domain.md:43`）。

001 用一张"拒绝的概念"表说明哪些看起来合理的设计被刻意排除，例如：不把 Principal/Membership 做成实体；Eval 不自己调度延迟 Trigger（需要等待的条件应是一个普通 Source）；一个 Thread 不限制只能有一个存活 Ticket；不设"append to Ticket"这种 Decision（追加是订阅扇出，不需要 Eval）；订阅不做准入检查（订阅覆盖整个 Thread，授权与上下文由 Mandate 分开）；Ticket 状态不跟随 DSH Session；Executor 不能声称人要求它停止（只有 Eval 决定停止的强度）；Policy 变更不取消运行中的 Ticket，而是记录并送达（`docs/001-domain.md:45-61`）。

可复用的是概念与规则；Source、Policy 内容、Executor、Channel 属于部署。本仓库的 Source 是飞书（实时事件、历史恢复、订阅话题轮询）和 GitHub（通知、订阅的 Issue 与 PR、CI 变更、PR 合并或关闭，以及可选的"接收全部"开关）；Channel 是飞书话题回复、GitHub 评论和评审线程回复（`docs/001-domain.md:62-71`）。

术语表给出中英对照，其中几个值得单独记：Gate 准入、Assessment 研判、Disposition 去向、Input 输入、Attention 待人工决定（`docs/001-domain.md:79-105`）。Decision 取值 accept / stop / ignore / unavailable；Strength 取值 explicit / inferred；Report 取值 progress / waiting / ready / blocked / failed / dropped（`docs/001-domain.md:107-112`）。

### 5.3 授权模型（docs/002）

总原则：白名单、规则和 Mandate 由宿主（代码）强制执行；消息、评论、引用的文档只是决策的输入，不能改变权限（`docs/002-authorization.md:5`）。

**Trigger 的两条路径**，正对应文章 §3.2 的 Slow Path 与 Fast Path：
- **Eval 路径**（是否开始新工作）：Source 记录消息是否 @ 了 Agent（`mention`）或是私信（`direct`）。gate 的规则是：白名单内的人 @ Agent 是 explicit 请求；Ticket 所在 Thread 上的跟进按后述规则处理；其他人类消息查准入表；Source bot 列表里的 bot 只能产生 inferred 候选，其他 bot 不准入（`docs/002-authorization.md:9-16`）。
- **订阅路径**（继续已有工作）：订阅 Thread 上的每条消息（含 bot 和 CI）都作为上下文送达订阅的 Ticket，绕过 gate，但不授予新权限，Ticket 仍受 Mandate 限制（`docs/002-authorization.md:20`）。

**跟进的归属**：人在 Ticket 自己 Thread 上的消息由该 Ticket 的 Executor 决定，期间不走 Eval、不产生 Decision；main Session 只收到 follow-up 通知，只能按人的要求停止工作，accept、attach、ignore、requeue 都会被拒绝（`docs/002-authorization.md:22-26`）。Executor 若认为消息超出范围或属于别的 Ticket，交回一次；只有在没有任何 Ticket 仍拥有它时才进入新的 Eval（`docs/002-authorization.md:30-32`）。Ticket 结束时，Executor 没读过或没处理的跟进会被释放回 Eval（`docs/002-authorization.md:34`）。

**强度**：explicit、inferred、不准入三档（`docs/002-authorization.md:48-52`）。

**准入表**：每个 Source 的 Policy 里有一张表，行是接收范围（飞书：每个配置的群、其他 @ 了机器人的群、私信；GitHub：新 Issue、新 PR、评论、默认分支 CI），每行最多三格（`docs/002-authorization.md:58-69`）：

| 格 | 可选 | 默认 |
| --- | --- | --- |
| 在名单内、未 @ Agent | inferred, ignore | inferred |
| 不在名单内、@ Agent | explicit, inferred, ignore | ignore |
| 不在名单内、未 @ Agent | inferred, ignore | ignore |

代码与文档一致：`ADMISSION_OPTIONS` 与 `ADMISSION_DEFAULTS`（`src/admission.ts:9-13`）。"未 @"的格只在 Source 接收全部消息时可用，例如飞书群设为"全部消息"或 GitHub 打开 receive-all 开关（`docs/002-authorization.md:71`）。

**accept mode**（`docs/002-authorization.md:93-101`）：
- `off`：inferred 的都不成为候选。
- `observe`（默认）：inferred 候选会被研判，正面结论记录为 ignore 并标注"would accept"，不实际接单。
- `auto`：正面研判直接接单。

explicit 请求在任何模式下都有效。文档建议先用 `observe`，看过记录的 Decision 后再切 `auto`。每次研判对每条启用规则恰好判断一次，主动接单至少需要一条匹配规则（`docs/002-authorization.md:101`）。这就是原型版本的"投机执行"：文章 §3.4 的"静默复现并修复"在原型里是一条 Policy 规则，匹配规则可以覆盖默认的流程和沟通要求，例如一条 silence 规则可以抑制确认消息（`docs/002-authorization.md:105`）。由于默认是 `observe`，开箱时主动工作只记录、不执行，与 000 的"start narrow"一致。

**路由候选**：main Session 用 `orchestrator_route` 处理 explicit 候选，一次调用可含多个决定，每项独立处理；inferred 候选通常需要完整研判，唯一捷径是卡片明显不涉及任何启用规则时可直接忽略，并记录 `ignoredFromCard`；接受 inferred 候选必须经过研判（`docs/002-authorization.md:85-89`）。

**Policy 版本**：规则、accept mode 和每个 Source 的 Policy 共同构成版本，每个 Mandate 记录它被接受时的版本。版本变化会丢弃运行中的 Eval 并重新排队，并给受影响的存活 Ticket 发一条 policy-changed Input；不立即撤销 Mandate（`docs/002-authorization.md:109-117`）。

**恢复前的重新校验**：已结束的 Ticket 保留 Mandate，人在其 Thread 上的消息可以恢复它而无需新的 Eval（bot 和 CI 不唤醒）（`docs/002-authorization.md:127`）。恢复前会按 Mandate 的依据重新校验：explicit 跟进直接通过；inferred 需要 `auto` 模式且匹配规则仍启用；准入表授予的需要在当前表与名单下仍达到原强度；bot 的需要该 bot 仍在列表中；其余需要发送者仍在白名单（`docs/002-authorization.md:131-139`）。只有三种操作改变 Mandate：accept 创建、人的 stop 撤回、校验失败撤销（`docs/002-authorization.md:129`）。

**Eval 超时**：时限从候选送达 main Session 时开始计；过期后重新排队，连续两次重试后第三次过期记录 `unavailable`（`docs/002-authorization.md:149-151`）。

### 5.4 执行模型（docs/003）

**Ticket 阶段**：按表从上到下取第一个匹配：`person / delivery`（Input 投递失败）→ `person / answer`（有 Attention）→ `person / review`（最新 Report 为 `ready`）→ `person / blocked, failed` → `working / queued` → `idle`（Report 为 `waiting` 或 Assignment 已结束）→ `working`（`docs/003-execution.md:9-17`）。代码中面板卡片使用封闭集合 `TICKET_STATES`（`src/app/cards.ts`，见 `docs/007-architecture.md:548`）。

**Executor**：每个 Ticket 一个 Session `worker-<ticket id>` 和一个目录，默认在 `<stateDir>/work` 下；Executor 以操作者 OS 用户身份无审批运行命令（`docs/003-execution.md:25-27`）。首次 Assignment 前若目录不存在，用 `sh` 运行一次 prepare 命令（通常是 `git worktree`），限时十分钟（`docs/003-execution.md:51-53`）。

**后台工作与槽位**：一轮结束时若仍有 shell job 或 subagent 运行，Ticket 继续占槽；每轮后后台工作最多 30 分钟，到时 kill job 并报告 waiting（`docs/003-execution.md:33-35`；`src/executor/dsh.ts:32`）。交给人（`ready`、提问、`blocked`、`failed`）时立即释放槽位（`docs/003-execution.md:37`）。

**并发**：并发上限作用于槽位，外加一个专给人的消息或状态请求的额外槽，唤醒优先于新启动，因此新工作不会让人的跟进排队（`docs/003-execution.md:57-61`；`src/executor/dsh.ts:169-194`）。CI 结果等其他 Input 等普通槽位。

**执行变量**：`DSH_SUPERAGENT_DIR`、`DSH_SUPERAGENT_TICKET`、`DSH_SUPERAGENT_BLOCKED_COMMANDS`、`DSH_SUPERAGENT_GITHUB_*`、`DSH_SUPERAGENT_FEISHU_*` 等，均不含凭据（`docs/003-execution.md:65-74`）。Worker 通过 agent 账号的 `gh` 和机器人的 `lark-cli` 访问外部；被禁止的命令按名字调用会失败，但这"不是安全边界"，可用绝对路径绕过（`docs/003-execution.md:78-80`）。

**合并**：自动合并由 Delivery requirements 提示词控制，宿主没有合并决策逻辑；默认从不以 agent 账号启用自动合并，因为 GitHub 会把合并归到启用者名下；默认条件是 PR 为本 Ticket 所开、已 ready、所需批准覆盖 head commit、增删行合计少于 200 行（`docs/003-execution.md:84-88`）。

**结束方式**：`ready` 且无 PR 即完成；`dropped` 表示无事可做，默认不发消息；有 PR 时，Ticket 在它开的 PR 都关闭后结束，并保留订阅以便后续评论恢复（`docs/003-execution.md:94-100`）。

**失败与恢复**（对应文章"持久"特征里的自愈部分，但全在进程内）：
- 模型或网络的瞬时失败（HTTP 408、429、5xx，连接被拒、重置或超时）先重试三次（`docs/003-execution.md:124`）。
- 重启后，运行中的 Assignment 以"host restarted"结束，新的 Assignment 带恢复说明，要求 Executor 在重复任何外部动作前检查目录、git 历史和 GitHub（`docs/003-execution.md:146`）。
- 决策之后要做的事（转发候选、启动 Assignment、投递 Input）先存储再执行（`docs/003-execution.md:155`）。这就是 `Effects` 持久化副作用队列：命令在事务内 `enqueue`，提交后才执行，按 kind 分别设并发与退避（`docs/007-architecture.md:164-180`；`src/app/effects.ts`）。
- 外发消息按存储的工作发送，退避从 5 秒加倍到 300 秒；同一 Ticket 发往同一会话的消息保持顺序（`docs/003-execution.md:177-181`）。
- "Pause processing"停止分派、新 Eval、Eval 超时、Input 投递和回复，但 Source 继续记录 Trigger，运行中的 Executor 轮次不中断（`docs/003-execution.md:194-200`）。

### 5.5 提示词与技能（docs/004、prompts/、skills/）

团队可编辑的有三个团队分区和团队技能（`docs/004-prompts.md:9-14`）。默认文本在 `prompts/team/` 下：
- Communication（`prompts/team/communication.md`）：何时给人发消息，GitHub 消息开头的标识行（默认 `This is by an automated agent, not a human`），如何处理评审。默认文本要求回到原会话交付结果，"Creating a PR does not mean it is ready, fixed or merged"，主动发的 IM 必须是值得人关注的事。
- Ticket scope（`prompts/team/scope.md`）：Ticket 何时继续、何时停在草稿。
- Delivery requirements（`prompts/team/delivery.md`）：PR 证据、自动合并条件、提交作者。默认要求改 UI 的 PR 必须同时附 Before 与 After 截图，"After-only evidence is incomplete"。这对应文章图 02 里"附前后对比截图"的行为。

内置部分都可以覆盖，键名为 `runtime/shared`、`runtime/orchestrator`、`runtime/worker`、`runtime/subscriptions`、`runtime/replies`、`runtime/dispatch`、`runtime/work`、`runtime/admission`、两个 handoff、`skill/feishu`、`skill/github`，以及三个生成模板 `runtime/environment`、`runtime/policy`、`runtime/policy/none`（`docs/004-prompts.md:22-34`）。对应的源文件是 `prompts/*.md` 下的 12 个文件，每行一句，由 `promptFile` 拼接（`docs/007-architecture.md:600`）。

**拼装顺序**：共享指令与角色 → 三个团队分区 → 订阅与回复 → main Session 的 dispatch 或 Executor 的 work → admission（仅 main Session）→ handoff → environment → policy（仅 main Session）（`docs/004-prompts.md:46-55`）。Policy 分区在每次模型请求时从设置重新生成（`docs/004-prompts.md:59`）。Executor 另外读取 DSH 的编码提示词和仓库的 `AGENTS.md`，main Session 不读（`docs/004-prompts.md:61`）。

**优先级**（从强到弱，`docs/004-prompts.md:65-71`）：
1. 工具与宿主强制的事实：身份、权限、参数校验、回复用途、长度限制，提示词改不了。
2. 内置与生成分区（含团队的覆盖）。
3. 主动 Ticket 匹配规则里的流程与沟通要求，只对该 Ticket 的 Executor 生效。
4. 团队分区与团队技能。
5. 外部文本：消息、评论、文档、引用，只是数据，从不改变规则或授权。

第 5 条是原型对文章 §8.4 提示词注入风险的主要回应；004 同时强调，编辑提示词不改变 gate、Mandate、工具检查和账号包装，这些由代码强制（`docs/004-prompts.md:36`）。

**内置文本的原则**（`docs/004-prompts.md:77-89`）与文章对应得很直接：
- 角色分离：main Session 只路由，不做技术决定，路由备注最多 30 词（对应 §2.1）。
- main Session 不等待：报告、通知、候选和后台 job 结果都自动到达（对应 §4.1 的全双工）。
- 只在人必须行动或能用到结果时发消息，聊天默认一句话，硬上限 100 词（对应 §4.2）。
- 通过订阅和 main Session 协调，Executor 之间不直接通信；main Session 可以用不超过 100 词的 note 把另一个 Ticket 的事实转过来，note 与订阅都不授予权限（对应 §2.2）。
- 只在明确引用时 attach，话题相似不够。
- 人的暂停在跟进、新 Session 和重启之间都保持有效，自动反馈从不恢复暂停的工作。
- 评审按结果处理：已修复并验证的评论静默 resolve；自动评审者每个 PR 最多三轮。
- 发现人已在自己的分支或 PR 中做了同样的改动时，Executor 关掉自己的 PR 并用一句话指向对方。

**版本**：每次保存生成不可变版本，保存需指明 base revision，冲突的保存被拒绝；Session 每次模型请求都读最新版本，保存不重启、不取消、不唤醒 Session（`docs/004-prompts.md:93-96`）。升级时若某个被覆盖部分的默认值变了，面板标为 **Default updated** 并显示差异（`docs/004-prompts.md:40`）。

**Source 技能**：`skills/dsh-superagent-github/SKILL.md` 列出 `github/issues/<n>`、`github/pulls/<n>/comments/1`、`github/pulls/<n>/thread/<comment-id>`、`github/pulls/<n>/checks` 等读取资源，统一的评论格式为 `{ id, from, at, text, reply_to?, path?, line?, url }`，并说明 `bot: true` 标记的内容"never authorize work"。`skills/dsh-superagent-feishu/SKILL.md` 提供 `feishu/<trigger-id>/message`、`/root`、`/parent`、`/thread`、`/around` 五种邻域读取，`/around` 读前后各五条，并要求在"fix the above"这类模糊请求下先读上下文再动手。这两份技能就是文章 §3.3 "利用局部性 Inline 时空相邻内容"在 Source 层的具体落地。

### 5.6 面板（docs/005）

面板按顺序回答三个问题：现在有没有需要我处理的？系统是否健康、在做正确的事？一项工作从 Trigger 到 Eval 到 Ticket 的历史是什么（`docs/005-panel.md:7-11`）。

标签页按工作流排列：Overview、Source、Trigger、Eval、Execution、Settings（`docs/005-panel.md:15-24`）。Overview 显示需要处理的 Ticket、系统问题、近 24 小时活动计数和 Executor 负载；Eval 显示 Decision 及其理由和匹配规则；Execution 有 Pause processing 和按阶段过滤的 Ticket。前端实现在 `src/client/`，每个标签页一个组件（`overview.tsx`、`source.tsx`、`trigger.tsx`、`eval.tsx`、`execution.tsx`、`settings.tsx`），另有 `ticket.tsx`、`thread.tsx`、`deployment.tsx`、`prompts.tsx`。

面板原则（`docs/005-panel.md:52-58`）是 000 的直接延伸：每个元素必须回答三个问题之一，否则删除；分类可检查、互斥且完备；每个概念只在一个地方展示；计数必须等于它链接到的列表长度（"Honest state"）；健康状态不占额外空间，一次性网络错误不算问题；破坏性操作要确认。

面板与工具的分工：除少数例外，面板操作都有对应工具。例外是忽略 unavailable Decision、重跑 setup、刷新 Source 显示名，以及把 Executor 拥有的人类跟进送去 Eval；最后一项被 `orchestrator_trigger_requeue` 刻意拒绝（`docs/007-architecture.md:596-598`）。这样 main Session 无法绕过"跟进由 Executor 决定"的规则。

文章 §8.2 提出"交互可能可以更多发生在领域特化的界面中"。原型的回答是：日常交互发生在 GitHub 和飞书里，面板只给监督者用，不是聊天窗口。

### 5.7 部署（docs/006、SETUP.md、scripts/、examples/）

- **运行形态**：一个专用 DSH profile（文档中叫 `superagent`），加载 bundle 并在 `127.0.0.1` 提供面板；要和日常 profile 分开，因为插件会修改进程级 `PATH` 和 git 设置，进程需要独立重启（`docs/006-deployment.md:7`）。另需一个 agent GitHub 账号，飞书机器人可选（`docs/006-deployment.md:8-9`）。
- **权限与隔离**：两个 preset 都以 `danger-full-access` 运行，账号包装只选择凭据，不隔离进程；Worker 可按路径执行程序、读取操作者的 home 目录；需要隔离就用专用 OS 账号（`docs/006-deployment.md:13-19`）。代码中 `ctx.permissionPresets.set(result.agent.session, 'danger-full-access')`（`src/app/sessions.ts:152`）。
- **前置条件**：Node.js 22.19+ 或 24+、pnpm、git 2.32+、Python 3.8+、tmux、`gh` 2.48+；只支持 github.com，不支持 GitHub Enterprise Server（`docs/006-deployment.md:21-27`）。
- **机器配置**：复制 `examples/profile.cordis.patch.yml` 到 `~/.dsh/profiles/superagent/cordis.patch.yml`；必填 `stateDir`（数据库、锁、`worker-bin` 命令垫片、agent 的 git 配置、默认 Ticket 目录），可选 `promptMaxChars`、`admissionContextMaxPages`、`admissionContextTimeoutMs`；未知键会阻止启动（`docs/006-deployment.md:89-98`）。代码 `src/deployment.ts:14-42` 一致：`stateDir` 为 `.required()`，其余字段为 `Volatile<number>`，读取时拒绝未知键并指出已废弃键的新位置。除 `stateDir` 外所有配置都可热更新（`docs/007-architecture.md:606`）。
- **启停**：`scripts/dsh-superagent start` 在 tmux 会话 `dsh-superagent` 中运行 `dsh --profile superagent`，拒绝重复实例；`stop` 与 `restart` 请求优雅关闭，最多等 Executor 五分钟，从不强杀；`status` 的退出码 0 正常、1 未运行或运行时出错（重启可能修复）、2 某部分出错（重启修不了）、3 等待 setup（`docs/006-deployment.md:100-124`）。
- **每小时检查**：放在日常 profile 而不是 `superagent` 里，以便服务挂掉时仍能运行；按 `status` 的退出码决定沉默、通知或重启；`--respect-stop` 保留有意的停止，只有 `stop` 写标记（`docs/006-deployment.md:133-141`）。这是原型里最接近文章 Watchdog 的部分：同样"在主系统之外"，同样由定时消息驱动一个 Agent，但只看基础设施健康状态，不看任务进展。
- **SETUP.md**：写给 coding agent 读的安装指引，而不是给人读的。它本身也遵循 000：先只读 SETUP.md 与 000 并跑一次探测；一次只问一个问题；每条消息不超过 300 词，并附可一个词接受的推荐答案；问完再给出完整计划，确认后才执行；从不在聊天里索要密钥（`SETUP.md:5-14`）。

### 5.8 其他文件

- **`cordis.patch.yml`**：bundle 层配置，插入插件并定义两个 agent preset。`dsh-superagent-worker-preset` 是 DSH `standard` 的精简版，前台 shell 5 秒转后台；`dsh-superagent-router-preset` 有同样的 5 秒限制和更小的工具集（`cordis.patch.yml:13-21,121-126`）。文件注释还说明：spawned subagent 在 `standard` 下运行，其 shell 60 秒后才转后台，因为 subagent 结束时其 job 会被 kill（`cordis.patch.yml:17-18`）。原型的"异步 ReAct Loop"主要靠这个文件实现。
- **`src/kv.ts`**：集中定义每条 KV 记录的所有者、键和类型，包括 schema 版本、设置与提示词版本、`master-id`、每个 Session 用过的提示词版本、GitHub 游标与 CI 指纹、飞书已见消息、Source 显示名；只有迁移代码使用旧键（`docs/007-architecture.md:470-481`）。
- **`src/limits.ts`**：各数值配置的上下限，例如 `maxWorkers: { min: 1, max: 16 }`（`src/limits.ts:6`）。
- **`locale/en.json`、`locale/zh.json`**：面板中英文案；面板一次只显示一种语言，(?) 按钮打开中英对照术语表（`docs/001-domain.md:75`）。
- **`tests/`**：每个模块有对应的 spec。值得注意的几个：`tests/model-surface.spec.ts` 检查提示词、工具描述等面向模型的接口是否漂移（`docs/007-architecture.md:602`）；`tests/docs.spec.ts` 读取 README、SETUP 和 `docs/` 下所有文档，检查编号文档、相对链接，并从 `docs/007-architecture.md` 的表格第一列提取文件路径与仓库对照（`tests/docs.spec.ts:1-20`）。也就是说，007 的模块表有测试约束，不容易与代码脱节。`tests/class-docs.spec.ts` 我只看了文件名，没有读内容。
- **`prompts/team/scope.md`**：默认范围规则是"按影响而不是按工作量"的具体写法。授权的小改动由 Worker 一路推进到完成，"几百行模块内生产代码"只是例子，不是固定行数；改几行 CSS 不能证明设计方向已定；没有固定的调查或实现轮数上限。
- **`docs/agents/`**：给参与开发的 coding agent 的说明。`AGENTS.md:13` 指向根目录的 `GLOSSARY.md` 与 `docs/adr/`，但这两者在仓库里并不存在。不属于运行时设计。

## 6. 结论

1. **原型实现了文章架构的中段，没有实现两端。** 双层架构、两级过滤、Thread、订阅直通、多对多订阅、Inline & Spill、链式召回、100 词 IM 规则在原型里都有对应的代码和文档。§5 的存算分离与端侧 daemon（BYOM）、§6 的模型驱动 Watchdog、邮件与日程信道都没有实现。原型是单机、单进程、单 SQLite 文件，只服务一个 GitHub 仓库。
2. **原型在几处换了做法，而且有理由。** 订阅挂在 Ticket 上而不是 Session 上，让订阅在重启和重试后不依赖某个 Session 存活。异步 ReAct Loop 由"前台 5 秒转后台 job + 完成时唤醒 + main Session 的 `noWait` 守卫"实现，没有 `start()`/`stop()` 工具。批处理以 Thread 为单位串行合并，再加上一次路由 1–20 个决定。
3. **有一处与文章明显不同：Worker 会直接对外发言。** 文章说 Worker 不直接与人交互，图 03 也只有 Router 连向信道。原型的 Executor 用 `orchestrator_ack` 在原消息下确认、自己开 PR、回复评审；只有向人提问时才经由 main Session 转发。
4. **原型补上了文章几乎没谈的授权层。** Mandate（不可变，记录 Policy 版本、强度、匹配规则）、准入表、explicit/inferred 两种强度、恢复前的重新校验、"外部文本只是数据"的优先级，构成了 §8.4 安全问题的部分答案。投机执行变成了 Policy 规则加 accept mode，而且默认是 `observe`：只记录"本会接单"，不实际执行。
5. **原型自己承认的边界。** 包装脚本和目录不是安全边界，进程是 `danger-full-access`；旧记录从不删除；哪些 Trigger 字段可信仍是开放问题（`docs/003-execution.md:80`；`docs/007-architecture.md:484,616`）。
6. **原型没有可复现文章 §7 实验的代码。** 文章的数字（p50 12.4 分钟、p95 15.7 分钟、去掉直通后 token 增加约 37%、batch 1.0→2.8）只能以文章为准，而且文章自己说明这些是合成负载下的初步结果。

## 来源

文章：
- `super-agent reference/super-agent.md`（全文）
- `super-agent reference/images/super-agent-01.jpg` 至 `super-agent-11.jpg`，`super-agent-12.png` 至 `super-agent-15.png`（全部 15 张已查看）

原型文档：
- `dsh-superagent-prototype/README.md`、`SETUP.md`、`AGENTS.md`
- `dsh-superagent-prototype/docs/000-philosophy.md` 至 `docs/008-cookbook.md`

原型代码与配置：
- `dsh-superagent-prototype/cordis.patch.yml`
- `dsh-superagent-prototype/src/admission.ts`、`src/deployment.ts`、`src/kv.ts`、`src/limits.ts`
- `dsh-superagent-prototype/src/core/model.ts`、`core/engine.ts`、`core/intake.ts`、`core/evals.ts`、`core/replies.ts`
- `dsh-superagent-prototype/src/app/sessions.ts`、`app/runtime.ts`、`app/migration.ts`、`app/effects.ts`、`app/assessment.ts`、`app/resources.ts`、`app/tools/`
- `dsh-superagent-prototype/src/executor/dsh.ts`
- `dsh-superagent-prototype/src/client/`、`src/infra/`、`src/sources/`（目录结构）

提示词、技能、测试及其他：
- `dsh-superagent-prototype/prompts/*.md`、`prompts/team/communication.md`、`prompts/team/delivery.md`、`prompts/team/scope.md`
- `dsh-superagent-prototype/skills/dsh-superagent-github/SKILL.md`、`skills/dsh-superagent-feishu/SKILL.md`
- `dsh-superagent-prototype/tests/docs.spec.ts`、`tests/followups.spec.ts`（其余 spec 只看了文件名）
- `dsh-superagent-prototype/examples/profile.cordis.patch.yml`、`scripts/dsh-superagent`、`locale/`（只确认了用途）
