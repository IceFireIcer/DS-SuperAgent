# 桌面 UI P0 候选包验收（#192）

## 候选身份

| 项目 | 实测值 |
| --- | --- |
| 候选源码 SHA | `f816f9cd0d995607638064bd646bf5fbbef12354` (`dev`) |
| 客户端 bundle | SHA-256 `51c06ee3469fbd1ecd417ee24f5c9851253078eb078ac0b78a62defe8665c602`，与提交中的 `superagent/dsh/client.js` 一致 |
| Windows x64 unpacked Electron 可执行文件 | SHA-256 `6ec588ba506b1309fe6d9b302347bc31f76f29b0253f8ccd574c344bbbe9eecb` |
| 包内 `app.asar` | SHA-256 `afb69111efda1a27e6949f5b3fc721aa7e0af6e69692bb1112e0b6b11dc101d1` |
| 版本、Electron、DSH、Node | `0.2.5`、`44.7.0`、`0.2.2-rc.1`、`24.22.3` |
| 构建与执行系统 | Windows 11 Pro x64，build `26200`，当前界面 locale `zh-CN`，DPR `1.5` |

构建命令为 `npm ci --prefix superagent`、`npm run build --prefix superagent`、`npm ci --prefix app`、`npm run pack --prefix app`。目标是 `app/dist-pack/win-unpacked/DS SuperAgent.exe`，不是已签名的安装包。运行 `check-packed.mjs` 时设定 `GITHUB_SHA` 为候选 SHA；包内客户端哈希与提交客户端相符。所有候选运行均使用探针新建并清理的临时 App 数据目录和 mock 模型。

## 已通过

- 包内 `--first-model` 路径从无 Main 模型开始，键盘选择第一个有效授权模型，保存后仍返回同一 Main 和输入草稿，主动发送后在 Main 历史取得已完成输入及对应回复；进程自然以退出码 `0` 结束。
- 同一可执行文件的 `--controls` 验证问题卡回答、停止 Main 回复且其他 Work 继续、停止指定 Work 后的取消确认、恢复该 Work 和自然退出。
- `--classic` 验证键盘进入授权的原生会话、回到同一 Main 并保留回复、回执和运行中 Ticket，随后自然退出。
- `--coexistence` 验证应用隔离以及其余运行/退出路径；`--first-model`、`--controls`、`--classic`、`--coexistence` 四条正式打包探针皆通过。
- 新增的包内 P0 探针以桌面原生窗口实测 7 组：`1320×860 @100%`、`721×600 @100%`、`719×600 @100%`、最小窗口目标 `480×440`（实得 `508×482`）、以及 `508×480 @125%/150%/200%`。实测 CSS 视口在 `721/719` 正确跨过设置紧凑断点；7 组均通过设置布局、可达焦点及选中 Status 标签的 AX 树核对。
- 150% 与 200% 视口尺寸有小数 CSS px 四舍五入，弹层边界验收明确使用 2 CSS px 容差；以 200% 的 `254×241` CSS px 为例，边界外沿最大约 1.2 px，没有把缩放换算造成的断点误判为通过。
- 包内 16 个浅深主题组合（4 主题 × 2 窗宽 × 2 明暗）下的键盘、焦点、reduce-motion、Voice 权限拒绝反馈、模型设置、Work 空视图、嵌套 Esc 和主窗口自然退出检查通过；最终探针记录 29 张主题/导航截图。P0 视口截图共 7 张，并验证从搜索框经键盘抵达结果、选中 Status 标签，以及从结果离开未保存 Roles 时的保留/放弃流程。
- `check-superagent-profile.mjs --check-ui` 的独立隔离 Chromium 检查通过，覆盖 Main、配置、设置搜索、窄窗、模型引导、草稿和工作历史路径。
- `before-pack.test.mjs`、`package.test.mjs`、`superagent-profile.test.mjs` 和 `window-frame.test.mjs` 串行运行 16 项全部通过。包探针脚本 `node --check` 与 Oxlint 检查通过。

## 未覆盖与发布状态

- 本机是 `zh-CN` 环境；尚未切换实际英文 DSH locale 在桌面包重放。关键词检查覆盖中文“备份”和英文 `backup`，不能替代英文界面截图验收。
- 检查了 Chromium accessibility tree、语义选中态、键盘焦点与错误状态；Windows Narrator 虽已安装，本轮未启动或实测真实朗读与焦点播报。
- 语音在包内检查了麦克风拒绝、暂停反馈和焦点；用户实际麦克风、连续听写及语音中断仍需实机验收。
- 当前环境没有真实账号或远端设备。本地 probe 只验证 mock Host 和授权边界，不代表真实 OAuth、账号、设备或外部服务验收。
- 候选只在 Windows x64 构建和启动。macOS arm64/x64 与 Linux 构件、安装/升级矩阵都未在本机验证。`full=true` 完整 CI 仍为发布门槛；本轮没有推送候选或运行该完整工作流。不要将本记录视为跨平台发布批准。

所有包日志、SHA 清单、P0 JSON 和截图保存在忽略目录 `temp/ui-p0-192-f816f9cd/`（其中 `p0/` 有 7 张截图与 `packed-p0.json`，`visuals/` 有 29 张截图与 `visual-cases.json`，`controls/` 有 1 张问题卡截图，另含六个运行日志和 `validation-summary.json`）。本记录将 Issue #192 留在 open 状态，待跨平台、Narrator/真实语音和 full CI 证据补齐。
