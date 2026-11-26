# 确定远程客户端执行写命令与设备操控的授权边界：待决问题

对应决策：[确定远程客户端执行写命令与设备操控的授权边界](https://github.com/IceFireIcer/DS-SuperAgent/issues/141)。

## 问题

远程客户端现在被允许调用全部 C 族，包括写命令、OAuth、浏览器接管与电脑操控。需要定清楚：远程客户端凭据如何分权（只读/写/设备操控）、危险动作是否需要二次确认、如何审计与撤销、OAuth 回调与密钥如何在 Host 侧闭环、以及哪些动作即使远程也不允许。

## 约束与已知依据

- C 族统一 `scope: { role, workItemId? }`，不使用 `botId`。
- OAuth state/PKCE、密钥与审计留在 Host；远程客户端必须可单独撤销。
- browser/computer 依赖受信 app bridge；纯 HTTP 远程没有 bridge 时 fail-closed。
- 现有远程白名单只有 23 个 endpoint，本次需要重写 `app/src/remote-product-client.mjs` 与 Host 的远程授权判断。
