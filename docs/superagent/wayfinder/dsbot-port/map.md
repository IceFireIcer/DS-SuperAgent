## Destination

把 DS-Bot 0.3.8 的整套前端与功能迁移到 DS SuperAgent，形成决策完备、可直接拆实施票的规格：单一 `POST /api/product`、页面与功能不裁剪、复制代码全量改名、SuperAgent 专有 UI 统一 DS-Bot 0.3.8 视觉、DSH 升级到官方 `0.2.2-rc.1`。

## Notes

- 基线：上游 `temp\DS-Bot` @ `5e9b7da8`（ds-bot 0.3.8）；本仓库 `dev` @ `e77b2397`。
- 本地依据（未提交）：`temp\explore\port-plan.md`、`port-manifest.md`、`api-adapter-v2.md`、`client-adapter-design.md`、`product-backend-plan.md`、`settings-parity.md`、`style-parity.md`、`dsh-compat.md`、`integration-design.md`、`gap-map.md`。
- 已定、不重新投票：单一 `/api/product`，不新增 `/api/bot`；不裁剪页面；DSH 只用公开 API；复制进 superagent 的代码全量改名而 `temp\DS-Bot` 不动；`app/ui`、`app/engine` 不搬。
- 图与票只用 `wayfinder:*` 标签；票是决策的正式记录，本地草稿在 `docs/superagent/wayfinder/dsbot-port/`。
- 每张票按标签类型执行；一次会话只解决一张，研究票可并行。

## Decisions so far

- [确定首版与全量 C 域范围及里程碑](https://github.com/IceFireIcer/DS-SuperAgent/issues/136#issuecomment-7001661411)：DS-Bot 代码/功能/UI 整体搬并适配 `/api/product`；排除 Bot/Bot 模型/头像库/群聊/本地 Agent/团队权限，保留成员状态与任务板；连接器与 IM 全搬；不锁总人日；三段交付。
- [敲定命名、存储键与桥名的迁移边界](https://github.com/IceFireIcer/DS-SuperAgent/issues/138#issuecomment-7001732375)：保留 `bt-` 设计前缀；只用 `ds-superagent:*`，不读不迁不删 `ds-bot:*`；旧环境变量不兼容；桥名直接改、不留别名；仅 NOTICE 与来源注释白名单。
- [设计 C 类 product endpoint 族边界与首批样板](https://github.com/IceFireIcer/DS-SuperAgent/issues/140#issuecomment-7001829136)：按读模型/命令边界聚合成 35 族（≈175 点）；保留 session-changes/side-chat/learning/attention-dismiss；远程全部允许（含写与设备操控）；首批 connector-registry/connector-auth/usage-breakdown；`botId` 改 `scope`。
- [确定远程客户端执行写命令与设备操控的授权边界](https://github.com/IceFireIcer/DS-SuperAgent/issues/141#issuecomment-7001910604)：三档 `read`/`command`/`device`，默认仅 read；设备接管与 OAuth 需 Host 本机确认；审计 90 天/1 万条；OAuth 回调仅 Host；撤销立即阻断，本地专属动作永不上远程。
- [确定桌面壳、手机/link、浏览器插件与电脑操控的搬迁顺序](https://github.com/IceFireIcer/DS-SuperAgent/issues/139#issuecomment-7001969734)：桌面壳整包搬；手机先 link+relay、Expo App 后置；浏览器插件与页面同批；电脑操控 host+悬浮层+CUA 同批；阶段②顺序 deck→连接器→IM→能力→手机→浏览器→电脑。
- [原型验证产品页与 DS-Bot 视觉系统的一致性](https://github.com/IceFireIcer/DS-SuperAgent/issues/134#issuecomment-7002213537)：通过；4 主题×浅/深、7 强调色、3 动效档、内容字号 12–18px；8 个共享组件接口定稿；排除页完全不渲染；派生 token 挂 documentElement。
- [升级 DSH 到官方 0.2.2-rc.1 并记录验证事实](https://github.com/IceFireIcer/DS-SuperAgent/issues/132#issuecomment-7002471286)：app/superagent 实为 0.2.1-rc.4；已升 0.2.2-rc.1 + Cordis 4.1.0 + group 1.1.0；superagent 构建/客户端测试、app 包测试、profile boot 通过；app 全量测试未跑；Node 25 限制。
- [原型验证会话根、cell 渲染与 MainComposer 接管](https://github.com/IceFireIcer/DS-SuperAgent/issues/133#issuecomment-7002480619)：删 main.conversation shadow；Main 转录用 DSH Session；composer select 互斥；工作卡挂 turnTail；观察页挂 conversation.view；运行验证转实施验收门。
- [确定成员状态与任务板的语义映射](https://github.com/IceFireIcer/DS-SuperAgent/issues/135#issuecomment-7002590271)：Main/Router 固定，Worker 按活跃 Session 动态出现；任务板聚合所有 Work Items；状态映射 running/waiting-delivery/waiting-human/delivered/stopped；取消→work-stop，备注→用户跟进；成员 dock + Work 视图。
- [确定设置导航树与冲突页归属](https://github.com/IceFireIcer/DS-SuperAgent/issues/137#issuecomment-7002657214)：五组导航；浏览器/定时任务/用量/密钥一页两 Tab；角色与模型分开；成员/任务板不进设置；客户端授权改名远程客户端。

## Not yet specified

无。本图的决策已足以产出迁移规格；实施期参数与手机 App 协议细节见 Out of scope。

## Out of scope

- 在本图内实现功能、写产品代码或迁移真实用户数据。
- 修改 `temp\DS-Bot`、DSH 安装或依赖非公开接口。
- 新增 `/api/bot` 第二协议、第二渲染器、`app/ui`。
- 重新设计 DS-Bot 视觉风格（以 0.3.8 为基准）。
- 与旧核心绑定的团队面：Bot 列表/创建/编辑、Bot 模型、头像库、群聊/群设置/群搜索、本地 Agent、团队权限。
- 本图不决定实施期参数：性能/包体积目标、上游持续同步节奏、手机 App 的 product 协议细节（转入实施切片，link/phone relay 落地后再定）。
