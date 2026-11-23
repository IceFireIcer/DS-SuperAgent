# 迁移收尾：设置、手机端与产品隔离

依据 [#142](https://github.com/IceFireIcer/DS-SuperAgent/issues/142)、[#162](https://github.com/IceFireIcer/DS-SuperAgent/issues/162)、[#163](https://github.com/IceFireIcer/DS-SuperAgent/issues/163) 和 [#164](https://github.com/IceFireIcer/DS-SuperAgent/issues/164)。不加载旧产品运行时，不自动读、写或删除原有产品存储。

## 实施

- #162：现有设置壳接入反馈预览、复制和下载，第三方 issue 链接不携带诊断。记忆增加查询对话框并修复工作记忆导入；预设、主动准备和监督保留现有业务路径，失败时显示状态；关于页接到更新状态。
- #163：Expo 手机端沿用加密中继，支持扫码或粘贴配对、电脑列表、Main 历史和授权发送、只读工作状态。分页不被后台轮询覆盖。系统安全存储保留配对和未确认发送的 ID 与摘要，不保存聊天正文，不自动重发。Android 的应用 ID 使用有效的 `io.github.icefireicer.dssuperagent`。
- #164：运行时命名扫描覆盖源码及生成桌面 bundle。旧产品路径只作为拒绝规则，隔离目录用 junction 夹具核对；无法打开的已存工作目录不会阻止 Host 启动或静默改派。浏览器资源使用新分区，可能需要重新登录。
- Windows 启动回归：DSH 0.2.2-rc.1 要求 `collectIndexInjections(peer)` 带身份，桌面 Host 原先漏传。改用公开的 `connection.browserPeer`；不修改 DSH。

## 已核对的证据

- Node 24：TypeScript、构建、lint、生成 bundle 一致性和 UI boundary 已通过；命名扫描 278 个运行时文件，非白名单命中 0。客户端全套 202 项通过、1 项跳过。
- Host 定向 6 项通过，包含 Expo RPC 的回环加密配对、重新授权、同命令去重、已撤销设备拒绝及目录隔离。桌面全套 253 项通过、1 项跳过；随后新增的 Host ready 回归在修复前重现 `principal` 异常，修复后通过。
- Windows x64 解包产物用 `check-packed.mjs --coexistence` 在仓库外启动并通过：六个设置入口、现有桌面桥、旧存储键和路径夹具、Main 收发、窗口隐藏与恢复、退出码 0。包内 Host、profile、产品身份及客户端与工作区 SHA-256 一致。本次未安装或打开用户的旧产品。
- 手机 TypeScript、Android 预构建和 Hermes bundle 导出通过。Windows Gradle 绕过本机 Java socket 初始化失败后进入 Android 构建；按要求停止额外的 NDK 下载和模拟器验证，并清理本次下载及临时模拟器数据。没有 APK 或 #163 的物理手机验收；[USB 真机步骤](../../../mobile/README.md#verify-on-a-physical-android-phone)使用现有 Android Studio 和本地中继。
- 首次服务端全量运行中，协作基准在模型输出前等待回合结束后的回执，托管接管测试也卡在数据库就绪阶段。基准现改用公开的 Session flush 和持久消息查询，三种模式各完成 12 个事件；生产执行与回执顺序不变。
- GitHub 日常 CI 首轮通过 SuperAgent 检查、服务端 smoke 和桌面 profile；手机 job 缺少共享 Link 源码所需依赖，发布扫描的测试夹具和旧名拒绝规则文字触发失败。已补共享依赖安装和变更范围判定、修正夹具和旧名上下文，不放宽扫描规则。仓库脚本 31 项通过；[日常 CI](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/44733451713)重跑一次 Worker 等待超时的作业后通过，未执行发布矩阵。
- 托管接管测试定位到 Windows 测试夹具：数据库已监听，`pg_ctl` 已退出，但后代仍持有 `execFile` 的输出管道。夹具改用忽略输出的 `spawn`，有界等待退出，不修改生产持久化或接管。定向托管接管与数据库生命周期检查 3 项通过。
- [`8ea87f2d` 的日常 CI](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/44736848117)通过。包含夹具修复的 Windows / Node 24.22.3 本地串行服务端全套已结束：**780 通过、10 失败、6 跳过**，退出码 1。托管接管与协作基准均通过；失败包括输入恢复夹具 5 项、终端用例断言通过后进程未退出 1 项，以及远端作业和 PTY 4 项。结果已记录在 [#164](https://github.com/IceFireIcer/DS-SuperAgent/issues/164#issuecomment-7040012768)，全套检查未通过，工单保留开放。

## #164 桌面复验

- 输入恢复夹具等待初始工作就绪和 Assignment 结束，通过公开 Session 回执回调触发落盘后的退出。保留五个实际进程退出点、原消息只出现一次及恢复附注的断言。PostgreSQL 跟进用例等待 `ready` 和 `persisted` 同时成立，再核对原 Ticket、Session 与重启后的记录。
- Windows 设备按 `PATHEXT` 查找 `.exe`、`.com`，跳过无扩展名的脚本。进程范围查询与 `taskkill` 有界异步执行，每个 Job 合并并发停止请求。首轮结束后重试一次，仍以进程范围静止作为 `cancelled` 的证据。Standards 与 Spec 复审通过。
- Node 24.22.3 串行服务端复验使用 `--test-force-exit`，结果为 **789 通过、1 失败、6 跳过**。恢复、远端 PTY 和作业取消的原失败项通过。唯一失败是 PostgreSQL 跟进等待条件，修正后定向复验 **14/14**。DSH 本机 PTY 功能断言通过，该测试进程自然退出仍待上游修复。[限制记录](r5-17.md#限制)
- 第二轮使用同一参数，PostgreSQL 跟进通过。结果为 **789 通过、1 失败、6 跳过**，唯一失败是 GitHub 轮询主动取消被投影为 `failed`。新增确定性回归使第二次拉取等待取消；修复后轮询器报告 `stopped`，真实来源错误与超时仍报告失败。Standards 与 Spec 复审通过。
- 客户端全套 **202 通过、1 跳过**，桌面全套 **254 通过、1 跳过**。类型检查、构建、lint、客户端生成检查、UI boundary 和仓库脚本检查通过。运行时命名扫描覆盖 278 个文件，非白名单命中 0。双语 README 补齐桌面使用与发布要求，包内 NOTICE 补充迁移来源。
- GitHub 轮询修复前的 Windows x64 免安装构件为 0.2.5，DSH 0.2.2-rc.1，Electron 44.7.0。`app.asar` 的 SHA-256 为 `eebe0d9aaddfb0865153741ccbd51ab2f2655a8aba39f5a69fb451d3ae47c01b`。包内 58 个编译运行文件与隔离构建目录一致，客户端与仓库构建仅有 8 行 esbuild 来源路径注释不同，NOTICE 与源码一致。
- 真机从仓库外用临时目录和模拟模型启动该构件。`--coexistence` 覆盖设置、桌面桥、旧存储键与目录夹具、Main 收发、隐藏唤回和退出码 0。`--controls` 在隔离脚本副本中用 `.bt-q button.bt-q-opt` 和 `.bt-q button[type=submit]` 定位当前问题卡，通过同一 Worker 的回答、独立停止 Main 回复、工作的停止确认与同 Ticket/Session 恢复。

### 候选构件与发布检查

- [`4045860b`](https://github.com/IceFireIcer/DS-SuperAgent/commit/4045860b) 的 Windows x64 免安装构件重跑共存和工作控制，均退出 0。`app.asar` SHA-256 为 `de2227e1dc6a076745c330a4af05f14823ce149ca18746bd799b6ac735112144`；包内 58 个编译运行文件与该构建一致。未安装到常用目录，未连接真实模型或读取真实旧版数据。
- 最后一轮本机全量因并行误启动的构建清空 `dist`，出现 8 项模块缺失，不作为全量证据。确认构建完成后独立复跑受影响 7 个文件和轮询回归：**46 通过、0 失败、3 跳过**；不将两轮结果拼成一次全量通过。
- [完整 CI](https://github.com/IceFireIcer/DS-SuperAgent/actions/runs/44777356955) 的 macOS arm64/x64 打包检查、桌面 profile、Docker、手机类型检查和发布扫描通过。Windows 新装启动通过，但安装版下载更新后未在时限内退出；Linux 在免安装包的 Main 发送/回复检查失败。两个 Windows 服务端分片分别在远端验证命令和 Main 跟进的初始结果上失败。
- 同一次 CI 的客户端生成失败可在隔离的干净 npm 安装上复现：仅 esbuild 依赖路径注释和内部工厂标签受安装位置影响。构建脚本统一标签后，干净安装直接生成的 `client.js` 和 `office.js` 与 Git 中的产物逐字节一致。未手改或更新生成文件。
- 最终验收由 [#164](https://github.com/IceFireIcer/DS-SuperAgent/issues/164) 跟踪；完整发布验证未通过，原生依赖 [#163](https://github.com/IceFireIcer/DS-SuperAgent/issues/163) 暂缓。未发布安装包或合并至 `main`。
