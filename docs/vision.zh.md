# DS SuperAgent 愿景

[English](vision.md) | 中文

DS SuperAgent 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的三层 Agent 产品。Main 负责主对话并拥有用户意图；Router 把已接受的工作转成持久 Ticket；独立 Worker 执行 Ticket 并返回可核验结果。

产品以唯一的 `ds-superagent` DSH 包运行，可挂载到兼容的 DSH profile，也可由桌面应用启动。桌面应用提供固定版本的 DSH、独立 profile 和隔离的数据目录。两种形态共用同一套 Engine、Host 与现有 DSH 客户端界面。

## 产品原则

- **权威来源唯一。** Main 拥有用户意图；持久工作、权限、分配和交付事实由 Engine 管理。
- **工作可核查。** Ticket、Assignment、问题、证据和结果在重启、重连后仍可查看。
- **执行目标明确。** 工作使用已选择的本机或已配对远端环境，并核验所需能力；产品不在不同执行世界间静默切换。
- **能力遵守边界。** 文件、Office、浏览器资源、记忆、MCP 工具、凭据、日程和外部来源通过明确命令及授权使用。
- **数据由用户控制。** 桌面应用使用自己的数据目录，不写入用户的 `~/.dsh`。
- **有证据才算完成。** 改动用定向行为测试验证；平台和外部服务结论需要对应环境的证据。

## 谁来定方向

产品方向、已定设计的改动、协作规则、发版和架构由维护者决定。其他工作谁都可以做，流程见 [CONTRIBUTING](../CONTRIBUTING.zh.md#协作方式)。
