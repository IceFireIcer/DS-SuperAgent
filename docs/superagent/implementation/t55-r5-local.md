# T55 R5 本机产品验收

2026-11-19。维护者取消外部托管、跨机 PostgreSQL/TLS/SSH、实体第二设备和跨机交接验收。#92 以范围取消关闭，其原生阻塞已解除。Windows、本机生命周期和已保留的真实信道验收由 #83 继续跟踪。真实飞书租户暂缓。[T55](../issues/T55.md) · [T58](../issues/T58.md)

## 固定流程

Windows 11 x64 `10.0.26200`，Node `24.22.3`，Electron `44.7.0`，DSH `0.2.1-rc.4`。先构建当前软件包，再运行原生窗口、领域和公开 Profile 检查。模型使用本机 mock，GitHub 组合测试使用合成来源事件。每阶段单测串行，默认单阶段上限 300 秒，窗口单阶段 540 秒。

```powershell
cd superagent
node dev/t55-acceptance.mjs --plan
node dev/t55-acceptance.mjs --app '../app/dist-pack/t55-51abf637/win-unpacked/DS SuperAgent.exe' --installer ../app/dist-pack/t55-next/DS-SuperAgent-0.2.6-win-x64.exe --upgrade-to '../app/dist-pack/t55-next/win-unpacked/DS SuperAgent.exe'
```

`0.2.5` 构件来自 `51abf637`。`0.2.6` 是包含观察分页修正的验收构件，版本覆盖只用于打包。固定流程基线为 `160d998b`，运行于北京时间 00:26:43–00:31:15。构件哈希、脚本输入、各阶段退出码和清理状态见 [运行 JSON](t55-r5-local-run.json)。

| 阶段 | 结果 | 证据范围 |
| --- | --- | --- |
| Windows 构件 | 通过，61.38 秒 | Electron 的 Main 输入、回复、关窗后 Host 常驻、再次启动唤回。新版冷启动保留逻辑 Main、两条历史消息、用量和关闭的日程授权，生成 16 条业务记录和 1 个 Session 的升级备份。 |
| 连续 | 11/11 | 一条请求的两项独立工作、定向跟进、原 Ticket 交付、GitHub 模拟来源和只读观察。 |
| 本地控制与高效 | 18/18 | 原 Ticket/Session 回答、失权或过期拒绝、Main 回复和工作停止、显式恢复、真本机作业、并发与槽位预算。 |
| 主动 | 16/16 | GitHub 准备规则、预算、语义提案、显式人工决定、独立 Watchdog 恢复本机故障进程。 |
| 持久 | 35/35 | Main 队列、Host epoch 和旧写者隔离、等待与停止、客户端游标补读和撤销、外部副作用原 ID 对账。 |
| 公开 Profile 恢复 | 通过，29.28 秒 | 真实 DSH 公开 Profile 执行两项本地文件和 shell 验证。恢复独立 SQLite 和 Session 后复核工作历史、人工 stop、角色设置和日程授权。 |
| 更新故障与诊断 | 10/10 | 真实隔离备份文件及桌面测试替身的安装启动失败、Host 重启和日志。 |

总计 90 个定向用例，两个进程 smoke 和构建通过。CLI 回归另有 2 项通过，POSIX 信号用例在 Windows 跳过。Node 24 typecheck、lint 和客户端生成检查通过。所有固定流程阶段的临时目录已清理。原生 app、模型夹具和 Host 已退出。原始日志与构件保存在本地忽略目录。四目标结论仍为 `not-accepted`。

## 发现与当前边界

- 初次连续阶段 6 通过、5 失败。四项 GitHub 测试缺少产品中 Main notice 和 relay 的 owner 映射。观察列表的排序与游标用两套 ID 比较规则，同时间记录可重复出现在下一页。`160d998b` 修复两处，定向 5/5。随后一次运行的 Windows 备份路径过长，缩短验收临时路径后重新跑通固定流程。[复核](reviews/t55-r5-local.md)
- 首次运行中，GitHub Outbox 对已经委托并完成的工作返回 `DESTINATION_SOURCE_DISABLED`。#129 修复后，产品 Host 在测试仓库 #21 实际发出结果，回读到原生评论 `6985981343`，核对评论作者、目标、正文匹配及本地回执。此轮模型为 mock。[实施记录](github-product-delivery.md) · [真实 GitHub 回执](https://github.com/IceFireIcer/SuperAgentTest/issues/21#issuecomment-6985981343)
- 真实模型缺授权配置，环境检查退出 2。真实飞书暂缓。原生休眠、关机以及完整的 Windows 主流程中问题卡与停止交互仍待组合验收。旧入口拒绝有公开 Profile 与产品协议的定向证据。

## Windows 原生安装和升级

从原生 NSIS 安装 `0.2.5` 到临时程序目录。打开真实窗口并建立两条消息，关闭日程来源，再正常退出。用 `0.2.6` 原生 NSIS 更新同一安装路径，打开同一隔离 Profile。新程序回读 Main `main-cc39dddb-dcad-4caa-aedf-11a0ec919dc8`、两条消息、2 个 Main token 和关闭的日程授权。应用生成可恢复的升级备份，包含 16 条业务记录和 1 个 Session。更新后的 `app.asar` 哈希与构件一致。检查退出 0，两个版本的进程均结束。卸载后确认临时注册、快捷方式和目录已清理。

```powershell
cd app
./scripts/check-t55-install.ps1 -PreviousInstaller './dist-pack/t55-51abf637/DS-SuperAgent-0.2.5-win-x64.exe' -NextInstaller './dist-pack/t55-next/DS-SuperAgent-0.2.6-win-x64.exe' -NextAppAsar './dist-pack/t55-next/win-unpacked/resources/app.asar'
```

初次第二个安装器在 120 秒时超时。卸载清除了注册与快捷方式，残留临时构件已移入回收站。正式复跑使用 NSIS 的更新参数与 300 秒上限。自动更新器的下载和异步启动错误仍使用定向替身证据。新版原生数据保留与真实 Profile 备份还原的两条轨迹均已验证。

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
