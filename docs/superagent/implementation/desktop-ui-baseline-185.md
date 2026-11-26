# 桌面 UI 整改改前基线（#185）

2026-11-23 · Windows 11 x64（10.0.26200） · 外层探针使用 Node `24.22.3`

在隔离 profile 中复跑 Main、Activity 和设置，取得 29 张窗口截图及 16 组键盘和主题记录。浏览器探针另行复现模型引导与密钥编辑。截图对照保留各运行的构件、状态和复现方式。[#185](https://github.com/IceFireIcer/DS-SuperAgent/issues/185)

## 构件与证据

| 项目 | 实测身份 |
|---|---|
| 比较用源码提交 | `a6d6edc773443ce8322eb5b04e26002189579984`，本地运行前 `dev` 与 `origin/dev` 同步 |
| 实测桌面包 | `app/dist-pack/win-unpacked/DS SuperAgent.exe`，版本 `0.2.5`，Windows x64，内置 DSH `0.2.2-rc.1` |
| `app.asar` SHA-256 | `e1f835cf24a89a999c5e6c53e7192a119fe41bfc8a0091693e2585b03c3116e3` |
| 包内客户端 SHA-256 | `c0b7c0a11403ecbf9def371aaf090958daa74af541ab43b3e1443fba2ab5b031`。探针在启动前核对该值与比较用提交中的生成客户端哈希 |
| 浏览器探针 | Edge Chromium，使用 `app` 装配的客户端 `5edde0814e32971163336d328b5a53f9598fca3bb47961ddcb02507aeefcb5b3d`。此指纹对应本机已有设置动效改动 |
| 桌面截图元数据 | `1320×862` CSS px，DPR `1.5`，`visualScale: 1`，探针未改变页面缩放，默认语言中文 |
| 新清单 SHA-256 | `7d3143531004d5853f3c8a221daabcee63e658895bda60993adde1cc986b8b9d`。它记录本次 29 张图的场景与目标 |

客户端指纹确认了比较用 UI 的源码身份。现有 Windows 解包构件的完整构建来源以可独立获取的构建记录为准。外部审查素材未提供构件指纹。它的 `manifest.json` 与新清单有相同的设置文件名和视口元数据，仍需原构件或带指纹的原始输出才能建立文件与候选提交的对应关系。

## 代表路径与结果

| 路径 | 操作 | 改前观察 |
|---|---|---|
| Main 已配置并发送 | 启动使用 mock 模型的新实例。选中获准目录，聚焦输入框，输入夹具文本并按 Enter | 首屏显示 Main 就绪。输入区重复显示「与 Main 对话」，目录、目标及语音/附件聚在下方。模型收到输入，原生历史显示输入和对应回复，产品历史两项均为 `completed` |
| Activity 空态 | 在已有模拟 Main 收发的实例选择「活跃度」 | 当前页和侧栏入口高亮。可见只读标记、Router/Worker 历史搜索、返回 Main 和无活动提示。通用浏览器夹具另确认有运行记录时观察可读、写入被拒绝 |
| 通用及设置落点 | 从 Main 打开设置，进入 General，再逐个选择父页和四组页签 | 默认通用可见。设置遮罩覆盖 Main，长导航自身滚动，外观字段为横向设置行。21 个父页和四组页签对应的 25 个落点均截取到画面 |
| 设置键盘与窗口 | 用目录和 Account 菜单进入相应操作，打开 Models，验证逐层 Esc、外部点击和复原焦点 | 580 和 1120 宽度的四主题浅深共 16 组通过。浅色使用普通动效，深色模拟减少动态效果。菜单可见焦点、越界检查、Account Tab、逐层 Esc、点外部关闭均通过 |
| 模型引导和密钥 | Edge 探针对供应商配置读取和写入使用合成响应，从 Main 打开登录提示并取消，再键盘打开、取消及保存 API key | 取消后回到原入口，模拟保存后引导收起，原 Main 草稿保留，焦点回到输入框。浏览器使用上表指纹，登录校验限于入口打开和取消。真实账号和真实模型验证仍待相应环境 |
| 桌面进程与数据 | 在程序临时副本上验证产品设置、关闭窗口后保留 Host、重开同一窗口、正常退出和隔离夹具 | 包探针确认旧 renderer 存储及旧数据夹具隔离。应用自然退出，退出码 `0` |

## 审查素材的 29 项对应

同名标记表示本次桌面包在相同设置落点采集到同名文件。此表按页面和状态定位，页面内容及像素会随夹具、版本和主题变化。General、Models 等落点按现行显示名进入。

| 审查截图 | 目标或触发方式 | 本次状态与证据 |
|---|---|---|
| `MainPage.png` | 打开 Main。在缺模型状态观察配置引导 | 桌面 `01-main-chat-default.png` 覆盖已配置后的空对话。缺模型引导由 Edge 的合成供应商场景复现 |
| `MainPage2.png` | Main 输入区 → 展开「执行目标」 | 桌面默认图确认目标字段。16 组键盘探针验证相邻的自定义工作目录菜单。原生执行目标下拉展开画面待补，用隔离桌面窗口打开原生 Select 后进行窗口捕获 |
| `Main填入DS密钥.png` | Main 缺供应商凭据 →「填入 DeepSeek API key」 | Edge 用合成响应复现打开、取消、模拟保存和焦点返回。桌面包补图需提供无模型或缺凭据的隔离 profile 与可写供应商夹具 |
| `Activity活跃度.png` | 侧栏或主视图标签 → 活跃度 | 采集为 `02-main-activity-活跃度.png`，确认只读空态 |
| `05-settings-通用.png` | 设置 → 通用 | 同名，外观与实例默认目录 |
| `06-settings-模型.png` | 设置 → 模型 | 同名，供应商与凭据状态 |
| `07-settings-角色.png` | 设置 → 角色 | 同名，角色配置与指令 |
| `08-settings-智能体预设.png` | 设置 → 智能体预设 | 同名，预设入口 |
| `09-settings-内置插件.png` | 设置 → 内置插件 | 同名，插件清单 |
| `10-settings-连接器.png` | 设置 → 连接器 | 同名，连接器配置入口 |
| `11-settings-即时通信.png` | 设置 → 即时通信 | 同名，平台与连接配置 |
| `12-settings-手机.png` | 设置 → 手机 | 同名，桌面侧访问与设备配置 |
| `13-settings-浏览器-浏览器资源.png` | 设置 → 浏览器 → 浏览器资源 | 同名，资源配置 |
| `14-settings-浏览器-浏览器插件.png` | 设置 → 浏览器 → 浏览器插件 | 同名，运行模式设置 |
| `15-settings-电脑操控.png` | 设置 → 电脑操控 | 同名，电脑操控设置 |
| `16-settings-能力库.png` | 设置 → 能力库 | 同名，能力与 MCP 区块 |
| `17-settings-执行策略.png` | 设置 → 执行策略 | 同名，默认目标、环境及所需能力 |
| `18-settings-定时任务-日程.png` | 设置 → 定时任务 → 日程 | 同名，日程来源 |
| `19-settings-定时任务-定时任务.png` | 设置 → 定时任务 → 定时任务 | 同名，任务列表及入口 |
| `20-settings-主动准备.png` | 设置 → 主动准备 | 同名，规则、暂停与历史 |
| `21-settings-监督.png` | 设置 → 监督 | 同名，巡检与监控状态 |
| `22-settings-记忆.png` | 设置 → 记忆 | 同名，搜索与记录操作 |
| `23-settings-用量-用量.png` | 设置 → 用量 → 用量 | 同名，用量区块 |
| `24-settings-用量-状态.png` | 设置 → 用量 → 状态 | 同名，产品状态与备份 |
| `25-settings-密钥-密钥.png` | 设置 → 密钥 → 密钥 | 同名，密钥表单 |
| `26-settings-密钥-凭据资源.png` | 设置 → 密钥 → 凭据资源 | 同名，凭据资源入口 |
| `27-settings-远程客户端.png` | 设置 → 远程客户端 | 同名，授权客户端入口 |
| `28-settings-反馈.png` | 设置 → 反馈 | 同名，反馈及诊断入口 |
| `29-settings-简介.png` | 设置 → 简介 | 同名，产品信息 |

原素材实际目录有 29 张 PNG。四张主界面文件使用表中的命名，与其清单的四个主视图文件名不同。此轮实际补拍了 `03-main-work-工作.png` 和 `04-main-trace-轨迹.png`，两者均为当前隔离运行的样本。历史截图与同候选回归所需的进行中和失败画面仍需各自留证。

## 复跑方式

在比较用提交的干净检出根目录用 Node 24 运行，选择与该提交客户端匹配的 Windows 解包构件。`GITHUB_SHA` 让现有探针核对提交及包内客户端。探针复制程序到临时目录，给桌面、Shell、workspace 和个人 DSH 替身各自准备隔离路径，并启动本机 mock。文件名和路径中包含本机信息的原始截图保存在本地临时目录，随团队共享的证据使用脱敏后的产物。

```powershell
$env:GITHUB_SHA = (git rev-parse HEAD).Trim()
$env:DESKTOP_VISUAL_DIR = Join-Path ([System.IO.Path]::GetTempPath()) 'ds-superagent-ui-185-visuals'
node app/scripts/check-packed.mjs '<Windows 解包构件路径>\DS SuperAgent.exe' --coexistence
```

### 本地全窗口截图复跑

此命令依赖本机已有的工作区探针版本。第一次运行在 General 等待超时，因为新增的截图代码依赖 `.bt-settings-pane`，比较用提交在 General 直接渲染正文。复跑从工作区探针取两个截图入口，在进程内以正文区可见子节点等待和结算。键盘与主题走 `a6d6edc7` 提交中的原有探针。外层探针和截图源码对应的 SHA-256 分别为 `42cf8255c6a7355e45d303a12f862467796656904f00c3e927ddb862f311401b` 和 `66f332566cd224f1b2dc02fb5f519f77c524916d4899a37a1828a6ae97363d0e`。在该本地版本和比较用 `HEAD` 下，从源码根目录运行以下兼容调用。

```powershell
$baselinePackage = (Resolve-Path -LiteralPath 'app/dist-pack/win-unpacked/DS SuperAgent.exe').Path
$env:GITHUB_SHA = 'a6d6edc773443ce8322eb5b04e26002189579984'
$env:DESKTOP_APPLICATION_SCREENSHOTS_DIR = Join-Path ([System.IO.Path]::GetTempPath()) 'ds-superagent-ui-185-application'
$env:DESKTOP_VISUAL_DIR = Join-Path ([System.IO.Path]::GetTempPath()) 'ds-superagent-ui-185-visuals'
@'
import { execFileSync } from 'node:child_process'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'

const probe = new URL('./app/scripts/check-packed.mjs', import.meta.url)
const visuals = new URL('./check-packed-visuals.mjs', probe)
const original = execFileSync('git', ['show', `${process.env.GITHUB_SHA}:app/scripts/check-packed-visuals.mjs`], { encoding: 'utf8' })
const current = readFileSync(visuals, 'utf8')
const start = current.indexOf('export async function captureInitialMainScreenshot')
const end = current.indexOf('export async function checkPackedVisuals', start)
if (start < 0 || end <= start) throw new Error('Screenshot exports not found')
const capture = current.slice(start, end)
  .replaceAll('.bt-settings-scroll > .bt-settings-pane:not([hidden])', '.bt-settings-scroll > :not([hidden])')
registerHooks({ load(url, context, nextLoad) {
  return url === visuals.href
    ? { source: `${original}\n${capture}`, format: 'module', shortCircuit: true }
    : nextLoad(url, context)
} })
process.argv.splice(1, 1, probe.pathname)
await import(probe)
'@ | node --input-type=module - $baselinePackage --coexistence
```

### 隔离浏览器复跑

隔离浏览器路径使用现有产品 profile 探针，覆盖从 Main 切到 Activity、Work 和设置等路径。先记录 `app` 实际装配的客户端指纹。Edge 通道需在本机可用，也可用探针支持的 Playwright Chromium。

```powershell
$env:PLAYWRIGHT_CHANNEL = 'msedge'
node app/scripts/check-superagent-profile.mjs --check-ui
```

本次浏览器探针退出 `0`，报告 `Product UI passed in Chromium.`，有 3 项观察记录，观察写入拒绝。桌面截图与 `manifest.json` 位于 `%TEMP%/ds-superagent-ui-185-baseline-20261123/compatible/application/`，桌面键盘用例位于同级 `visuals/`。原始运行输出留在本机的 `compatible/packed-check.log` 和基线目录的 `browser-profile.log`，共享时使用脱敏摘要。
