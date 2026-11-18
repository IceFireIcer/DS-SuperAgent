# Issue tracker

本项目使用 GitHub Issues：<https://github.com/IceFireIcer/DS-SuperAgent/issues>。

- 依据：当前 origin 指向此 fork；仓库已启用 Issues。用户显式调用 to-spec，授权将本轮规格发布到项目追踪器。
- 规格以总体 Issue 保存，正文同时保留在项目文档中；发布前检查同标题和同范围 Issue，避免重试重复创建。
- 后续实施票使用 GitHub 原生子 Issue 和阻塞关系，本轮用户已明确委托代理决定审计补充、功能归组和发布。
- PRs as a request surface：off。既有仓库分支、Issue 占用与 maintainer 规则继续适用；本轮规划发布沿用现有资料工作区，不切换或改写用户分支。
- 本地规格与实施票资料放在 docs；官方参考与研究放在 super-agent-references。遵从用户明确目录约定。
- 本次仅记录当前任务所需配置；完整技能环境可通过 setup-matt-pocock-skills 补齐，配置修改遵从其流程与仓库规则。

## 当前规格

- [总体规格 #1（当前以 R5 正式规格为准）](https://github.com/IceFireIcer/DS-SuperAgent/issues/1)
- 本地正文：[Super-agent 三层独立产品规格 R5](../superagent/spec-r5.md)；它显式替代 v2.1 的 D01、D17、D18、D20 冲突条款。
- 标签：ready-for-agent、enhancement。
- 当前 R5 使用总规格 → R5-01—R5-36 的直接原生子 Issue，不再创建功能聚合父票；具体前置用原生 blocked-by 表达。[拆分正文](../superagent/r5-tickets-draft.md)记录已批准的范围，[r5-publication.json](../superagent/r5-publication.json)记录发布映射与回读状态；只有 `verified: true` 才表示整批发布核对完成。
- R5 实施票使用 ready-for-agent 和 enhancement；只从本批次已满足具体 blockers 的票开始，不能把总体规格当作单张可一次完成的实现任务。初始入口是 [R5-01 / #93](https://github.com/IceFireIcer/DS-SuperAgent/issues/93)。
- 原 v2.1 的总规格 → G01—G14 → T01—T53、T54/T55 层级作为历史保留，[publication.json](../superagent/publication.json)仍是该批次原始发布记录，不覆盖为 R5 数据。
- 维护者于 2026-11-14 批准这 36 张票，并明确要求先清理远端可关闭的旧 Issue、再发布新票。G01—G14（#15—#28）及旧 T56/#90 因被 R5 替代关闭为 not planned，原正文、子票和实现证据保留；关闭评论链接对应的新票，不将计划退休记作验收通过。
- 总规格 #1、最终验收 T55/#83、真实托管及第二设备验收 T58/#92 保持开放；本轮不改其正文或既有阻塞关系。T55/T58 的旧前置全部关闭也不代表 R5 已具备验收条件，应按 R5 承接票和实际证据判断；暂缓的真实飞书验收不重新列为发布阻塞。

## Wayfinding operations

- 正式地图：[Super-agent 实施前关键技术决策](https://github.com/IceFireIcer/DS-SuperAgent/issues/2)，作为总体规格的原生子 Issue；决策票是地图的原生子 Issue，研究结果出现后可继续添加必要的运行验证决定。
- 地图标签仅 wayfinder:map；决策票按类型只带 wayfinder:research、wayfinder:task、wayfinder:grilling 或 wayfinder:prototype。ready-for-agent 保留给规格/实施票。
- 当前登录开发者为 IceFireIcer。开始工作前用 assignee 认领；有人认领的票不重复接手。
- 子 Issue 使用 GitHub REST 的 issue/sub_issues 接口，新增时传数值 sub_issue_id；原生阻塞使用 issue/dependencies/blocked_by 接口，传阻塞方的数值 issue_id。
- 当前可开始集合由地图未关闭子 Issue、blocked_by 全部关闭、assignees 为空三个条件计算；查询时读取实时状态，不以正文编号列表代替。
- 问题正文保持为 Question；结论写 resolution comment，再关闭并在地图 Decisions so far 增加具名链接与一句话索引，不把完整结论复制到地图。
- 本地镜像与关系清单在 [决策图入口](../superagent/wayfinder/README.md)；研究在 super-agent-references 下保留。
- 用户已确认 dev 从 main 的 7b4009798dd066d06144dfa0ea51b5fec71328a8 建立；研究分支采用 docs/research-*，遵从仓库前缀规则，替代技能默认的研究分支前缀。
