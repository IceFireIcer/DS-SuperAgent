<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo.svg" alt="DS SuperAgent" width="260">
  </picture>
</p>

# DS SuperAgent

[English](README.md) | 中文

![版本](https://img.shields.io/badge/版本-v1.0.1-blue) ![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-4D6BFE) ![许可](https://img.shields.io/badge/许可-Apache_2.0-green)

DS SuperAgent 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的桌面 Agent。
你只和一个助手对话。交给它一件真正要做的事，它会把任务记成工单、交给执行者，再把核验过的结果带回同一个对话。
任务在重启后依然保留，每一步都看得到。

## 赞助

<table>
<tr>
<td width="180" align="center"><a href="https://git.hhapi.top/register?aff=5Y7LG3DT4UHM"><img src="docs/images/sponsors/xgit.png" alt="XGit" width="120"></a></td>
<td>XGit 是一个 AI API 网关。注册即送 0.5 元额度，电信、联通、移动三网优化，充值一比一到账。<br>立即注册：<a href="https://git.hhapi.top/register?aff=5Y7LG3DT4UHM">XGit</a></td>
</tr>
</table>

## 工作方式

| 层 | 职责 |
|---|---|
| **Main** | 和你对话：回答问题、接下任务、需要你决定时提问、最后汇报结果。 |
| **Router** | 把接下的任务变成持久工单并分派出去。 |
| **Worker** | 在独立会话里执行工单，连同证据一起提交结果。 |

Main、Router、Worker 是三个独立的 DSH 会话，可以各用各的模型。你只向 Main 发消息；Router 和 Worker
的会话可以查看，但只读。工单、分派、提问和交付历史都存在磁盘上，重启或重连后从中断处继续。

Worker 可以使用文件、Office 文档、浏览器、记忆、MCP 工具、已保存的凭据和日程。任务在本机或已配对的远端设备上运行，
产品不会在你不知情的情况下切换执行位置。

## 安装

### 桌面应用（Windows、macOS、Linux）

桌面应用自带 DSH，无需先装 DSH。从 [Releases](https://github.com/IceFireIcer/DS-SuperAgent/releases/latest)
下载对应系统的文件：

| 系统 | 文件 |
|---|---|
| Windows x64 | `DS-SuperAgent-<版本>-win-x64.exe` |
| macOS Apple 芯片 | `DS-SuperAgent-<版本>-mac-arm64.zip` |
| macOS Intel | `DS-SuperAgent-<版本>-mac-x64.zip` |
| Linux x64 | `.AppImage` 或 `.deb` |

如果系统提示应用未签名：Windows 上点 **更多信息** → **仍要运行**；macOS 上打开 **系统设置** →
**隐私与安全性**，点 **仍要打开**。

### 首次启动

1. 选择数据目录，默认是 `~/.ds-superagent`。
2. 打开 **设置** → **模型**，添加服务商和 API Key，再为 Main、Router、Worker 选择模型。
3. 现在就可以和 Main 聊天。要交付任务，先创建项目并选择文件夹；没有项目时 Router 和 Worker 保持空闲。

应用的所有数据都放在自己的目录里，不会写入你个人的 `~/.dsh`，旧版安装留下的数据也保持原样。

### Docker（NAS、Linux 服务器）

见 [`docker/README.md`](docker/README.md)。

## 连接手机

[Expo 手机端](mobile/README.md)通过端到端加密中继连接 Main。新配对的设备只能查看；发消息需要在电脑上明确授权。
手机端不能修改桌面设置、凭据或文件。目前没有应用商店版本，需要从源码构建。

## 从源码运行

需要 Node.js 24 系列的 24.9 或更新版本。

```powershell
npm --prefix superagent ci
npm --prefix superagent run build
npm --prefix app ci
npm --prefix app start
```

Windows 上可以直接运行 `.\start.ps1`，效果相同。详细说明、环境变量和打包方式见 [`app/README.md`](app/README.md)。

不使用桌面应用、想在自己的 DSH profile 中使用时，链接 [`superagent/`](superagent/README.md)，并把
`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 和 `ds-superagent` 列为 profile bundles。

## 开发

按改动的包运行检查：

```powershell
npm --prefix superagent run typecheck
npm --prefix superagent run build
npm --prefix superagent test
npm --prefix superagent run lint
npm --prefix app test
node app/scripts/check-superagent-profile.mjs   # 用临时数据启动真实 profile
```

测试使用 `superagent/dsh/dev/mock-llm.mjs` 中的模拟模型，不需要 API Key。提交 Pull Request 前请阅读
[CONTRIBUTING.md](CONTRIBUTING.md)，产品方向见 [docs/vision.zh.md](docs/vision.zh.md)。

| 目录 | 内容 |
|---|---|
| `superagent/` | `ds-superagent` DSH 包：Engine、Host、持久化、客户端界面、Office 工具和 Web 搜索 |
| `app/` | Electron 桌面应用：产品 profile、数据隔离、生命周期和打包 |
| `mobile/` | Expo 手机端 |
| `docker/` | 面向 NAS 和服务器的 Docker 镜像 |
| `docs/` | 愿景、设计、规格和发版记录 |

## 免责声明

DS SuperAgent 是独立的社区项目，**不是 DeepSeek 官方产品**，与 DeepSeek 没有隶属、认可或赞助关系。
“DeepSeek”“DeepSeek Harness”是各自所有者的商标。

## 许可

[Apache-2.0](LICENSE)。作者与维护者：[IceFireIcer](https://github.com/IceFireIcer)。
