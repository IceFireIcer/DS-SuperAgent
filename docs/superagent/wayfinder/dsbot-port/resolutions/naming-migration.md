# 敲定命名、存储键与桥名的迁移边界：决定

对应决策：[敲定命名、存储键与桥名的迁移边界](https://github.com/IceFireIcer/DS-SuperAgent/issues/138#issuecomment-7001732375)。

## 结论

1. 保留 CSS 设计前缀 `--bt-*` 与 `.bt-*`（426 个）；只改用户可见名称与含 `ds-bot` 的标识符。
2. 新代码只用 `ds-superagent:*` 键；**不迁移、不读取、不删除** `ds-bot:*`，避免与用户机器上的 DS-Bot 共用 origin storage 时互相覆盖。
3. 旧环境变量不兼容，只认 `DS_SUPERAGENT_SECRETS_PASSPHRASE_FILE`。
4. 全局桥名直接改、不留别名：`dshDesktop` → `dsSuperagentDesktop`，`dsBotApp` → `dsSuperagentApp`，`dshBot`/`dshBotQueue` → `dshSuperagent`/`dshSuperagentQueue`。
5. 允许 `NOTICE` 与文件顶部一行 `Derived from DS Bot 0.3.8 (Apache-2.0)`；其余一律改名。
6. 检查门：`rg -i "ds[-_ ]?bot|dsbot|dshBot|dsBotApp|DS_BOT"` 在 `superagent/dsh/src`、`superagent/src`、`app/src` 为 0，白名单仅上述两类。

## 边界

- `temp\DS-Bot` 原样不动。
- 不触碰用户已安装的 DS-Bot 数据与设置。
