# 原型验证会话根、cell 渲染与 MainComposer 接管：决定

对应决策：[原型验证会话根、cell 渲染与 MainComposer 接管](https://github.com/IceFireIcer/DS-SuperAgent/issues/133#issuecomment-7002480619)。

## 结论

1. 删除 SuperAgent 对 `main.conversation` 的整页 shadow，保留 DSH 会话根。
2. Main 转录源采用 DSH Session；product `history` 只提供工作卡/来源卡/准备卡投影。
3. `MainComposer` 注册到 `conversation.composer`，`select` 条件为 Main Session 且无 pendingInteraction；DS-Bot 问题卡在 question 时接管，二者互斥。
4. 工作卡/来源卡/准备卡挂 `conversation.chat.turnTail`，按 `mainMessageId` 关联。
5. 观察页注册为 `conversation.view` 的 Activity 视图。
6. 运行原型未执行；Main 发送、停止、重连补读、无重复 composer、卡片关联转实施验收门。
