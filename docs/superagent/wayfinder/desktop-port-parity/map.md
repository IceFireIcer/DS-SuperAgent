## Destination

形成一份可直接拆实施票的桌面补充规格：从 `temp/DS-Bot` 的实际代码复用功能、UI 和动效，接到现有 SuperAgent 产品动作，并按同一用户路径验收。纳入经典 Agent 的切换与返回，不新增为现有桌面发布门槛。

## Notes

- 桌面补充规格已在 `docs/plans/2026-11-21-desktop-port-parity.md` 定稿。迁移源是 `temp/DS-Bot` 的 `v0.3.8`（`5e9b7da8`）。三张参考图用于定位入口、组件、样式和动效，产品对照基线为 `dev` 的 `50491ff1`。
- 承接 [DS-Bot 0.3.8 前端与功能迁移规格](https://github.com/IceFireIcer/DS-SuperAgent/issues/142) 与 [DS-Bot 0.3.8 前端与功能迁移决策图](https://github.com/IceFireIcer/DS-SuperAgent/issues/131) 的已定边界。保留现有产品界面、`/api/product` 和 Main/Router/Worker 权限；只用公开 DSH API。交互判断参照 [DS SuperAgent UI 设计标准](https://github.com/IceFireIcer/DS-SuperAgent/blob/50491ff160ccf1a5bc86226d52d2a3e0162ed31f/docs/design/ui-standard.md)。
- [22 · 品牌、命名、安全与最终验收](https://github.com/IceFireIcer/DS-SuperAgent/issues/164) 保持开放，既有依赖不动。桌面证据单独记录，不代替总规格的真实外部接入或手机验收。
- 优先用现有已同步模块，或按 Apache 2.0 与 NOTICE 约定引入相关代码，替换旧 Bot 数据和 action。经典模式先看 DS-Bot 的 slot 装卸和返回按钮，现有接线确认有缺口时才查对应的公开 DSH 能力，保持原 Main 和工作作用域。
- 本图只做决策，不实施产品功能。后续会话按票类型使用 `grilling`、`domain-modeling` 或 `prototype`；只认领未被阻塞且未分配的票，一次只处理一张。

## Decisions so far

- [核对桌面用户路径与实际接线](https://github.com/IceFireIcer/DS-SuperAgent/issues/166#issuecomment-7055595551)：已逐项定位上游源码、现有产品动作和待补入口；侧栏分组与实际工作目录是两条路径。
- [确定独立桌面验收的证据与门槛](https://github.com/IceFireIcer/DS-SuperAgent/issues/168#issuecomment-7055697055)：以远端同一候选提交的完整 CI 验收桌面补齐；真实环境暂缓，正式发版门槛不变。
- [确定侧栏文件夹与工作目录的关系](https://github.com/IceFireIcer/DS-SuperAgent/issues/169#issuecomment-7055825360)：复用目录选择器；侧栏与输入框共用下一条 Main 的目录选择，实例默认目录和已接纳工作不变。
- [确定底栏账户、连接器与模型引导的分工](https://github.com/IceFireIcer/DS-SuperAgent/issues/170#issuecomment-7056204160)：复用上游账户底栏和 Main 模型引导，走现有设置、Host 凭据和公开登录入口。
- 复用上游连续语音，按 Main 回执匹配回复，暂停后由用户继续。[确定 Main 连续语音的暂停与恢复规则](https://github.com/IceFireIcer/DS-SuperAgent/issues/171#issuecomment-7060119743)
- 键盘、焦点、反馈和减少动效逐路径必验，窄宽窗口与四主题浅深按代表路径抽验。[用交互样板核定桌面动效与键盘验收](https://github.com/IceFireIcer/DS-SuperAgent/issues/172#issuecomment-7063742924)
- [裁定经典 Agent 模式的入口与权限边界](https://github.com/IceFireIcer/DS-SuperAgent/issues/174#issuecomment-7060652881) · 本机 Host 所有者可切到已授权的独立原生会话，并在同一窗口返回原 Main。

## Not yet specified

暂无新增待澄清事项。

## Out of scope

- [21 · 手机 Expo App](https://github.com/IceFireIcer/DS-SuperAgent/issues/163)、手机配对和中继；不改变现有手机票的状态或依赖关系。
- 恢复旧 Bot 与群聊、Bot 模型与头像库、旧 Local Agent、团队权限；重新设计视觉、替换 renderer、增加 `/api/bot`、更改 DSH 安装或访问用户现有 DSH/DS-Bot 数据。
- 在本图交付产品代码、执行实际发布或宣布总迁移规格完成。真实第三方的待验项单列归属，不在图内登录、配对或改票状态。
- [核查 DSH 公开 API 能否支撑经典 Agent 模式](https://github.com/IceFireIcer/DS-SuperAgent/issues/167)：不单独做 DSH 调研作为迁移前置；从 DS-Bot 本地实现出发，具体接线缺口才按需核查。
- [隔离验证经典 Agent 与 Main 的往返](https://github.com/IceFireIcer/DS-SuperAgent/issues/173)：不在迁移前另立独立试验；原 Main 身份、返回和权限在经典模式对应用户路径验收。
