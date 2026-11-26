# #214：统一 Main/Router/Worker 角色名与 Roles 设置语义

- 父规格：[#213 侧栏角色卡与只读 Router/Worker 上下文](https://github.com/IceFireIcer/DS-SuperAgent/issues/213)。
- 本票：[#214](https://github.com/IceFireIcer/DS-SuperAgent/issues/214)。

## 范围

- `Main`、`Router`、`Worker` 作为产品名固定为英文，不再进入界面翻译表。
- 侧栏、工作成员、Settings Overview、Memory、Provider、预设、日程、用量和能力设置共用
  `superagent/dsh/src/client/roles.js` 这一个角色名来源。
- 设置分组由 `Team` 改为 `Roles`；打开角色配置仍只编辑 Main/Router/Worker 的模型与指令，
  不切换当前 Main，也不创建新的角色会话。
- 中英文等现有界面语言继续保留，只移除角色名的翻译。

## 实现

- 新增 `roles.js`，导出 `ROLE_IDS`、`ROLE_NAMES` 和 `roleName()`；已知角色返回固定英文名，
  不读取界面语言或服务端标签。
- 移除 `i18n.js` 与 `zh-tw.js` 中的独立角色名条目，并清除所有 `t('Main' | 'Router' | 'Worker')`
  及动态 `t(role)` 调用。
- 设置导航的分组 id 改为 `roles`，Overview 区块和空状态使用同一名称；角色卡仍跳转到
  `roles` 配置页。
- 更新 UI 标准、R4 三层方案和可点击角色卡规格中的角色设置名称。

## 验证

- `node --import ./dsh/test/harness-resolve.mjs --test dsh/test/roles.test.js dsh/test/i18n.test.js`
  ：角色名在中文界面固定为英文，所有字典不存在独立角色名键，**6/6**。
- 设置与工作成员定向测试：`settings-shell`、`product-settings-navigation`、`product-role-draft`、
  `product-model-onboarding`、`product-shell`、`product-work-view`、`work-feedback` 全部通过。
- `npm run typecheck`、`npm run build`、`npm run lint` 通过；`build-client.mjs --check` 通过。
- 串行全量客户端测试运行 244 项，241 通过、1 跳过、2 失败。失败项是
  `style-debt` 的 `product-logo.js` 颜色和 `product-work-directory` 的侧栏目录首帧查询；
  两者都不涉及本票改动的文件，并可在单文件运行复现。

## 边界

- 不修改 ADR 0001 的 Main/Router/Worker 职责或只读边界。
- 不实现 #215—#217 的侧栏角色卡、只读观察页、历史分组或 Router 总览。
- 未运行真实桌面安装包或真实模型验收；本票只完成角色名、设置语义、文档和客户端回归。
