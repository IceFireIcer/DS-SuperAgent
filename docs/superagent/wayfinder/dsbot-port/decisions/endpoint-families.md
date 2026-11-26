# 设计 C 类 product endpoint 族边界与首批样板：待决问题

对应决策：[设计 C 类 product endpoint 族边界与首批样板](https://github.com/IceFireIcer/DS-SuperAgent/issues/140)。

## 问题

设计 C 类端点族的边界：98 个上游调用如何收敛成 50 个 product endpoint 族（含 `computer-*` 3 族）；每族的 endpoint 名、payload、返回形状、读模型来源、存储表、`instanceId`/鉴权与 fail-closed 行为是什么；先做哪 3 族作为样板。避免 98 个独立分支，也避免把上游 endpoint 名带进 HTTP 层。

## 约束与已知依据

- 只走 `ProductHost.dispatch`，不新增路由、错误信封或远程白名单分支。
- 复用 `SOURCE_NOT_AUTHORIZED`、`INVALID_INPUT`、`UNAVAILABLE`；身份来自 `open()` binding，不接受客户端自报 `instanceId`。
- 最大域：团队/群聊/会话 42 个上游端点、18 族、≈85 点。
- 依赖“首版与全量 C 域范围”的结论。

## 产出

50 族的边界表（含合并理由）、每族的 endpoint 契约、首批 3 族样板、fail-closed 矩阵。
