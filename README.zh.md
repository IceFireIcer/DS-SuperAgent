<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo.svg" alt="DS SuperAgent" width="260">
  </picture>
</p>

# DS SuperAgent

[English](README.md) | 中文

![版本](https://img.shields.io/badge/版本-R5_预览-blue) ![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.4-4D6BFE) ![许可](https://img.shields.io/badge/许可-Apache_2.0-green)

DS SuperAgent 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的三层 Agent
产品。一个 **Main** 留在主对话中并拥有用户意图；**Router** 把已接受工作转成持久 Ticket；独立 **Worker**
执行这些 Ticket 并提交可核验结果。现有 DS Bot 界面现在展示这套产品。

## 产品行为

- Main 在同一主对话内处理聊天、跟进、问题、停止/恢复和最终结果。
- Router、Worker Session 可自动查看但保持只读，不能成为绕过 Main 的写入入口。
- 工作跨 Host 重启和客户端重连保留 Ticket、Assignment、Session 与交付历史。
- 文件、Office、浏览器资源、记忆、MCP、凭据、日程、主动准备和监督通过明确的产品命令接入，不再启动旧 Bot
  团队运行时。
- 执行目标可为本机 Host 或已配对远端设备；选择使用明确的候选能力探测，不会在两类执行世界之间静默回退。
- 桌面应用只使用一个 `ds-superagent` DSH profile、自己的数据目录和现有 DSH Web 前端，不写用户的 `~/.dsh`。

## 启动桌面应用

各平台安装包由 [`app/`](app/README.md) 构建。Windows 源码启动：

```powershell
.\start.ps1
```

首次启动会询问数据目录和工作区，然后打开现有 DSH 界面。发送工作前先在 DSH 设置中配置模型。应用把产品数据
放在自己的数据目录，不迁移或改写旧 DS Bot、DSH 文件。

## 从当前仓库运行

使用 Node.js 24。应用从本仓库安装 `ds-bot` 与 `ds-superagent`：

```powershell
npm --prefix app ci
npm --prefix app start
```

不使用 Electron 外壳时，可在 DSH profile 中把两个包目录作为 linked dependency，并列出
`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`ds-bot` 和 `ds-superagent` bundles。详见
[`ds-bot/README.md`](ds-bot/README.md) 与 [`superagent/README.md`](superagent/README.md)。

## 验证

仓库按改动范围执行定向检查：

```powershell
npm --prefix ds-bot run build
node ds-bot/scripts/build-client.mjs --check
npm --prefix ds-bot run lint
npm --prefix superagent run typecheck
npm --prefix superagent run build
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
| `ds-bot/` | 现有客户端 UI、`/api/product` 桥、Office 工具和 Web 搜索 provider |
| `superagent/` | Engine、持久业务库、Host、执行适配器和公开产品命令 |
| `app/` | Electron 外壳、单一产品 profile、数据隔离、进程生命周期与打包 |
| `docs/superagent/` | R5 规格、实施记录与环境证据 |

R5-34 已删除旧 roster、群/round、Bot 互派、团队治理、原生历史写入口、activation/reversal 与双 profile
兼容路径。仓库不再附带第二个 renderer 或独立 app engine。

## 许可

[Apache-2.0](LICENSE)
