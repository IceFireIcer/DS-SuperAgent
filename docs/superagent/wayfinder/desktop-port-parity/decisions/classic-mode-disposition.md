## Question

如何复用本地 `temp/DS-Bot` 的经典 Agent 入口、切换和返回，把 DS-Bot 的默认落点替换为返回同一 SuperAgent 主对话？

先看 `temp/DS-Bot/ds-bot/src/client/sidebar.js` 的 `BotReturn`、`index.js` 的 `setSurface` 与 `surface.js` 的 `surfaceGroups`。确定哪些 UI 和状态收尾可以复用，哪些旧 Bot 默认落点、数据键和 action 必须替换。以同窗切出再返回验收：原 Main 不换、不重发，在途工作不受影响，不扩大原生会话可见范围或远端权限。遇到具体接线缺口才查对应公开 DSH 能力，不放开 Session Reader，也不复活旧 Local Agent。本路径不新增桌面发布门槛。

从 [核对桌面用户路径与实际接线](https://github.com/IceFireIcer/DS-SuperAgent/issues/166) 确认上游入口和现有产品挂载。
