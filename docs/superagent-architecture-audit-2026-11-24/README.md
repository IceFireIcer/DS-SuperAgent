# DS-SuperAgent 架构对照审计

日期：2026-11-24（Asia/Shanghai）  
快照：`dev @ d03bb4349a27752a032284c78790f53737bb5ab8`，含当前未提交改动  
参考：`super-agent-references/claude-analysis/superagent-report.md`

## 打开方式

双击 `index.html` 即可阅读。主页是面向桌面阅读的精简版，固定按 1160px 内容宽度排版，不做移动端适配。Mermaid 运行库在 `assets/mermaid.min.js`，不依赖 CDN。

旧版长报告保留在 `archive/detailed-v1.html`，其中包含 35 项完整矩阵和更多解释。

## 结论

- 当前产品已从 Claude 报告描述的两层研究原型，演进为 **Main / Router / Worker 三层**产品运行时。
- 文章主路径的 35 个可判定机制点中：**22 个完整、11 个部分、2 个未完成或不等价**，折算机制覆盖约 **79%**。
- 真实模型、真实渠道、真实设备与托管部署的组合证据约 **三分之一**；不能把代码存在、测试文件存在或 UI 页面存在等同于生产验收。
- 可靠性设计比较完整：Ticket / Assignment、Host lease、Effects / Delivery 和未知外部结果对账都已进入领域层。
- 当前最明确的缺口是：Main 半双工、100 词 IM 硬约束缺失、渠道对称性不足、无状态水平扩展缺失、长程记忆归档缺失、设备 daemon 未产品化。

## 文件

| 文件 | 内容 |
|---|---|
| `index.html` | 精简版桌面报告：结论、架构、13 项机制、差异、完成度和证据 |
| `archive/detailed-v1.html` | 旧版长报告，保留完整 35 项矩阵和更多细节 |
| `assets/architecture-simple.svg` | 主报告使用的简化架构 SVG |
| `assets/architecture-map.svg` | 旧版详细架构 SVG |
| `assets/mark.svg` | 报告页图标 |
| `assets/mermaid.min.js` | 本地 Mermaid 12.3.0 UMD 运行时 |
| `assets/concise-hero.png` | 精简版首屏预览 |
| `assets/concise-desktop.png` | 精简版全页预览 |
| `diagrams/simplified-workflow.mmd` | 精简版工作流 Mermaid |
| `diagrams/work-lifecycle.mmd` | 工作生命周期时序图 |
| `diagrams/authority-recovery.mmd` | Host 接管与代次恢复图 |
| `diagrams/logical-flow.mmd` | 完整逻辑流图 |
| `evidence/01-domain-runtime.md` | 领域模型、路由、票据、执行、持久化、远程与监督 |
| `evidence/02-dsh-product-surface.md` | DSH 集成、产品协议、UI、多信道与交互缺口 |
| `evidence/03-desktop-delivery.md` | 桌面启动、数据隔离、部署、BYOM、Watchdog、测试与 CI |
| `audit-data.json` | 机器可读快照、指标、机制评分与风险摘要 |

## 方法

1. 以 Claude 报告的文章概念映射和旧原型结论作为外部基线，不把它当作当前仓库事实。
2. 三路独立只读审计：领域运行时、DSH/UI 产品面、桌面部署与交付。
3. 机制评分只回答“代码中是否存在闭环”，完整 1 分、部分 0.5 分、未完成 0 分；外部验收另用证据等级报告。
4. 本次没有运行全量测试，没有连接真实飞书、IM、第二设备或真实模型；所有产物均未修改产品代码。

## 证据边界

- 当前工作区有未提交改动，本报告是该工作树的静态快照。
- 代码规模、文件数和测试文件数来自本地静态统计，`test()` 声明数只作规模参考。
- 真实模型证据引用仓库已有 Qwen3.5 9B 记录；真实 GitHub 回执、Windows 原生安装升级与 Ubuntu 远端设备同样来自已有实施记录。
- 真实飞书、8 类 IM、托管 PostgreSQL、离线 stop/resume、Narrator、英文 DSH locale 和同 SHA 全量 CI 仍未由本审计复验。
