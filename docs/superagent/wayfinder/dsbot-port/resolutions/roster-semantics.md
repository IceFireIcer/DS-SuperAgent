# 确定成员状态与任务板的语义映射：决定

对应决策：[确定成员状态与任务板的语义映射](https://github.com/IceFireIcer/DS-SuperAgent/issues/135#issuecomment-7002590271)。

## 结论

1. 成员：Main 与 Router 固定；Worker 按活跃 Worker Session 动态出现，有多少个活跃 Session 显示多少个；空闲 Worker 不显示。
2. 任务板：所有 Work Items，按状态分组、可筛选；默认“进行中 / 等待人工 / 阻塞 / 已完成 / 已停止”。
3. 状态映射：
   - `active → running`
   - `review → waiting-delivery`
   - `blocked → waiting-human / unknown`
   - `done → delivered`
   - `cancelled → stopped`
   - `progress/result/reason → Report / Delivery / Stop` 事实。
4. 动作：取消 → `work-stop`（二次确认）；备注 → 用户跟进消息；无 endpoint 时明确 fail-closed。
5. 放置：成员状态在 Main composer 上方 dock；任务板是 `conversation.view` 的 “Work” 视图，与 Activity 并列。
6. 数据：首版客户端组合 `history`、`observe-list`、`product-status`、`evidence`；不新增 roster 读模型；必要时再补 `work-board` endpoint。

## 验收门

- 成员数量与活跃 Worker Session 一致，Main/Router 始终存在。
- 从成员 dock 停止工作会停止对应 Work Item。
- 任务板状态与 Work Item 事实一致，刷新不丢失。
- 备注无 endpoint 时显示明确错误，不伪造成功。
