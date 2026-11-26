# 原型验证会话根、cell 渲染与 MainComposer 接管：待决问题

对应决策：[原型验证会话根、cell 渲染与 MainComposer 接管](https://github.com/IceFireIcer/DS-SuperAgent/issues/133)。

## 问题

在 DSH `0.2.2-rc.1` 上，用一次性原型验证：删掉 SuperAgent 对 `main.conversation` 的 shadow 后，DSH 会话根 + DS-Bot 的 cell/turnTail 能否正常渲染；`MainComposer` 能否通过 `conversation.composer` 的 select 条件安全接管，且不与 DS-Bot 问题卡双接管。Main 的转录源选 DSH Session 还是 product `history`；工作卡如何按 `mainMessageId` 挂到 turnTail。

## 约束与已知依据

- DS-Bot 不注册 `main.conversation`；当前 SuperAgent 整体 shadow 它，是 cell 不显示的根因。
- `conversation.composer` 是链式槽位；DS-Bot 在 `pendingInteraction.kind === 'question'` 时接管。
- Main 发送必须经过产品 `send` 的持久化队列，不能绕到 DSH 原生 composer。
- 工作卡/来源卡/准备卡不得替换工具卡，只挂 `turnTail`。

## 产出

可构建的最小接线、截图或运行记录、两种转录源的对比结论、已发现的 slot 冲突与回退点。
