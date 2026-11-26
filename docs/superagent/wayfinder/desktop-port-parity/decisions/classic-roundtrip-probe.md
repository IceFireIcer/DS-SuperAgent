## Question

若第一方证据给出可尝试的公开路径，能否在 throwaway profile、模拟模型和隔离数据下，验证「从当前桌面窗口进入获准的 DSH 原生会话，再回到同一 Main」的行为和权限边界？

记录进出及取消后 Main 身份、输入是否被重发、原 Ticket 和在途工作是否受影响，确认经典模式不取得 Main/Router/Worker 写权，远端客户端不能借此获得本机权限，且不复用旧存储键。使用独立试验或现有测试接缝，不把试验接入产品。如果没有可用的公开路径，记录具体缺口并停止，不为证明可行而放开 Session Reader 或修改 DSH。试验结果只提供决策依据，不记为产品发布验收通过。

以 [核查 DSH 公开 API 能否支撑经典 Agent 模式](https://github.com/IceFireIcer/DS-SuperAgent/issues/167) 区分可尝试的公开路径与应停止的路径。
