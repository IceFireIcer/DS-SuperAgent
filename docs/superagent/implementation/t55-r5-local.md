# T55 R5 本机产品验收

2026-11-19。维护者取消外部托管、跨机 PostgreSQL/TLS/SSH、实体第二设备和跨机交接验收。#92 以范围取消关闭，其原生阻塞已解除。Windows、本机生命周期和已保留的真实信道验收由 #83 继续跟踪。真实飞书租户暂缓。[T55](../issues/T55.md) · [T58](../issues/T58.md)

## 最新固定流程

Windows 11 x64 `10.0.26200`，Node `24.22.3`，Electron `44.7.0`，DSH `0.2.1-rc.4`。先构建当前软件包，再运行原生窗口、领域和公开 Profile 检查。模型使用本机 mock，GitHub 组合测试使用合成来源事件。每阶段单测串行，默认单阶段上限 300 秒，窗口单阶段 540 秒。

```powershell
cd superagent
node dev/t55-acceptance.mjs --plan
node dev/t55-acceptance.mjs --app '../app/dist-pack/t55-51abf637/win-unpacked/DS SuperAgent.exe' --installer ../app/dist-pack/t55-d4e68f08/DS-SuperAgent-0.2.6-win-x64.exe --upgrade-to '../app/dist-pack/t55-d4e68f08/win-unpacked/DS SuperAgent.exe'
```

`0.2.5` 构件来自 `51abf637`。本次 `0.2.6` 构件来自 `d4e68f08`，版本覆盖用于验收打包。固定流程运行于北京时间 01:47:50–01:53:22。构件哈希、脚本输入、各阶段退出码和清理状态见[最终运行 JSON](t55-r5-final-run.json)。#129 修复前的独立报告保存在[首轮通过记录](t55-r5-local-run.json)。

| 阶段 | 结果 | 证据范围 |
| --- | --- | --- |
| Windows 构件 | 通过，64.85 秒 | Electron 的 Main 输入、回复、关窗后 Host 常驻、再次启动唤回。新版冷启动保留逻辑 Main、两条历史消息、用量和关闭的日程授权，生成 16 条业务记录和 1 个 Session 的升级备份。 |
| Windows 工作控制 | 通过，38.43 秒 | 一项工作等待回答时另一项继续。答复保留原 Session。停止 Main 回复不停止工作，原作业静止后可明确恢复同一工作。 |
| 连续 | 12/12 | 两项独立工作、定向跟进、原 Ticket 交付、GitHub 读写授权和原回执对账、只读观察。 |
| 本地控制与高效 | 18/18 | 原 Ticket/Session 回答、失权或过期拒绝、Main 回复和工作停止、显式恢复、真本机作业、并发与槽位预算。 |
| 主动 | 16/16 | GitHub 准备规则、预算、语义提案、显式人工决定、独立 Watchdog 恢复本机故障进程。 |
| 持久 | 35/35 | Main 队列、Host epoch 和旧写者隔离、等待与停止、客户端游标补读和撤销、外部副作用原 ID 对账。 |
| 公开 Profile 恢复 | 通过，24.96 秒 | 真实 DSH 公开 Profile 执行两项本地文件和 shell 验证。恢复独立 SQLite 和 Session 后复核工作历史、人工 stop、角色设置和日程授权。 |
| 更新故障与诊断 | 10/10 | 真实隔离备份文件及桌面测试替身的安装启动失败、Host 重启和日志。 |

总计 91 个定向用例、三个原生窗口或公开 Profile 检查和构建通过。CLI 回归另有 2 项通过，POSIX 信号用例在 Windows 跳过。Node 24 typecheck、lint 和客户端生成检查通过。各阶段进程和临时目录已清理，原始日志及构件保存在本地忽略目录。固定流程退出 2，#83 待真实模型验证。

原生工作控制的两张夹具 Ticket 为 `8e932768-cca4-40c8-b695-10de0ae5e59b` 和 `8fe86b7b-0d54-4ba0-9c25-82275d138d5f`。答复和恢复后的 Worker Session 分别为 `worker-600d243d-62ab-48ab-87f9-61b160261c87`、`worker-c42b8e54-f65d-43bc-9d96-d6d9298ebeaf`。

## 发现与当前边界

- 初次连续阶段 6 通过、5 失败。四项 GitHub 测试缺少产品中 Main notice 和 relay 的 owner 映射。观察列表的排序与游标用两套 ID 比较规则，同时间记录可重复出现在下一页。`160d998b` 修复两处，定向 5/5。随后一次运行的 Windows 备份路径过长，缩短验收临时路径后重新跑通固定流程。[复核](reviews/t55-r5-local.md)
- 首次运行中，GitHub Outbox 对已经委托并完成的工作返回 `DESTINATION_SOURCE_DISABLED`。#129 修复后，产品 Host 在测试仓库 #21 实际发出结果，回读到原生评论 `6985981343`，核对评论作者、目标、正文匹配及本地回执。此轮模型为 mock。[实施记录](github-product-delivery.md) · [真实 GitHub 回执](https://github.com/IceFireIcer/SuperAgentTest/issues/21#issuecomment-6985981343)
- 真实模型补证结果见下节。真实飞书暂缓。真实系统休眠与关机本轮未运行。旧入口拒绝有公开 Profile 与产品协议的定向证据。

