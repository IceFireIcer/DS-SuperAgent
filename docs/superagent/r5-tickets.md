# R5 实施票与旧计划交接

- 批准与发布日期：2026-11-14。
- 总规格：[Issue #1](https://github.com/IceFireIcer/DS-SuperAgent/issues/1)，[本地 R5 正文](spec-r5.md)。
- 已创建 36 张直接原生子 Issue，设置 `ready-for-agent`、`enhancement` 和 68 条直接 blocked-by；不再新增功能父票。
- 完整交付内容、验收条件、24 个场景及 85 项旧操作的责任归属见[已批准拆分正文](r5-tickets-draft.md)。
- 编号、正文摘要哈希、原生关系、关闭评论及最终回读结果见 [r5-publication.json](r5-publication.json)。只有其中 `verified: true` 才表示整批远端核对完成。
- 发布时回读已完成：36 张正文和标签、36 条父子关系、68 条阻塞关系、15 个关闭理由及承接评论均匹配；总规格和两张保留验收票的正文、标签及既有关系保持一致。当时远端共有 39 个开放 Issue。
- 本轮只清理和发布票据；未实施产品、运行测试、启动服务、提交或推送。

## R5 实施收口（2026-11-15）

截至 `dev` 提交 `adaf2ba06269688ddead8714c839a48f6add5b9d`，R5-01—R5-11 与 R5-13（#93—#104）已合入并关闭；每张票的验收清单均已勾选，关闭评论链接到实施和审查记录。R5-12（#105）及 R5-14—R5-36（#106—#128）仍开放。总规格 #1、T55/#83 和 T58/#92 继续开放，负责整体产品与托管组合验收。

本次实时 blocker 查询中，当前无未关闭前置的票为：R5-12/#105、R5-14/#106、R5-15/#107、R5-17/#109、R5-22/#114、R5-25/#117、R5-32/#124。飞书真实租户验收仍遵循维护者暂缓决定。开始后续工作前仍应重读 GitHub 实时 blocked-by。

## 2026-11-16 增量进展

`dev` 的 `4a6e060` 已收口 R5-12/#105、R5-17/#109、R5-22/#114；最新对应 Test run `43745616891` 成功。R5-32/#124 保持开放，缺三层产品生产 TLS 与跨机 SSH 隧道证据。本轮继续实施 R5-14/#106 的[附件/语音链路](implementation/r5-14.md)，并合入 R5-15/#107 的[凭据核心](implementation/r5-15.md)及 R5-25/#117 的[预设核心](implementation/r5-25.md)；三张新票仍有各自的完整验收缺口，均未关闭。上节记录的是 2026-11-15 当时的状态，不代表今天的 OPEN/CLOSED。

初始实施入口是 [R5-01 / #93](https://github.com/IceFireIcer/DS-SuperAgent/issues/93)：在现有主对话与独立 Main 持续交流。R5 编号是稳定计划标识，GitHub 编号按依赖顺序分配。R5-13 是 R5-11/12 的前置，因此先发布为 #103，R5-11/12 随后为 #104/#105。

2026-11-16 后续代码审计重开 R5-22/#114，发现设置页只显示最近 occurrence。现已补逐次发生历史、每条关联工作回查及定向 UI 验证，重新收口 #114；上述增量记录只代表当时状态。

2026-11-17 收口 R5-33/#125：产品 Host 支持共享 PostgreSQL 业务库与 Session provider，托管 profile 在租约替换前取得新 epoch，并把真实 ended waiting-human Assignment 纳入接管对账。真实两进程测试恢复同一 Main/Router/Worker 工作；分层窄测继续覆盖停止、unknown、设备作业、客户端游标、业务提交失败和 Session writer epoch。详见[实施记录](implementation/r5-33.md)及[双轴复核](implementation/reviews/r5-33.md)。真实服务器、第二设备、持续四目标与飞书租户仍分别归 T58/T55 或暂缓。

## 新票映射

| 计划 ID | GitHub Issue / 交付行为 | 直接阻塞 |
| --- | --- | --- |
| R5-01 | [#93 在现有主对话与独立 Main 持续交流](https://github.com/IceFireIcer/DS-SuperAgent/issues/93) | 无 |
| R5-02 | [#94 从 Main 委托一项本地工作并收到有界结果](https://github.com/IceFireIcer/DS-SuperAgent/issues/94) | 01 |
| R5-03 | [#95 将一条复合请求可靠分解为并行工作](https://github.com/IceFireIcer/DS-SuperAgent/issues/95) | 02 |
| R5-04 | [#96 把跟进交给原工作并处理越界交回](https://github.com/IceFireIcer/DS-SuperAgent/issues/96) | 03 |
| R5-05 | [#97 自动展示只读 Router、Worker 和新工作历史](https://github.com/IceFireIcer/DS-SuperAgent/issues/97) | 02 |
| R5-06 | [#98 分开停止 Main 回复与持久停止工作](https://github.com/IceFireIcer/DS-SuperAgent/issues/98) | 02 |
| R5-07 | [#99 在主对话直接回答当前问题卡](https://github.com/IceFireIcer/DS-SuperAgent/issues/99) | 02 |
| R5-08 | [#100 Main 故障时继续工作并可靠补读](https://github.com/IceFireIcer/DS-SuperAgent/issues/100) | 06、07 |
| R5-09 | [#101 换代 Main 上下文并按需核查证据](https://github.com/IceFireIcer/DS-SuperAgent/issues/101) | 05、08 |
| R5-10 | [#102 在现有设置独立配置三层模型与指令](https://github.com/IceFireIcer/DS-SuperAgent/issues/102) | 05 |
| R5-11 | [#104 在 GitHub 进入 Main 并直通已有工作](https://github.com/IceFireIcer/DS-SuperAgent/issues/104) | 04、13 |
| R5-12 | [#105 在飞书按三层角色处理讨论与答复](https://github.com/IceFireIcer/DS-SuperAgent/issues/105) | 04、13 |
| R5-13 | [#103 可靠交付三层消息并限制跨受众发布](https://github.com/IceFireIcer/DS-SuperAgent/issues/103) | 02 |
| R5-14 | [#106 用附件、图像与语音发起和核查工作](https://github.com/IceFireIcer/DS-SuperAgent/issues/106) | 02、05 |
| R5-15 | [#107 管理新资源的凭据与授权](https://github.com/IceFireIcer/DS-SuperAgent/issues/107) | 01 |
| R5-16 | [#108 在授权工作中使用 MCP 与能力配置](https://github.com/IceFireIcer/DS-SuperAgent/issues/108) | 02、15 |
| R5-17 | [#109 选择工作目录并推进异步命令与子代理](https://github.com/IceFireIcer/DS-SuperAgent/issues/109) | 02、06 |
| R5-18 | [#110 使用有隔离与租约的浏览器资源](https://github.com/IceFireIcer/DS-SuperAgent/issues/110) | 15、17 |
| R5-19 | [#111 人工接管浏览器并安全归还工作](https://github.com/IceFireIcer/DS-SuperAgent/issues/111) | 07、18 |
| R5-20 | [#112 在工作中生成 Office 交付与结构化视图](https://github.com/IceFireIcer/DS-SuperAgent/issues/112) | 14、17 |
| R5-21 | [#113 使用、学习与撤销有归属的记忆](https://github.com/IceFireIcer/DS-SuperAgent/issues/113) | 09、15 |
| R5-22 | [#114 将日程 occurrence 投递给授权工作](https://github.com/IceFireIcer/DS-SuperAgent/issues/114) | 04、06 |
| R5-23 | [#115 在规则预算内主动准备可审阅结果](https://github.com/IceFireIcer/DS-SuperAgent/issues/115) | 04、13、17 |
| R5-24 | [#116 在三层工作上运行 Watchdog 与语义监督](https://github.com/IceFireIcer/DS-SuperAgent/issues/116) | 08、17 |
| R5-25 | [#117 审阅旧配置并应用为角色预设](https://github.com/IceFireIcer/DS-SuperAgent/issues/117) | 10 |
| R5-26 | [#118 预览并选择导入记忆资源](https://github.com/IceFireIcer/DS-SuperAgent/issues/118) | 21 |
| R5-27 | [#119 预览并选择导入浏览器资源](https://github.com/IceFireIcer/DS-SuperAgent/issues/119) | 18 |
| R5-28 | [#120 选择导入凭据引用并重新授权](https://github.com/IceFireIcer/DS-SuperAgent/issues/120) | 15 |
| R5-29 | [#121 在主对话选择本地或授权远端执行](https://github.com/IceFireIcer/DS-SuperAgent/issues/121) | 14、15、17 |
| R5-30 | [#122 离线停止并对账远端未知结果](https://github.com/IceFireIcer/DS-SuperAgent/issues/122) | 29 |
| R5-31 | [#123 在安全边界双向交接同一工作](https://github.com/IceFireIcer/DS-SuperAgent/issues/123) | 30 |
| R5-32 | [#124 通过认证客户端连接同一远程主对话](https://github.com/IceFireIcer/DS-SuperAgent/issues/124) | 05、08、13 |
| R5-33 | [#125 托管替换后恢复三层会话与工作权威](https://github.com/IceFireIcer/DS-SuperAgent/issues/125) | 09、10、24、30、32 |
| R5-34 | [#126 移除旧 Bot 运行架构及兼容入口](https://github.com/IceFireIcer/DS-SuperAgent/issues/126) | 11、12、16、19、20、21、22、23、25、31、33 |
| R5-35 | [#127 从独立安装包启动同一三层产品](https://github.com/IceFireIcer/DS-SuperAgent/issues/127) | 34 |
| R5-36 | [#128 升级、备份并观测新产品自身状态](https://github.com/IceFireIcer/DS-SuperAgent/issues/128) | 35 |

直接阻塞栏的两位数字均为 R5 计划 ID，不是 GitHub Issue 编号。实施以远端原生关系为准。

## 旧计划处理

- G01—G14（#15—#28）和旧 T56/#90 共 15 个 Issue 以 `not_planned` 关闭，理由是被维护者批准的 R5 计划替代；不声称未完成的功能整体验收通过。
- 旧正文、原生层级及已关闭的实施子票保留。关闭评论链接实际承接的新 Issue；G14 的旧历史兼容、双 profile 及旧核心回切按 R5 取消，可选资源导入和新产品备份升级分别接续。
- 总规格 #1、最终四目标验收 [T55/#83](https://github.com/IceFireIcer/DS-SuperAgent/issues/83)、真实托管和第二设备验收 [T58/#92](https://github.com/IceFireIcer/DS-SuperAgent/issues/92) 保持开放，本轮不改正文或既有阻塞关系。
- T55/T58 按新票的实际交付和证据判断是否具备验收条件；不能因为旧 blockers 已关闭就跳过 R5-29—33 的产品接线或整批 R5 能力。真实飞书租户验收继续沿用已批准的暂缓决定。
- 发布前快照哈希、关闭依据、承接票和评论链接保存在发布记录中；原 v2.1 的 [publication.json](publication.json) 不被覆盖。
