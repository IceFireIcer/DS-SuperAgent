# 升级 DSH 到官方 0.2.2-rc.1：待决问题

对应决策：[升级 DSH 到官方 0.2.2-rc.1 并记录验证事实](https://github.com/IceFireIcer/DS-SuperAgent/issues/132)。

## 问题

把 `superagent/` 的 DSH 依赖从官方 registry 直接升级到 `latest`（`0.2.2-rc.1`，与 `app/` 一致），重装 `node_modules`，跑通 `build`、`typecheck`、`lint`、`test` 与 profile boot。哪些 `@deepseek-ai/*` 包必须同步、哪些客户端 slot 与运行时行为需要复验、失败时如何回滚？

## 约束与已知依据

- 官方 `dist-tags.latest` 为 `0.2.2-rc.1`（`next` 为 `0.2.2-rc.5`，本图不采用）。
- `0.2.1-rc.4` 缺三个客户端 slot：`conversation.chat.text-interaction`、`conversation.user.before`、`settings.section.icon`；签名变化 0。
- 一次升完全部 `@deepseek-ai/*`，不做部分升级；`app/` 已固定 `0.2.2-rc.1`。
- 不改 DSH 安装、不依赖内部文件；升级后必须重新生成 `client.js`。

## 产出

版本矩阵、实际安装结果、检查命令与结果、必须修的源码点、回滚步骤。只做升级与验证，不改产品 UI。