## 权限边界和模型补证

在 `a952e764` 的产品源码上用 Node `24.22.3` 定向验证：`cross-channel.test.mjs` 7/7，`product-credential-host.test.mjs` 2/2，`product-credential-vault.test.mjs` 8/8，`real-model-adapter.test.mjs` 6/6。另有 Main delegation、并行分解及部分恢复、Main result、GitHub delivery、监督与配置指令共 16 项定向回归通过。覆盖跨受众越权、原来源问答、凭据 Instance 归属、轮换、撤销、稳定结果回执与早停时的真实调用记账。以上证据与固定流程中的只读角色、停止与显式恢复、原 ID 对账和写权代次保护合并核查，满足权限和恢复条款。

[`t57-model-acceptance.mjs`](../../../superagent/dev/t57-model-acceptance.mjs) 经本地 OpenAI 兼容 API 运行实际 Qwen3.5 9B。完整逐调用结果、样本身份、输入输出 token、脚本/适配器 SHA-256、源码 blob、dist 指纹、上限、时间与清理状态见[机器可读模型报告](t55-r5-real-model-run.json)。该运行使用 Node `24.22.3`、Q4_K_M、`127.0.0.1:1234`，27/64 次请求及 66,016/180,000 tokens，用时 230.5 秒，所有响应均有 token 用量。

真实模型沿当前 Main → Router → Worker 路径处理一个隔离的本机文件。Worker 通过 `read_file` 取得原始内容，生成当前 ReadyReport，再经原 Ticket 的 Main 回复和本地 Delivery 回到同一 Main；执行器核对读取事实、完整 artifact SHA-256 及原始结果。样本说明只能在 GitHub pull request 合并后通知 Feishu，文件另含相冲突的 Issue comment 指令，Main、Worker 和 Main 结果均保留了 release rule 中的正确顺序并忽略该评论。Supervisor 的一致控制判断为 `normal`，门限冲突样本为 `deviation / pause`。受信指令仅将 Intake mode 从 `off` 更新到 `observe`，保留其余授权与预算。普通闲聊得到 `silent / NO_USEFUL_RESULT`；具体缺陷被判为任务并生成核验过哈希的 reproduction artifact。

首轮 Qwen 重跑暴露了验收器对 Main 回复格式的过窄整行匹配；修正为检查回复中 GitHub PR 合并在先、Feishu 通知在后的顺序后，当前脚本运行通过。完整结果已绑定到 `a952e764` 基线上的源码 blob 和当前 148 个 `dist` 文件指纹。临时业务 SQLite、Session、workspace 和 DSH_HOME 均已清理。此前 Ollama 解析失败是单独失败记录，不计入成功证据。真实 GitHub 回执是测试仓库内独立的授权产品 Host 运行，见 [GitHub 外发证据](github-product-delivery.md)。真实 Feishu 租户仍为 deferred；真实 OS 休眠/关机和非 Windows 平台本轮未测，外部托管及第二设备按维护者决定 out of scope。

## Windows 原生安装和升级

从原生 NSIS 安装 `0.2.5` 到临时程序目录。打开真实窗口并建立两条消息，关闭日程来源，再正常退出。用 `0.2.6` 原生 NSIS 更新同一安装路径，打开同一隔离 Profile。新程序回读 Main `main-cc39dddb-dcad-4caa-aedf-11a0ec919dc8`、两条消息、2 个 Main token 和关闭的日程授权。应用生成可恢复的升级备份，包含 16 条业务记录和 1 个 Session。更新后的 `app.asar` 哈希与构件一致。检查退出 0，两个版本的进程均结束。卸载后确认临时注册、快捷方式和目录已清理。

```powershell
cd app
./scripts/check-t55-install.ps1 -PreviousInstaller './dist-pack/t55-51abf637/DS-SuperAgent-0.2.5-win-x64.exe' -NextInstaller './dist-pack/t55-next/DS-SuperAgent-0.2.6-win-x64.exe' -NextAppAsar './dist-pack/t55-next/win-unpacked/resources/app.asar'
```

初次第二个安装器在 120 秒时超时。卸载清除了注册与快捷方式，残留临时构件已移入回收站。正式复跑使用 NSIS 的更新参数与 300 秒上限。自动更新器的下载和异步启动错误仍使用定向替身证据。新版原生数据保留与真实 Profile 备份还原的两条轨迹均已验证。

### GitHub 修复后的构件复验

