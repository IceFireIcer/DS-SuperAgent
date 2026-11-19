# 参与 DS SuperAgent 开发

[English](CONTRIBUTING.md) | 中文

感谢参与。本文说明团队怎么协作、怎么搭环境、怎么测试改动，以及改动必须遵守的规则。产品行为和安装方式见 [README.zh.md](README.zh.md)。

## 谁可以提 Pull Request

本仓库的协作者直接在这里推分支，向 `dev` 提 Pull Request（见[协作方式](#协作方式)）。目前只有协作者能提 Pull Request。如果你不是协作者，发现 bug 请开 Issue（见[报告问题](#报告问题)），提问或建议请到 [Discussions](https://github.com/IceFireIcer/DS-SuperAgent/discussions)。

## 最重要的规则

1. **基于 DSH 构建，不改 DSH。** 使用 DSH 有文档的插件接口（Cordis 服务、客户端入口和 profile patch）。桌面应用只通过 DSH 有文档的入口启动 DSH（`@deepseek-ai/dsh/profile-boot`、`dsh` 命令）。不依赖 DSH 安装目录里的私有文件。若 DSH 缺少所需接口，记录缺口并停在该边界。
2. **Main、Router 和 Worker 使用 DSH Agent Session。** Main 管理主对话；Router 创建持久工作 Ticket；独立 Worker 执行已分配工作。产品状态和权限由 Engine 管理，不另建 Agent 运行时或绕过 Engine 的 Session 写入口。
3. **任何地方都不放真实密钥。** 不要提交 API key、token、cookie、`DSH_HOME` 目录、日志，或带个人信息的截图。测试和测试台用脚本化的模拟模型，不需要密钥。
4. **只用原创素材。** 不要从其他产品或网站复制代码、文字、图标、logo 或其他图形。唯一例外是与 Apache 2.0 兼容许可的代码：注明出处，并把它的声明加进 `NOTICE` 文件。
5. **每个改动都要测试。** 每个改动都要跑单元测试和客户端检查（见[测试改动](#测试改动)）。

## 协作方式

团队里谁都可以做任何工作：分诊、修 bug、做功能、改界面、写文档。只有一部分决定归维护者：产品方向、改动已定的设计、这些规则、发版和架构。需要这类决定的 Issue 和 Pull Request 带 `maintainer` 标签；开工前先等维护者回复。参见[产品愿景](docs/vision.zh.md)、[R5 规格](docs/superagent/spec-r5.md)、[设计记录](docs/plans/)和 [UI 标准](docs/design/ui-standard.md)。拿不准是 bug 还是设计如此时，先查这些文档，再在 Issue 里问。

### 分支

| 分支 | 用途 | 谁来合并 |
|---|---|---|
| `dev` | 集成分支。所有修复和功能先进这里 | 所有协作者，CI 通过即可 |
| `main` | 只放已发版的代码。维护者发版时把 `dev` 合进来，或合入热修 | 维护者 |
| `fix/<Issue 号>-<短名>`、`feat/<Issue 号>-<短名>`、`docs/<短名>`、`chore/<短名>` | 你的工作分支。从最新的 `dev` 切出 | — |

- 分支名不要以 `dev/` 开头。有 `dev` 分支时，Git 建不了 `dev/<名字>`。
- 同步分支用 `git merge dev`（热修分支用 `git merge main`）。已推送的分支不要 rebase，也不要强推。
- 默认分支是 `main`，所以 GitHub 新建 Pull Request 时默认的 base 是 `main`。请改成 `dev`。

### Issue

1. **分诊。** 给每个新 Issue 打类型、优先级和领域标签（见[标签](#标签)）。每个 Issue 只有一个优先级标签。具体步骤和列出待分诊 Issue 的脚本见 [.agents/skills/issue-triage/](.agents/skills/issue-triage/SKILL.md)，AI 也可以照着做。
   - 是提问（怎么装、怎么用）：选 **Convert to discussion**，转到 Q&A 分类。
   - 信息不够，找不到原因：加 `needs-info`，写清楚还缺什么。说明 14 天没有回复就关闭。
   - 原因在 DSH 或其他插件：加 `upstream`，并链接到应该处理它的地方。
   - 和已有的 Open Issue 相同：加 `duplicate`，链接原 Issue，关闭这一条。
2. **认领。** 开工前把 Issue 指派（Assign）给自己，并在 Issue 里写「我来做」，避免两个人做同一件事。已经有人认领的 Issue 不要抢；想接手先在 Issue 里问。
3. **功能。** 新想法先在 Discussions（Ideas）里讨论。维护者认可后，再开成带 `enhancement` 标签的 Issue。做功能前，先在 Issue 里写几句打算怎么做。大功能在同一个 Pull Request 里附上设计说明 `docs/plans/<日期>-<主题>.md`。
4. **有证据才关。** 关闭 Issue 时，附上修复它的 Pull Request 或提交、它重复的 Issue，或不修的原因。评论用 Issue 本身的语言。

### 标签

| 维度 | 标签 |
|---|---|
| 类型 | `bug` · `enhancement` · `documentation` |
| 优先级 | `P0` 崩溃、丢数据或无法使用 · `P1` 影响日常使用 · `P2` 一般缺陷或功能 · `P3` 建议或窄场景 |
| 领域 | `area/host` 产品 Host 与 Engine · `area/client` 现有界面 · `area/memory` 记忆与上下文 · `area/browser` 浏览器资源与网页搜索 · `area/build` CI、发版与脚本 · `area/docs` |
| 流程 | `maintainer` 等维护者 · `needs-info` 等报告人 · `upstream` 原因在 DSH 或其他插件 · `duplicate` · `auto-found` 自动测试发现 |

跨多个领域或不属于任何领域的 Issue，不打领域标签。

### Pull Request

1. 向 `dev` 提 Pull Request，按模板填写。用 `Fixes #<号>` 关联 Issue；修 bug 的 PR 一定要写明修的是哪个 bug。
2. 在模板的 **Changelog** 一栏写一句用户能看到的变化，没有就写「无」。不要改 `CHANGELOG.md`：维护者发版时根据这些句子统一写。
3. CI 通过后，自己用 **Create a merge commit** 合并，然后删除分支。不强制审查；想让人看一眼，在 Pull Request 里 @ 队友。
4. 合进 `dev` 的修复不会关闭对应的 Issue：`Fixes #<号>` 只在合入默认分支时生效。Issue 会一直开着，直到发版，意思是「已在 `dev` 修复，尚未发版」。

一个 Pull Request 只对应一个 Issue。大改动拆成多个 Pull Request。

### 合并冲突

- **`superagent/dsh/client.js`**：不要手工解决。先解决 `superagent/dsh/src/client/` 里的冲突，再在 `superagent/` 里运行 `npm run build`，提交新生成的 `client.js`。
- **`CHANGELOG.md`**：Pull Request 不改它，所以不应该冲突。如果冲突了，两边都保留。

### 发版（维护者）

1. 向 `dev` 提一个 Pull Request：修改 `superagent/package.json` 里的版本号，根据已合并 Pull Request 的 Changelog 句子写 `CHANGELOG.md` 的这一版。
2. 提一个从 `dev` 到 `main` 的 Pull Request，标题为 `release: vX.Y.Z`。在描述里列出这一版所有的 `Fixes #<号>`，合并时这些 Issue 会一起关闭。
3. 合并前在 Windows 真机上做一遍[发版前真机检查](docs/dev/release-checklist.md)，改动涉及 macOS 时在 macOS 上也做一遍，结果贴在这个 PR 里。用 merge commit 合并，在 `main` 上发布 GitHub Release `vX.Y.Z`。Release 工作流会检查 tag 与版本号一致、且在 `main` 上，跑完检查后把包发到 npm（预发布版本发到 npm 的 `next` 标签）。不要手动 `npm publish`。
4. 热修：从 `main` 切 `fix/hot-<短名>`，向 `main` 提 Pull Request，发一个补丁版本，再把 `main` 合回 `dev`。

## 搭建环境

需要：

- Node.js `24` 或更高。
- Git。
- 仅产品 profile 检查需要：pnpm `11`，以及受测 DSH 版本的 DeepSeek Harness 源码。

```sh
git clone https://github.com/IceFireIcer/DS-SuperAgent.git ds-superagent
cd ds-superagent/superagent

# 构建和测试依赖。
npm ci
```

产品 profile 检查需要把 DeepSeek Harness 源码放在插件目录旁边（这个目录被 Git 忽略）：

```sh
cd ..
git clone https://github.com/deepseek-ai/deepseek-harness.git
git -C deepseek-harness checkout dsh-v0.2.1-rc.4
(cd deepseek-harness && pnpm install)
```

如果 DeepSeek Harness 源码放在别处，把 `DSH_HARNESS` 设为它的路径，供从源码解析 DSH 包的测试使用。

## 目录结构

| 路径 | 内容 |
|---|---|
| `superagent/src/` | Engine、Host、存储、执行与保留能力适配器 |
| `superagent/dsh/src/client/` | 现有 Main 对话、工作卡与产品设置 |
| `superagent/dsh/client.js` | 由 `dsh/scripts/build-client.mjs` 从 `dsh/src/client/` 生成。它被提交进仓库，这样用 Git 安装时不需要构建 |
| `superagent/dsh/web-search.js` | `auto` 网页搜索提供方 |
| `superagent/cordis.patch.yml` | 唯一包自带的 DSH bundle patch |
| `superagent/test/`、`superagent/dsh/test/` | Engine 与产品客户端测试 |
| `superagent/dev/`、`superagent/dsh/dev/` | 隔离开发夹具与最小产品模拟模型 |
| `app/` | 单一产品 profile、Electron 外壳、数据隔离、生命周期与打包 |

## 测试改动

在 `superagent/` 里运行：

```sh
npm run build                          # TypeScript + client.js + office.js
npm test                               # Server 与客户端测试
node dsh/scripts/build-client.mjs --check
npm run lint                           # oxlint
```

CI 对 `superagent/` 的改动运行这些检查。其他作业只在其路径变化时运行；唯一的检查 **Test result** 会核对本次改动需要的作业，任一作业被跳过或未通过都会失败。CI 还会扫描入库的文件，查找密钥、token、个人路径和邮箱，以及只应留在本地的材料。想自己扫描，在仓库根目录运行：

```sh
mkdir -p /tmp/ds-superagent-tree && git archive HEAD | tar -x -C /tmp/ds-superagent-tree && node scripts/scan.mjs /tmp/ds-superagent-tree
```

「must fix」的结果会让 CI 失败；「can stay」的结果仅供阅读。分支规则只要求一项检查 **Test result**，所有检查都通过它才通过。

提交前在仓库根目录运行 UI 边界检查：

```sh
node scripts/check-ui-boundary.mjs --base origin/dev
```

它会列出 `superagent/dsh/src/client/` 和 `superagent/dsh/client.js` 的改动。这些文件必须有明确的 UI 改动请求；确认后才用
`DS_SUPERAGENT_UI_CHANGE_APPROVED=1` 再运行一次。检查会比较工作区和未跟踪文件与基线的差异，所以尚未暂存的编辑也会被发现。

改 Engine 或 Host 时，还在 `superagent/` 执行：

```sh
npm run typecheck
npm run build
npm run lint
```

检查完整产品包装配时，用临时数据运行 `node app/scripts/check-superagent-profile.mjs`。改产品 UI 时运行
`app/` 的 `npm test`、生成客户端一致性和 UI 边界检查。打包应用的快速检查需要模型时使用最小
`superagent/dsh/dev/mock-llm.mjs`；真实模型检查会花 token，必须显式使用临时配置。

## 写改动

- 一个改动只做一件事。
- 不要手改 `client.js`。改 `src/client/`，运行 `npm run build`，两者一起提交。
- 在 `src/client/` 里，颜色用 `--bt-*` 变量，圆角只用 4、6、8、10、12、16、18、20、22、999px 和 50% 这几档，弹簧用 `motion.js` 里的。有单元测试检查这三项。测试之前就写成的地方列在 `test/style-debt.json` 里，这份清单只减不增。改掉一处后，运行 `node scripts/style-debt.mjs --write` 更新清单。
- 跟随改动周围代码的风格。只有当代码本身看不出原因时才写注释。
- 提交说明用英文。标题简短，用祈使句（如 "Keep group replies visible"），在正文里写原因。
- 提交的作者是做出改动的人。用 AI 工具辅助时，不要把它加为作者，也不要加 `Co-authored-by` 行；在工具里关掉这个设置。
- 不要改 [CHANGELOG.md](CHANGELOG.md)。把用户能看到的变化写在 Pull Request 的 Changelog 一栏。

## 报告问题

最简单的方式是在 DS SuperAgent 里：打开 **设置 → 反馈**，写下发生了什么，选 **在 GitHub 上报告**。它会新开一个 Issue，产品和 DSH 版本、系统、模型和最近的错误都已填好。**复制** 会把同样的内容放进剪贴板，**下载** 会保存诊断日志。

手动开 Issue 时，请写上：

- DSH 版本（DSH Desktop 或 `@deepseek-ai/dsh`）、操作系统，以及用的是 DSH Desktop 还是 DSH Web。
- DS SuperAgent 的安装方式（发布包或源码检出）和版本。
- 你做了什么、期望什么、实际发生了什么，报错请贴原文。
- 一张整窗截图，包含聊天和报错。
- 能让问题再次出现的步骤。

DS SuperAgent 会从诊断信息里去掉 API key、token、保存的密钥和你的用户目录。发出前请读一遍，并去掉截图里的个人信息。

安全问题不要开公开 Issue。请在仓库的 **Security** 页使用 **Report a vulnerability**。

Issue 只用来报告 bug。提问、想法和功能建议请发到 [Discussions](https://github.com/IceFireIcer/DS-SuperAgent/discussions)。维护者认可的想法会开成 Issue。

## 许可

DS SuperAgent 使用 [Apache License 2.0](LICENSE)。提交贡献即表示你同意按同一许可授权，如该许可第 5 条所述。
