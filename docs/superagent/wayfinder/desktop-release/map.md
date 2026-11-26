# [DS SuperAgent 桌面多平台发布路径](https://github.com/IceFireIcer/DS-SuperAgent/issues/195)

正式地图：[DS SuperAgent 桌面多平台发布路径](https://github.com/IceFireIcer/DS-SuperAgent/issues/195)。对应的[总体规格](https://github.com/IceFireIcer/DS-SuperAgent/issues/202)已发布；六项发布决策均已完成，未对任何候选包作发布签核。原生父子关系和决策索引见 [manifest.json](manifest.json) 及 GitHub Issues。

## Destination

把 2026-11-24 架构审计结论转为可执行的桌面发布决策：界定发布候选的多平台构建范围，明确 Windows x64 公开预览的分发、回滚与放行条件，以及稳定版的逐平台验收门槛。

## Notes

- 基线是 [2026-11-24 架构审计](../../../superagent-architecture-audit-2026-11-24/index.html) 及随附证据，不使用 R5 作为本次规划依据。
- 本图只处理规划决策，不改产品代码，不执行当前候选的实测或发版，也不把代码存在或历史结果当作本候选的验收证明。
- 不自动创建项目，不替用户指定项目目录。没有项目时只启动 Main 对话，不启动 Router 或 Worker。用户在侧边栏主动创建项目并选择文件夹；项目目录是工作起点，不是 Worker 不得越过的边界。不预设要新增一套机制。
- 发布候选从同一提交构建 Windows、macOS、Linux 桌面包；维护者已决定首发为 Windows x64 公开预览，不设内部/受邀内测、邀请码或反馈义务。其他系统的构建不自动等于支持声明。这不是稳定版承诺，也不表示当前候选已经获准发布。
- 公开预览承诺范围为桌面对话与本地项目工作，不把外部渠道列为已支持范围；Main 半双工作为已知限制。多个独立工作可并行，超过并发预算的普通工作可排队；项目与跨目录授权边界按已关闭决议执行。
- 维护者已确认的稳定版底线：同一候选 SHA 通过全部必需 CI 和每个声明支持平台的构建与核心流程验收，且至少有一个声明支持的真实模型核心流程证据。未声明支持的外部渠道和设备不自动成为发布阻塞。
- 逐包签核、已知问题与自愿反馈的处理规则见相应决议。
- GitHub Issue 是正式地图与决策票索引；只用 `wayfinder:*` 标签。一次最多处理一张非研究票，决议只写回对应 Issue。

## Decisions so far

- [明确桌面多平台构建与逐平台放行的边界](https://github.com/IceFireIcer/DS-SuperAgent/issues/201#issuecomment-7136231623)：同一提交构建 Windows、macOS、Linux 桌面包；构建不等于该平台已验收或放行。
- [确定桌面稳定版的 Go/No-Go 门槛](https://github.com/IceFireIcer/DS-SuperAgent/issues/198)：各声明平台按同一提交及确切构件签核，有真实模型端到端证据；不以试用反馈数量代替验收。
- [确定 Windows 桌面首发的放行门槛与证据记录](https://github.com/IceFireIcer/DS-SuperAgent/issues/197)：维护者按候选提交和包摘要签核四项场景及必需 CI；失败、缺证或沿用旧包记录均不放行。
- [确定 Windows x64 首发形态、分发与回滚边界](https://github.com/IceFireIcer/DS-SuperAgent/issues/196)：经官方 GitHub Releases 发布；更新由用户确认、失败回滚，保留产品数据与项目文件，并隔离个人 DSH 数据。
- [确定桌面首发是否跳过内测以及承诺级别](https://github.com/IceFireIcer/DS-SuperAgent/issues/200)：Windows x64 公开预览，开放下载，不要求邀请或反馈；不是稳定版承诺，也不是当前候选放行。
- [确定 Worker 跨项目目录工作的授权与拒绝规则](https://github.com/IceFireIcer/DS-SuperAgent/issues/199)：同一任务的 Worker 可共用明确授权；扩大范围须再询问，拒绝不影响无关步骤。

## Not yet specified

无。本图范围内不再有发布政策待定。

## Out of scope

- 三个桌面系统的构建都在本图范围内；不能仅凭构建成功扩大对外支持的平台或集成渠道。
- 本图不实施修复、不对当前版本执行实测，也不代替正式版本发布流程；地图清晰后再把结论整理成规格和实施票。
- 云端水平扩展、移动产品、远端设备 daemon、全面外部渠道覆盖和长期记忆归档不是 Windows 桌面首发的默认前置；只有维护者明确扩大支持范围时才纳入后续计划。