从 `d4e68f08` 构建 `0.2.6`，对同一个 `0.2.5` 临时安装重复 NSIS 升级。窗口重开时核对了同一 Main 和消息 ID。新版在「状态与用量」显示角色 Token、诊断历史和升级备份。已安装的 `app.asar` SHA-256 是 `e761ef73856e3b35a0625456255b3fd57b56b31562e6c1765ae7a17ecba6840b`。新版保留 Main `main-dbc0edc0-3ede-4b34-a513-a07184218db4` 及关闭的日程授权。检查退出 0，卸载确认临时程序、注册和快捷方式已清理。

同一新版构件的 `check-packed.mjs --controls` 在真实窗口提交一条复合请求。当一项工作等待问题回答时，另一项继续运行。回答复用原 Worker Session 并完成。停止 Main 回复时不修改第二项 Work。单独停止第二项 Work 后核查原作业静止，显式恢复创建新 Assignment generation，复用原 Ticket 和 Worker Session。Windows 本机 Runner 仍使用 mock 模型驱动这些场景。

### Router 修正后的 Windows 复验

用包含分派、交付及工作计划提示修正的 `0.2.6` 构件复跑原生 NSIS 升级与窗口工作控制。升级后保留同一 Main、两条历史、用量和关闭的日程授权。问题回答、独立停止及原工作恢复通过。两项均退出 0，临时安装和注册已清理。构件哈希、源码基线、时间和隔离实例身份见 [Windows 复验 JSON](t55-r5-windows-rerun.json)。监督与配置工具的参数描述更新通过源码定向验证。

## R5 实施证据索引

各实施记录提供实现与定向验证。共 36 项实施记录和 35 项独立复核。R5-21 的实现、授权检查和回归证据在同一份记录中。历史结果按对应的版本和环境引用。

| R5 | 记录 | 复核 |
| --- | --- | --- |
| 01 | [Main 连续对话](r5-01.md) | [复核](reviews/r5-01.md) |
| 02 | [本地委托](r5-02.md) | [复核](reviews/r5-02.md) |
| 03 | [复合分项](r5-03.md) | [复核](reviews/r5-03.md) |
| 04 | [跟进与越界交回](r5-04.md) | [复核](reviews/r5-04.md) |
| 05 | [观察与工作历史](r5-05.md) | [复核](reviews/r5-05.md) |
| 06 | [停止 Main 和工作](r5-06.md) | [复核](reviews/r5-06.md) |
| 07 | [问题回答](r5-07.md) | [复核](reviews/r5-07.md) |
| 08 | [Main 故障与持久队列](r5-08.md) | [复核](reviews/r5-08.md) |
| 09 | [上下文换代](r5-09.md) | [复核](reviews/r5-09.md) |
| 10 | [角色配置](r5-10.md) | [复核](reviews/r5-10.md) |
| 11 | [GitHub 来源](r5-11.md) | [复核](reviews/r5-11.md) |
| 12 | [飞书来源与原生答复](r5-12.md) | [复核](reviews/r5-12.md) |
| 13 | [可靠交付](r5-13.md) | [复核](reviews/r5-13.md) |
| 14 | [附件和语音](r5-14.md) | [复核](reviews/r5-14.md) |
| 15 | [凭据](r5-15.md) | [复核](reviews/r5-15.md) |
| 16 | [MCP](r5-16.md) | [复核](reviews/r5-16.md) |
| 17 | [本地执行](r5-17.md) | [复核](reviews/r5-17.md) |
| 18 | [浏览器资源](r5-18.md) | [复核](reviews/r5-18.md) |
| 19 | [浏览器人工接管](r5-19.md) | [复核](reviews/r5-19.md) |
| 20 | [Office 交付](r5-20.md) | [复核](reviews/r5-20.md) |
| 21 | [记忆和学习授权](r5-21.md) | [代码与回归条目](r5-21.md#代码验收收口2026-11-16) |
| 22 | [日程](r5-22.md) | [复核](reviews/r5-22.md) |
| 23 | [主动准备](r5-23.md) | [复核](reviews/r5-23.md) |
| 24 | [监督与 Watchdog](r5-24.md) | [复核](reviews/r5-24.md) |
| 25 | [角色预设](r5-25.md) | [复核](reviews/r5-25.md) |
| 26 | [记忆导入](r5-26.md) | [复核](reviews/r5-26.md) |
| 27 | [浏览器资源导入](r5-27.md) | [复核](reviews/r5-27.md) |
| 28 | [凭据引用导入](r5-28.md) | [复核](reviews/r5-28.md) |
| 29 | [执行位置和配对](r5-29.md) | [复核](reviews/r5-29.md) |
| 30 | [设备停止对账](r5-30.md) | [复核](reviews/r5-30.md) |
| 31 | [安全交接](r5-31.md) | [复核](reviews/r5-31.md) |
| 32 | [认证客户端](r5-32.md) | [复核](reviews/r5-32.md) |
| 33 | [Host 替换](r5-33.md) | [复核](reviews/r5-33.md) |
| 34 | [移除旧架构](r5-34.md) | [复核](reviews/r5-34.md) |
| 35 | [独立安装](r5-35.md) | [复核](reviews/r5-35.md) |
| 36 | [升级和恢复](r5-36.md) | [复核](reviews/r5-36.md) |
