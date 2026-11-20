# DS Bot 0.3.8 客户端迁移

2026-11-19 · [迁移规格 #142](https://github.com/IceFireIcer/DS-SuperAgent/issues/142)

| 工单 | 已落地 | 验收边界 |
| --- | --- | --- |
| [#144](https://github.com/IceFireIcer/DS-SuperAgent/issues/144) | 同步清单固定上游 `5e9b7da8`，覆盖 126 个客户端文件和 5 个共享依赖。生成副本逐文件标注来源，退役入口保存在文本参考中。npm 包包含 `NOTICE`。 | 同步和逐条命名门通过。命名门保留既有路径保护、分区、导入格式及应用升级常量的逐行白名单。完整参考树可在本地生成，产品包只分发实际使用的客户端。 |
| [#145](https://github.com/IceFireIcer/DS-SuperAgent/issues/145) | 四套主题的浅色、深色及跟随系统模式，7 个预设强调色、3 档动效、12–18px 会话字号。6 个上游语言字典随产品注册。 | 真实 profile 核对 8 套浅深主题的根节点 token。单独的 Chromium 夹具核对强调色、动效及字号边界。缺少译文时使用产品默认文案。 |
| [#146](https://github.com/IceFireIcer/DS-SuperAgent/issues/146) | 21 个上游适配入口提供参数转换、响应投影和错误映射。产品 Main 和设置通过统一 `api.js` 访问 Host。停止命令绑定显示中的消息 ID，目录选择进入适配层。 | 浏览器请求使用 `/api/product`，上游未接线命令在传输前拒绝。桌面跨 Host 仍走现有认证网关 `/instances/:id/product/…`。上游页面尚未全部接入这些入口。 |
| [#147](https://github.com/IceFireIcer/DS-SuperAgent/issues/147) | 侧栏、头部、品牌、命令面板与浮层接入 DSH slots。通知使用 Main 回复和产品问题事实。旧团队页面未进入产品导航。 | 基于上游形态适配产品会话。当前桌面桥缺少通知方法时使用页面通知。 |
| [#148](https://github.com/IceFireIcer/DS-SuperAgent/issues/148) | Main 使用 DSH 原生会话根。产品 Host 通过隔离的只读 Session Controller facade 向现有客户端提供当前 Main 的目录、历史和被动 follow，发送与停止仍走产品 Host。composer、问题卡、工作卡、来源卡和准备卡按 DSH `user/message` ID 仲裁与归位；未载入回合的卡片在输入区上方保留入口。DS-Bot 的推理、错误、时间分隔和问题卡样式已接入，助手和工具调用使用 DSH 原生卡片。Activity 同时作为会话视图和侧栏面板可切换，工具事实入口可直达对应 Worker 活动。没有 `cwd` 的旧 Main 在启动时用现有 rollover 事务迁移到确定性的带目录子会话，保留消息 ID、模型上下文和逻辑 Main 身份；会话被占用、提交被延后或日志无法精确复制时继续显示产品历史并保持原日志不变。 | 真实隔离 profile 验证原生会话、单一输入框、发信、停止、刷新补读、问题卡接管与草稿恢复、工作卡归位、原请求证据、工具事实跳转、Activity 切换、推理与错误卡，以及旧 Main 的迁移、重启和续聊。来源卡和准备卡的消息关联用受控 history 投影夹具验证；本次 smoke 未注入实时飞书/GitHub 事件。类型检查、构建、lint、客户端全量和 Main/Session 定向服务端用例通过；按本次收尾要求未重跑服务端与桌面全量 CI。 |
| [#149](https://github.com/IceFireIcer/DS-SuperAgent/issues/149) | 产品设置壳独占设置 section slot。五组导航、21 页、四组双 Tab、角色和模型分离。内置插件页通过产品 Host 显示只读目录。 | Chromium 逐页打开并切换 Tab。连接器、IM、手机等尚无产品接线的页面明确显示不可用。 |
| [#150](https://github.com/IceFireIcer/DS-SuperAgent/issues/150) | 设置壳与产品页复用 8 个共享组件。使用现有产品命令，使用主题 token 的页面边界样式统一，用量和状态各自加载。 | Chromium 夹具检查四套主题的浅深组合、两种宽度和字号边界。真实账户和外部平台未参与本次验收。 |

## 验证

- 从仓库根目录运行 `node superagent/dsh/scripts/sync-client.mjs --write`，再运行 `--check` 与 `--check-names`。固定上游 Git 对象位于 `temp/DS-Bot`，同步前后上游检出均干净。
- Windows Node 24 上通过类型检查、构建、lint、命名和 UI 边界检查。客户端全量 198 项通过、1 项跳过。用 `PLAYWRIGHT_CHANNEL=msedge` 运行 `node app/scripts/check-superagent-profile.mjs --check-ui --check-upgrade`，在真实浏览器验证单一 composer、发信、停止后 Host 记录为 `stopped`、刷新补读、工具/推理/错误卡、工作卡归位、原请求证据、问题卡接管与草稿恢复、Activity 切换、四套主题的浅深切换、设置页，以及公开 profile 重启后的备份恢复、停止和日程授权。隔离 profile 的原生 Gateway 操作拒绝断言通过；会话目录只返回当前 Main。
- #148 的最终代码通过 `main-session-reader`、`main-rollover`、`main-conversation` 共 14 项定向服务端用例，覆盖旧 Main 断点重试、迁移后重启与续聊、rollover、并发输入和 Host 所有权。桌面定向 profile 与产品客户端测试在隔离安装中通过。按用户要求，本次收尾没有重跑服务端和桌面全量 CI；下方全量数字保留自上一轮，不代表本工单最终代码的再次验收。
- 桌面全量用例 245 项通过、2 项失败、1 项跳过。托盘关闭问题在 #143 的旧版对照已复现。窗口与托盘启动用例在单独重跑时通过。
- Windows 服务端全量 754 项通过、8 项失败、6 项跳过。失败发生在协作基准、5 个输入恢复阶段、PostgreSQL 工作计划和远端 PTY 就绪。协作基准、输入恢复首个阶段和远端 PTY 在 #143 有旧版对照。新增的内置插件目录通过产品 HTTP 定向测试和隔离 profile 浏览器检查。
- [CI 定向分片](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/44528303963) 的 Main 委托用例返回 `QUEUE_FULL`，同一用例在本机单独运行时通过。
- 规范和规格双轴审查覆盖 npm 归属、停止命令定位、通知投影、命名与运行时语言、Session Controller 的 owner 与 Main 范围、问题卡仲裁和旧会话迁移。修正后复验。
