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

## 远端验收

本机记录覆盖解包构件。Windows 安装与覆盖更新、macOS arm64/x64、Linux AppImage/deb 和服务端全量测试以同一候选提交的远端工作流结果为准。真实模型及外部接入的验证暂缓。

### 首轮候选 `9cf61d272b7bff1b0543feeb451d9d8a94b3321f`

`full=true` 运行的 `headSha` 与候选一致。Ubuntu PTY、桌面 Profile、移动端类型检查和 Docker 通过。本轮未通过桌面包和全量测试门槛。[完整运行](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/44998347033)

- Windows x64 `0.2.5` 的安装器 SHA-256 为 `1147d4f8013b41e9c77e75475263a794e077fee3ef76962d3f5d2ec2654865dd`。共存探针在等待 Main 时超时，安装和更新步骤未执行。[Windows 桌面包](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/44998347033/job/137134237168#step:7:1)
- macOS `0.2.5` 的 arm64 和 x64 解包版均确认目录授权，随后等待界面回复超时。[macOS arm64](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/44998347033/job/137134237206#step:8:1) · [macOS x64](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/44998347033/job/137134237292#step:8:1)
- Linux x64 `0.2.5` 的 AppImage 确认目录授权后等待界面回复超时。AppImage SHA-256 为 `bc78b2fa775a03585595fba02ae35fafda18d95f04b57d171ae2cc3eb8ae694b`。deb 安装步骤未执行。[Linux 桌面包](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/44998347033/job/137134237242#step:9:1)
- 服务端分片 1 和 3 自然退出，共有四项失败，分别涉及远端验证命令、监督检查点、PostgreSQL 恢复和停止 Main 回复。客户端分片 2 和 4 的 bundle 测试未包含新增的 `workspaces` 注入。[分片 1](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/44998347033/job/137134237199#step:6:1) · [分片 3](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/44998347033/job/137134237194#step:6:1)
