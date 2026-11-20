# 客户端迁移第二阶段

2026-11-20 · [迁移规格 #142](https://github.com/IceFireIcer/DS-SuperAgent/issues/142)

| 工单 | 实现 | 验收边界 |
| --- | --- | --- |
| [#151](https://github.com/IceFireIcer/DS-SuperAgent/issues/151) | 成员 dock 从当前执行安排汇聚运行中和停止中的 Worker Session。Work 分页汇聚工作项，依据当前报告的交付回执分组。停止要求二次确认，备注随原 Ticket 一起进入持久跟进。 | 精确 Ticket 版本和 Assignment generation 由 Host 校验。备注草稿随轮询保留，已提交备注可刷新补读。 |
| [#152](https://github.com/IceFireIcer/DS-SuperAgent/issues/152) | 桌面启动窗交接、原生目录选择、数据位置与移动、隔离导入、日志、通知、下载回执、窗口材质和打包检查。 | 电脑指示器的真实控制事件随电脑操控模块接入。安装包矩阵属于发布验收。 |
| [#153](https://github.com/IceFireIcer/DS-SuperAgent/issues/153) | GitHub 和飞书支持本机回环 OAuth，授权绑定 Host 配置的来源。邮箱支持 TLS 账号、收件箱、规则标记与确认回复。 | 远程端只读脱敏状态。飞书 OAuth 授权过期后重新授权。真实应用注册、OAuth 回调与邮箱收发属于环境验收。 |
| [#154](https://github.com/IceFireIcer/DS-SuperAgent/issues/154) | 飞书、钉钉、企微、QQ、微信、Discord、Slack、Telegram 各有独立协议适配器。Host 批准后，私聊消息进入 Main 的来源会话。取消配对会阻断新消息、尚未派发的 Ticket 和原配对的外发。 | 八个平台通过受控协议夹具验证。真实平台登录、扫码和收发逐个验收后才能关闭本票。 |
| [#155](https://github.com/IceFireIcer/DS-SuperAgent/issues/155) | 技能、MCP 工具和能力包支持保存、删除、审批及角色/工作范围绑定。Worker 消费 MCP 凭据前重新验证当前授权和执行范围。 | 契约覆盖权限、幂等、过期版本和重启。真实外部 MCP 服务与 Worker 环境组合仍待验收。 |

## 本地验证

- Node 24.22.3 下，服务端定向 **23/23**、profile 与 HTTP 补充 **9/9**、客户端定向 **25/25**。类型检查、构建、lint、生成客户端及 UI 边界检查通过。
- 桌面包串行测试 **251 项通过、1 项 Linux 专用测试跳过**。Windows x64 `npm run pack` 生成未签名免安装包，并核对包内的当前桌面壳、客户端和运行依赖。未在最终包上重跑 `check-packed`。
- 隔离 `ds-superagent` profile 使用模拟模型启动，在 Chromium 验证成员 dock、Work 分组与刷新、连接器、IM 和能力库页面。Telegram 回信测试使用模拟平台；未运行全量 CI 或部署。

## 双轴审查

- Standards 审查修正 Host 初始化顺序、搬移路径复验、SMTP 生命周期和规则删除确认。
- Spec 审查修正 OAuth 运行时接线、IM 配对撤权后的派单校验、活跃 Worker 汇聚及远程读范围。电脑指示器的真实事件来源见 #152 验收边界。
