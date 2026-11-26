# 确定 roster 与团队/群聊页的语义映射：待决问题

对应决策：[确定 roster 与团队/群聊页的语义映射](https://github.com/IceFireIcer/DS-SuperAgent/issues/135)。

## 问题

定义 roster 与团队/群聊页的语义：首版用“合成的 Main/Router/Worker 三角色”还是“真实 DSH Session 列表”驱动侧栏与成员视图？Bot、Bot 模型、群聊、成员状态、任务板各自显示什么数据，哪些动作明确 fail-closed？合成 roster 与 SuperAgent 的 Ticket/Assignment 数据如何对应？

## 约束与已知依据

- 不新增 `/api/bot`，所有数据来自 `/api/product` 或客户端本地投影。
- 页面保留，未接线动作 fail-closed，不能删页。
- DS-Bot 的 42 个团队/群聊/会话端点是 C 类最大域（≈85 改造点）。
- 依赖“原型验证会话根、cell 渲染与 MainComposer 接管”的结论。

## 产出

roster 形状、页面字段来源、动作可用性表、fail-closed 文案与空态规则。
