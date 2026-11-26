## Resolution · 独立桌面 CI 验收

维护者确认：桌面验收交给远端 GitHub Actions，当前阶段不用真实环境。这是桌面补齐的 CI 验收口径，不是正式发布通过。

### 通过条件

- 候选提交推送到远端 `dev` 后，用现有 [`DS-SuperAgent CI`](https://github.com/IceFireIcer/DS-SuperAgent/blob/50491ff160ccf1a5bc86226d52d2a3e0162ed31f/.github/workflows/test.yml#L3) 跑 `full=true`，核对运行的 `headSha` 和包的来源。普通推送触发的 smoke／变更测试不能替代完整验收。
- 同一候选提交须有 Windows x64 安装版新装、下载升级、旧进程退出、覆盖安装、重开和数据保留；macOS arm64/x64 的包启动与 Main 工作流；Linux AppImage/deb 的发布检查与 Main 收发，提交前确认授权环境已就绪。保留原发布清单的安装、更新及数据隔离检查。
- 用隔离夹具和 mock 模型验证共存、Main 收发、问题回答、停止回复和停止工作，另要求全量服务端正常结束。当前打包 job 只调用默认 `check-packed.mjs`；后续须在远端 CI 留下 `--coexistence`、`--controls` 或等价用户路径的独立结果。失败、取消、必验项跳过、超时后强杀或强制退出都不算通过；不拼合不同提交或局部结果。
- 每条证据记录候选 SHA、工作流及 job/步骤链接、平台和架构、构件版本及指纹（适用时）、通过／失败／未验证和退出结果。未签名免安装包的旧记录仍只算本机试用。

### 暂缓与边界

- 真实模型、本机电脑操控指示器的真实事件、真实 OAuth、邮件、八平台 IM、外部 MCP 暂不作为本轮 CI 门槛，均保留「未验证／暂缓」，不以 mock、协议夹具或代码闭票代替。CI 不使用真实账户、密钥或个人 DSH 数据。经典 Agent 模式维持独立验收，不新增为现有发布门槛。
- 本决议不触发 CI 或发布，不改 [22 · 品牌、命名、安全与最终验收](https://github.com/IceFireIcer/DS-SuperAgent/issues/164) 或 [21 · 手机 Expo App](https://github.com/IceFireIcer/DS-SuperAgent/issues/163) 的状态与依赖，也不豁免正式发版清单或宣布总规格验收完成。
