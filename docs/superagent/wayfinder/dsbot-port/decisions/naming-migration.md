# 敲定命名、存储键与桥名的迁移边界：待决问题

对应决策：[敲定命名、存储键与桥名的迁移边界](https://github.com/IceFireIcer/DS-SuperAgent/issues/138)。

## 问题

敲定命名与存储迁移细节：CSS 设计 token `--bt-*` / 类前缀 `.bt-*`（426 个）是否改 `sa-*`；`ds-bot:*` storage key 的一次性迁移窗口与旧键删除时机；`DS_BOT_SECRETS_PASSPHRASE_FILE` 兼容多久；`window.dshDesktop` → `dsSuperagentDesktop` 是否保留别名；NOTICE 与 `provenance:` 注释白名单的边界。

## 约束与已知依据

- 只改复制进 `superagent/` 的代码，`temp\DS-Bot` 原样。
- 已定必须改名：品牌文案、插件 id、i18n namespace、全局对象、dataset、日志前缀、下载名。
- 默认保留 `.bt-*` 以维持上游可 diff；若决定改名，由 `sync-client.mjs` 做一次性 codemod。
- P7 验收门：`rg -i "ds[-_ ]?bot|dsbot|dshBot|dsBotApp|DS_BOT"` 命中数为 0（NOTICE/来源注释白名单除外）。

## 产出

最终映射表、迁移窗口、白名单规则、检查命令与预期结果。
