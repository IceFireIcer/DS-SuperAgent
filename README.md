<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo.svg" alt="DS SuperAgent" width="260">
  </picture>
</p>

# DS SuperAgent

English | [中文](README.zh.md)

![version](https://img.shields.io/badge/version-v1.0.1-blue) ![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-4D6BFE) ![license](https://img.shields.io/badge/license-Apache_2.0-green)

DS SuperAgent is a desktop agent built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
You talk to one assistant. When you hand it a real job, it writes the job down as a ticket, passes it to a worker,
and brings the checked result back into the same conversation. Work survives restarts, and you can see every step.

## Sponsors

<table>
<tr>
<td width="180" align="center"><a href="https://git.hhapi.top/register?aff=5Y7LG3DT4UHM"><img src="docs/images/sponsors/xgit.png" alt="XGit" width="120"></a></td>
<td>XGit is an AI API gateway. Get ¥0.5 in free credit when you sign up, use routes optimized for China Telecom, China Unicom and China Mobile, and top up at a 1:1 rate. QQ Group Number:1136413619 <br>Sign up: <a href="https://git.hhapi.top/register?aff=5Y7LG3DT4UHM">XGit</a></td>
</tr>
</table>

## How it works

| Layer | What it does |
|---|---|
| **Main** | Talks to you. Answers questions, accepts work, asks you when it needs a decision, and reports the result. |
| **Router** | Turns accepted work into a durable ticket and assigns it. |
| **Worker** | Runs the ticket in its own session and submits the result with evidence. |

Main, Router and Worker are separate DSH sessions, each with its own model. You only write to Main; Router and Worker
sessions are visible but read-only. Tickets, assignments, questions and delivery history are stored on disk, so a
restart or reconnect continues where it stopped.

Workers can use files, Office documents, the browser, memory, MCP tools, saved credentials and schedules. Work runs on
this computer or on a paired remote device; the product never switches between them without telling you.

## Install

### Desktop app (Windows, macOS, Linux)

The desktop app ships its own DSH, so you don't need to install DSH first. Download the file for your system from
[Releases](https://github.com/IceFireIcer/DS-SuperAgent/releases/latest):

| System | File |
|---|---|
| Windows x64 | `DS-SuperAgent-<version>-win-x64.exe` |
| macOS Apple silicon | `DS-SuperAgent-<version>-mac-arm64.zip` |
| macOS Intel | `DS-SuperAgent-<version>-mac-x64.zip` |
| Linux x64 | `.AppImage` or `.deb` |

If your system warns about an unsigned app: on Windows select **More info** → **Run anyway**; on macOS open
**System Settings** → **Privacy & Security** and select **Open Anyway**.

### First start

1. Choose a data folder. The default is `~/.ds-superagent`.
2. Open **Settings** → **Models**, add a provider and its API key, then pick a model for Main, Router and Worker.
3. Chat with Main right away. Before you hand over work, create a project and choose its folder; Router and Worker
   stay idle until a project exists.

The app keeps all its data in its own folder. It never writes to your personal `~/.dsh`, and it leaves data from
older installs where it is.

### Docker (NAS, Linux server)

See [`docker/README.md`](docker/README.md).

## Connect a phone

The [Expo companion](mobile/README.md) connects to Main through an end-to-end encrypted relay. A new pairing can only
read; sending messages needs explicit permission on the computer. The phone cannot change desktop settings,
credentials or files. There is no app store release yet; build it from source.

## Run from source

Requires Node.js 24.9 or later in the 24 series.

```powershell
npm --prefix superagent ci
npm --prefix superagent run build
npm --prefix app ci
npm --prefix app start
```

On Windows, `.\start.ps1` does the same in one step. Details, environment variables and packaging are in
[`app/README.md`](app/README.md).

To use the package in your own DSH profile without the desktop app, link [`superagent/`](superagent/README.md) and
list `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app` and `ds-superagent` as profile bundles.

## Development

Run checks for the package you changed:

```powershell
npm --prefix superagent run typecheck
npm --prefix superagent run build
npm --prefix superagent test
npm --prefix superagent run lint
npm --prefix app test
node app/scripts/check-superagent-profile.mjs   # boots the real profile on throwaway data
```

Tests use the mock model in `superagent/dsh/dev/mock-llm.mjs` and need no API key. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and [docs/vision.md](docs/vision.md) for the
product direction.

| Directory | Contents |
|---|---|
| `superagent/` | The `ds-superagent` DSH package: Engine, Host, persistence, client UI, Office tools and web search |
| `app/` | Electron desktop app: product profile, data isolation, lifecycle and packaging |
| `mobile/` | Expo phone companion |
| `docker/` | Docker image for NAS and servers |
| `docs/` | Vision, designs, specifications and release records |

## Disclaimer

DS SuperAgent is an independent community project. It is not an official DeepSeek product and is not affiliated with,
endorsed by or sponsored by DeepSeek. "DeepSeek" and "DeepSeek Harness" are trademarks of their owners.

## License

[Apache-2.0](LICENSE). Created and maintained by [IceFireIcer](https://github.com/IceFireIcer).
