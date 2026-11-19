# DS Bot 0.3.8 客户端迁移

2026-11-19 · [迁移规格 #142](https://github.com/IceFireIcer/DS-SuperAgent/issues/142)

| 工单 | 已落地 | 验收边界 |
| --- | --- | --- |
| [#144](https://github.com/IceFireIcer/DS-SuperAgent/issues/144) | 同步清单固定上游 `5e9b7da8`，覆盖 126 个客户端文件和 5 个共享依赖。生成副本逐文件标注来源，退役入口保存在文本参考中。npm 包包含 `NOTICE`。 | 同步和逐条命名门通过。命名门保留既有路径保护、分区、导入格式及应用升级常量的逐行白名单。完整参考树可在本地生成，产品包只分发实际使用的客户端。 |
| [#145](https://github.com/IceFireIcer/DS-SuperAgent/issues/145) | 四套主题的浅色、深色及跟随系统模式，7 个预设强调色、3 档动效、12–18px 会话字号。6 个上游语言字典随产品注册。 | 真实 profile 核对 8 套浅深主题的根节点 token。单独的 Chromium 夹具核对强调色、动效及字号边界。缺少译文时使用产品默认文案。 |
| [#146](https://github.com/IceFireIcer/DS-SuperAgent/issues/146) | 21 个上游适配入口提供参数转换、响应投影和错误映射。产品 Main 和设置通过统一 `api.js` 访问 Host。停止命令绑定显示中的消息 ID，目录选择进入适配层。 | 浏览器请求使用 `/api/product`，上游未接线命令在传输前拒绝。桌面跨 Host 仍走现有认证网关 `/instances/:id/product/…`。上游页面尚未全部接入这些入口。 |
| [#147](https://github.com/IceFireIcer/DS-SuperAgent/issues/147) | 侧栏、头部、品牌、命令面板与浮层接入 DSH slots。通知使用 Main 回复和产品问题事实。旧团队页面未进入产品导航。 | 基于上游形态适配产品会话。当前桌面桥缺少通知方法时使用页面通知。 |
| [#148](https://github.com/IceFireIcer/DS-SuperAgent/issues/148) | 现有 Main 保留单 composer，按消息 ID 划分工作卡与来源卡。准备卡在带同一来源事件的已知消息下展示，其余仍可在会话末尾查看。Activity 可切换。 | 原生会话根仍受阻。DSH `0.2.2-rc.1` 的 `SessionReference` 由 Session Controller 管理。公开 API 未提供经 `/api/product` 绑定 Main 的只读 transport。产品 profile 保留现有隔离。原生 cell、`turnTail` 和问题 composer 仲裁尚未验收。 |
| [#149](https://github.com/IceFireIcer/DS-SuperAgent/issues/149) | 产品设置壳独占设置 section slot。五组导航、21 页、四组双 Tab、角色和模型分离。内置插件页通过产品 Host 显示只读目录。 | Chromium 逐页打开并切换 Tab。连接器、IM、手机等尚无产品接线的页面明确显示不可用。 |
| [#150](https://github.com/IceFireIcer/DS-SuperAgent/issues/150) | 设置壳与产品页复用 8 个共享组件。使用现有产品命令，使用主题 token 的页面边界样式统一，用量和状态各自加载。 | Chromium 夹具检查四套主题的浅深组合、两种宽度和字号边界。真实账户和外部平台未参与本次验收。 |

## 验证

- 从仓库根目录运行 `node superagent/dsh/scripts/sync-client.mjs --write`，再运行 `--check` 与 `--check-names`。固定上游 Git 对象位于 `temp/DS-Bot`，同步前后上游检出均干净。
- Windows Node 24 上通过类型检查、构建、lint、命名和 UI 边界检查。客户端全量 197 项通过、1 项跳过。用 `PLAYWRIGHT_CHANNEL=msedge` 运行 `node app/scripts/check-superagent-profile.mjs --check-ui`，在真实浏览器验证单一 composer、发信、停止后 Host 记录为 `stopped`、刷新补读、四套主题的浅深切换、设置页和 Activity。隔离 profile 的原生 Gateway 操作拒绝断言通过。
- 桌面全量用例 245 项通过、2 项失败、1 项跳过。托盘关闭问题在 #143 的旧版对照已复现。窗口与托盘启动用例在单独重跑时通过。
- Windows 服务端全量 754 项通过、8 项失败、6 项跳过。失败发生在协作基准、5 个输入恢复阶段、PostgreSQL 工作计划和远端 PTY 就绪。协作基准、输入恢复首个阶段和远端 PTY 在 #143 有旧版对照。新增的内置插件目录通过产品 HTTP 定向测试和隔离 profile 浏览器检查。
- 规范和规格双轴审查覆盖 npm 归属、停止命令定位、通知投影、命名与运行时语言。修正后复验。`ui-deliverables` 仍在等待隔离的 `sessionController`。
