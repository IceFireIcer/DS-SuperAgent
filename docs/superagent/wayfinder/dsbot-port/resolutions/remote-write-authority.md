# 确定远程客户端执行写命令与设备操控的授权边界：决定

对应决策：[确定远程客户端执行写命令与设备操控的授权边界](https://github.com/IceFireIcer/DS-SuperAgent/issues/141#issuecomment-7001910604)。

## 结论

1. 授权三档：`read` / `command` / `device`；新客户端默认只有 `read`，`command` 与 `device` 逐客户端、逐 Instance 授予。
2. 危险动作需 Host 本机确认：browser 接管、computer 操控、OAuth 授权；普通写命令不额外确认；密钥永不返回远程。
3. 只追加审计：clientId、instanceId、endpoint、scope、commandId、结果、时间；保留 90 天或最近 1 万条；参数脱敏，不记录密钥、页面内容或截图。
4. OAuth 回调仅在 Host 本机闭环；state/PKCE 只存 Host；远程只拿 `loginId` 与 pending 状态。
5. 撤销立即阻断新命令；在途写/设备动作尽力 cancel/stop，不回滚；文件选择器、数据目录搬移、应用更新/安装、凭据导入永久仅本机。

## 实现约束（后续规格）

- `app/src/remote-product-client.mjs` 扩展 `READS`/`COMMANDS`，新增 `DEVICE` 集合与 `device` 能力检查。
- `product-host.ts` 远程授权按三档重写；缺对应 scope 返回 `SOURCE_NOT_AUTHORIZED`。
- 客户端签发/撤销界面支持选择三档能力。
- 审计失败不阻断命令，但必须记录失败原因。
