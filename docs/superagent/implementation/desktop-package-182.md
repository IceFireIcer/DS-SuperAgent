# 桌面候选包验收（#182）

桌面包探针从 Git 读取候选提交中的客户端，核对包内客户端 SHA-256，并记录应用版本、平台、架构和构件指纹。Main 收发在隔离 Profile 和 mock 模型中进行。按 Enter 前确认获准的本机工作目录、可编辑输入区、焦点、草稿和可用的发送按钮。诊断记录模拟模型是否收到夹具输入、产品历史中的状态以及原生历史是否可见。

Windows 安装版从本地更新源下载下一版。探针等当前进程自然退出，再检查当前用户安装登记、安装进程退出和新版 `app.asar` 指纹。重新打开应用时复用原隔离 Profile，检查 Main 界面中的原回复和可用输入区，再核对原会话、消息内容、定时任务设置、用量和可还原备份。应用主动退出时安装更新并保持关闭，用户选择立即重启时由安装器重开应用。

Windows 视觉探针覆盖 580 和 1120 像素视口、四套主题及浅深模式。目录和账户菜单抽验焦点环、布局边界、方向键、逐层 `Esc` 和外部点击。代表性组合检查模型设置、拒绝录音后的暂停提示、Main 与 Router 就绪状态，以及 Work 空态。深色组合模拟系统减少动态效果。账户菜单用 `Tab` 移到连接器。工作控制探针检查窄窗下问题卡可见且可用键盘切换，分别验证原 Assignment 的问答、停止 Main 回复和停止选定 Ticket。

启动探针在隔离目录中模拟被占用的数据锁，在普通动效和减少动态效果下验证错误反馈、`Tab` 焦点顺序、重试加载和交接到可立即输入的原 Main 窗口。两轮都收取 mock 回复并验证应用正常退出。

## 本地验证

- `3c270ed0` 的客户端入包后，Windows x64 `0.2.5` 解包构件通过 `--coexistence`、16 组视觉探针及 `--controls`，均自然退出，退出码为 0。构件 `app.asar` 的 SHA-256 为 `b17b569f8a52c29e4f6e698662ac3361dd3cf0b35aaa5885b794aa0c66cb8296`。
- 在同一 Windows 解包构件复跑扩展视觉探针，16 组生成 29 张截图，应用自然退出，退出码为 0。
- Windows x64 `0.2.5` 本机解包构件实测两种动效下的启动重试，以及窄窗问题卡的焦点与工作控制。应用自然退出，退出码为 0。
- Node `24.22.3` 下，桌面测试 255 项通过、1 项跳过，进程正常退出。
- 含 #181 导航修正的 Windows x64 `0.2.5` 构件复跑 16 组视觉检查和工作控制。通过 Enter 打开模型页、选择并提交问题答案，验证停止 Main 回复与停止选定工作。`app.asar` SHA-256 为 `8c5e955de59f6055fefc838533e56b500ed4c3c0eedfc26a3570fe6a2c10fa7b`，应用退出码为 `0`。61 项定向打包与更新测试通过。
- 使用 `--upgrade-to` 让 Windows x64 `0.2.5` 和 `0.2.6` 解包构件先后使用同一个隔离 Profile。新版 Main 显示原回复与可用输入区。`Usage` 页显示原 Main Token 用量，`Status` 页显示新版版本号与 `HOST_READY` 诊断。两个进程均自然退出，退出码为 `0`。
- Windows Node `24.22.3` 下复跑 8 项服务端定向测试，覆盖远端进程收尾、Main 停止、监督检查点和 PostgreSQL 恢复，测试进程自然退出。远端验证的 Windows 夹具给进程表采集留出 2 秒，仍要求进程范围已静止和退出码为 `0`。单独的截止时间和取消探针继续检查后代进程回收。

## 远端验收

本机记录覆盖解包构件。Windows 安装与覆盖更新、macOS arm64/x64、Linux AppImage/deb 和服务端全量测试以同一候选提交的远端工作流结果为准。真实模型及外部接入的验证暂缓。

### 首轮候选 `9cf61d272b7bff1b0543feeb451d9d8a94b3321f`

`full=true` 运行的 `headSha` 与候选一致。Ubuntu PTY、桌面 Profile、移动端类型检查和 Docker 通过。本轮未通过桌面包和全量测试门槛。[完整运行](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/44998347033)

