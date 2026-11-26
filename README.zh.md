<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo.svg" alt="DS SuperAgent" width="260">
  </picture>
</p>

# DS SuperAgent

[English](README.md) | 中文

作者与维护者：[IceFireIcer](https://github.com/IceFireIcer)。

![版本](https://img.shields.io/badge/版本-R5_预览-blue) ![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-4D6BFE) ![许可](https://img.shields.io/badge/许可-Apache_2.0-green)

DS SuperAgent 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的三层 Agent
产品。一个 **Main** 留在主对话中并拥有用户意图；**Router** 把已接受工作转成持久 Ticket；独立 **Worker**
执行这些 Ticket 并提交可核验结果。产品直接使用 DSH 现有客户端界面。

## 产品行为

- Main 在同一主对话内处理聊天、跟进、问题、停止/恢复和最终结果。
- Router、Worker Session 可自动查看但保持只读，不能成为绕过 Main 的写入入口。
- 工作跨 Host 重启和客户端重连保留 Ticket、Assignment、Session 与交付历史。
- 文件、Office、浏览器资源、记忆、MCP、凭据、日程、主动准备和监督通过明确的产品命令接入。
- 执行目标可为本机 Host 或已配对远端设备；选择使用明确的候选能力探测，不会在两类执行世界之间静默回退。
- 桌面应用只使用一个 `ds-superagent` DSH profile、自己的数据目录和现有 DSH Web 前端，不写用户的 `~/.dsh`。

## 连接手机

[Expo 手机端](mobile/README.md)通过加密中继连接 Main。默认配对只能查看；发送消息需要在电脑上显式授权。
手机端不能管理桌面操控、凭据或文件。目前从源码构建，未提供应用商店版本。

## 启动桌面应用

[桌面安装包](app/README.md)在 Windows、macOS 和 Linux 上安装 **DS SuperAgent**。Windows 也可以从源码启动：

```powershell
.\start.ps1
```

首次启动只询问数据目录（默认 `~/.ds-superagent`），随后打开 Main，不创建项目或工作文件夹。
委托工作前，请先创建项目并选择文件夹；在此之前 Router 和 Worker 保持空闲。在设置中配置服务商凭据，并为
Main、Router 和 Worker 选择模型。桌面版可独立使用，拥有自己的浏览器存储键和数据目录。旧版产品资料和个人 DSH 文件保留在原处。

桌面版发布要求见[发版清单](docs/dev/release-checklist.md)，Windows 验收进度见
[桌面迁移记录](docs/superagent/implementation/dsbot-port-162-164.md)。

## 从当前仓库运行

使用 Node.js 24 系列的 24.9 或更新版本。应用从本仓库安装唯一的 `ds-superagent` 产品包：

```powershell
npm --prefix superagent ci
npm --prefix superagent run build
npm --prefix app ci
npm --prefix app start
```

不使用 Electron 外壳时，可在 DSH profile 中链接 [`superagent/`](superagent/README.md)，并列出
`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 和 `ds-superagent` bundles。

## 验证

仓库按改动范围执行定向检查：

```powershell
npm --prefix superagent run typecheck
npm --prefix superagent run build
npm --prefix superagent run test:client
npm --prefix superagent run lint
npm --prefix app test
```

产品 profile 检查使用临时数据启动真实包装配：

```powershell
node app/scripts/check-superagent-profile.mjs
```

真实模型、飞书租户、第二设备、托管 PostgreSQL 与完整四目标验收仍是独立环境门槛。Mock UI 或单测结果不能替代
这些检查。

## 仓库结构

| 目录 | 作用 |
|---|---|
| `superagent/` | 唯一的 DSH 包：Engine、持久业务库、Host、产品 HTTP 桥、现有客户端 UI、Office 工具和 Web 搜索 provider |
| `app/` | Electron 外壳、单一产品 profile、数据隔离、进程生命周期与打包 |
| `mobile/` | Expo 手机端：配对、Main 对话和只读工作状态 |
| `docs/superagent/` | R5 规格、实施记录与环境证据 |

R5-34 已删除旧 roster、群/round、Agent 互派、团队治理、原生历史写入口、activation/reversal 与双 profile
路径。原有客户端、Office 和 Web 搜索能力现位于 `ds-superagent` 的 `dsh/`；仓库不再附带第二个 renderer、独立 app engine 或额外
DSH 插件。

## 许可

[Apache-2.0](LICENSE)
