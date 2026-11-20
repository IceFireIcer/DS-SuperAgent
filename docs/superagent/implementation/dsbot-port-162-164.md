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
- Windows x64 解包产物用 `check-packed.mjs --coexistence` 在仓库外启动并通过：六个设置入口、现有桌面桥、旧存储键和路径夹具、Main 收发、窗口隐藏与恢复、退出码 0。本次未安装或打开用户的旧产品。
- 手机 TypeScript、Android 预构建和 Hermes bundle 导出通过。Windows Gradle 绕过本机 Java socket 初始化失败后进入 Android 构建；按要求停止额外的 NDK 下载和模拟器验证，并清理本次下载及临时模拟器数据。没有 APK 或 #163 的物理手机验收。
- 服务端全量运行未完成：当时协作 benchmark 在首个模型响应前等待回合结束后的回执，在 `hosted-product-postgres.test.mjs` 长时间无新输出后停止。现已在基准内改用公开的 Session flush 和持久消息查询；定向用例三种模式各完成 12 个事件，生产执行与回执顺序不变。
- GitHub 日常 CI 首轮通过 SuperAgent 检查、服务端 smoke 和桌面 profile；手机 job 缺少共享 Link 源码所需依赖，发布扫描的测试夹具和旧名拒绝规则文字触发失败。已补共享依赖安装和变更范围判定、修正夹具和旧名上下文，不放宽扫描规则。仓库脚本 31 项通过；日常 CI 不替代 #164 的全部检查或发布矩阵。