- Windows x64 `0.2.5` 的安装器 SHA-256 为 `1147d4f8013b41e9c77e75475263a794e077fee3ef76962d3f5d2ec2654865dd`。共存探针在等待 Main 时超时，安装和更新步骤未执行。[Windows 桌面包](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/44998347033/job/137134237168#step:7:1)
- macOS `0.2.5` 的 arm64 和 x64 解包版均确认目录授权，随后等待界面回复超时。[macOS arm64](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/44998347033/job/137134237206#step:8:1) · [macOS x64](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/44998347033/job/137134237292#step:8:1)
- Linux x64 `0.2.5` 的 AppImage 确认目录授权后等待界面回复超时。AppImage SHA-256 为 `bc78b2fa775a03585595fba02ae35fafda18d95f04b57d171ae2cc3eb8ae694b`。deb 安装步骤未执行。[Linux 桌面包](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/44998347033/job/137134237242#step:9:1)
- 服务端分片 1 和 3 自然退出，共有四项失败，分别涉及远端验证命令、监督检查点、PostgreSQL 恢复和停止 Main 回复。客户端分片 2 和 4 的 bundle 测试未包含新增的 `workspaces` 注入。[分片 1](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/44998347033/job/137134237199#step:6:1) · [分片 3](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/44998347033/job/137134237194#step:6:1)

### 桌面定向候选 `7bebe150e1109024711bcd1657947e87e697b089`

- macOS arm64 和 x64 的 ZIP 安装、Main 收发、更新提示和正常退出均通过。[arm64](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/45000477473/job/137140726440#step:9:1) · [x64](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/45000477473/job/137140726425#step:9:1)
- Windows x64 通过新装、视觉检查、启动重试、工作控制和 `0.2.6` 下载。旧进程以 `0` 退出，覆盖安装后的 `app.asar` SHA-256 匹配下一版构件 `d0dc239cf4a07d608970513e787128625c02c6a4d1163165b2a78cc4992ae66f`，重开后原回复与备份保留。设置探针仍查找旧的合并入口，故整项更新检查失败。探针已改用 `Usage` 和 `Status` 两个实际标签页。[Windows 更新](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/45000477473/job/137140726391#step:14:1)
- Linux AppImage 的 mock 回复已显示，产品历史中的输入与回复为 `completed`。探针把 DSH 文件管理器图标的预期 404 视为错误并提前退出。Linux 的 `xdg-open` 项会显示通用图标，探针据此仅调整这一条回退记录。[Linux 收发](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/45000477473/job/137140726389#step:9:1) · [图标回退说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/host/open-in-app/README.md#application-catalog)

### 全量候选 `898630edb689a7a37d941565af791a3f84b63587`

`full=true` 的 `headSha` 与候选一致。四个桌面包任务通过，原版和新版应用探针均记录退出码 `0`。服务端分片 1 至 3 分别在远端验证结算、MCP 夹具 SQLite 锁和 PostgreSQL 等待任务恢复处失败，整体未通过。[全量运行](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/45002104539) · [汇总检查](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/45002104539/job/137148748046)

| 构件 | SHA-256 | 通过项 |
| --- | --- | --- |
| Windows x64 `0.2.5` 安装器 | `06e1149140ed3df10241a1d8cae03fd1f45177c8f13e5e9d3842985f50f93648` | [共存与 16 组视觉](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/45002104539/job/137145733313#step:7:1)、[启动交接](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/45002104539/job/137145733313#step:8:1)、[工作控制](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/45002104539/job/137145733313#step:9:1)、[新装](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/45002104539/job/137145733313#step:12:1) |
| Windows x64 `0.2.6` 安装后 `app.asar` | `d0dc239cf4a07d608970513e787128625c02c6a4d1163165b2a78cc4992ae66f` | [下载、旧进程自然退出、覆盖安装、重开与数据保留](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/45002104539/job/137145733313#step:14:1) |
| macOS arm64 `0.2.5` ZIP | `ddc7a8afc9dff932588a19b6b9bc328221a6cd295e7fe7953fa9499b6afa2681` | [安装、Main 收发及更新提示](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/45002104539/job/137145733338#step:9:1) |
| macOS x64 `0.2.5` ZIP | `83b6903bdb5f2cfd285813f21ba22a7d28823372c6bcc6966f1dd024635fb59a` | [安装、Main 收发及更新提示](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/45002104539/job/137145733290#step:9:1) |
| Linux x64 `0.2.5` AppImage | `713e497fa2c844b23116d7e8b80f494dfa5c21fcf7b78f76130a5b42e3ab2001` | [目录授权及 Main 收发](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/45002104539/job/137145733387#step:9:1) |
| Linux amd64 `0.2.5` deb | `669d7121096d4ed96ceeebfd78b98359840cc3c8eaba166e4223876b4f4c5fe0` | [安装、目录授权及 Main 收发](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/45002104539/job/137145733387#step:10:1) |

Windows 视觉归档的 SHA-256 为 `9410e0877c1ef367f94986e3ac6ff93f4d64adfb7b226780e4d9e28c2f69e419`。[视觉归档](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/45002104539/artifacts/14746092538)

MCP 测试改用一个只读 SQLite 连接检查持久记录，避免测试的读取操作申请写锁。Windows Node `24.22.3` 下原用例通过，进程自然退出。[MCP 夹具](../../../superagent/test/worker-mcp-credential.test.mjs) · [原分片失败](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/45002104539/job/137145733342#step:6:1)

PostgreSQL 恢复夹具固定在旧 Host 持有首轮 Worker 投递租约时中断。等待预算覆盖实际租约到期以及后续执行。回归验证三个原 Session、答复只写入原 Worker Session 一次、可验证结果回到原 Main，并要求替换 Host 和测试进程以 `0` 自然退出。Windows Node `24.22.3` 下定向用例通过。[PostgreSQL 恢复夹具](../../../superagent/test/hosted-product-postgres.test.mjs) · [远端定向恢复](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/45007533861/job/137162387191#step:5:1)

远端前台命令在既有总期限内等待设备确认进程范围静止。Windows 用一次查询核实 PID、父 PID 和创建时间。定向回归确认根进程退出后仍等待存活后代、调用方取消后回收原进程范围，以及故意让首轮 Windows 查询超时后仍能获得真实的结算证据。6 项定向测试自然退出。[远端命令夹具](../../../superagent/test/remote-command.test.mjs) · [原分片失败](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/45002104539/job/137145733320#step:6:1)
