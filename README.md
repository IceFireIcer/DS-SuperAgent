<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo.svg" alt="DS SuperAgent" width="260">
  </picture>
</p>

# DS SuperAgent

English | [中文](README.zh.md)

Created and maintained by [IceFireIcer](https://github.com/IceFireIcer).

![version](https://img.shields.io/badge/version-R5_preview-blue) ![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.4-4D6BFE) ![license](https://img.shields.io/badge/license-Apache_2.0-green)

DS SuperAgent is a three-layer agent product for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). One **Main** stays in the conversation and
owns user intent. A **Router** turns accepted work into durable tickets, and independent **Workers** execute those
tickets with verified results. The existing DSH client interface presents this product directly.

## What the product does

- Main handles chat, follow-ups, questions, stop/resume and the result in one conversation.
- Router and Worker Sessions are automatically discoverable but read-only in the product UI.
- Work keeps a durable Ticket, Assignment, Session and delivery history across Host restarts and reconnects.
- Files, Office documents, browser resources, memory, MCP tools, credentials, schedules, proactive preparation and
  supervision are connected through explicit product commands.
- Execution can use the local Host or a paired remote device with an explicit capability probe. The product never
  substitutes one world silently.
- The app keeps one `ds-superagent` DSH profile, its own data root and an existing DSH Web front end. It never writes
  to the user's `~/.dsh`.

## Run the desktop app

The [desktop packages](app/README.md) install **DS SuperAgent** on Windows, macOS and Linux. On Windows you can also launch from source:

```powershell
.\start.ps1
```

The first start asks for a data location and workspace, defaulting to `~/.ds-superagent` and `~/DS SuperAgent`, then
opens Main. In Settings, configure the provider credentials and select models for Main, Router and Worker before
sending work. Data from previous product installs and personal DSH files stay in their original locations.

### Connectors and mailbox

GitHub and Feishu OAuth applications are Host configuration, not browser settings. Set these variables before starting
the Host:

```text
DS_SUPERAGENT_GITHUB_OAUTH_CLIENT_ID
DS_SUPERAGENT_GITHUB_OAUTH_CLIENT_SECRET
DS_SUPERAGENT_FEISHU_OAUTH_CLIENT_ID
DS_SUPERAGENT_FEISHU_OAUTH_CLIENT_SECRET
```

Register `http://127.0.0.1:38517/callback` exactly as the callback URL in each OAuth application. The callback listener
binds only to `127.0.0.1`; one Host on a machine can use that fixed port at a time. A missing or incomplete application
leaves sign-in disabled with a readable error, and remote clients only receive an opaque login ID and pending/error
state, never the redirect URL, authorization code, PKCE state or token. GitHub can also use a personal access token,
which the Host verifies with GitHub before storing in its credential vault. Feishu authorization uses an existing
Feishu source identity; use the source button on the Connectors page to fill it from Feishu status.

Mailbox accounts use IMAP and SMTP with an app password or authorization code. Presets cover QQ, 163, 126, Gmail and
iCloud; another provider needs explicit server hosts, ports and TLS/STARTTLS settings. Credentials stay in the Host
credential vault and are never returned by the product API. Real OAuth applications and live mailboxes remain separate
environment checks; the mock contract tests do not replace them.

## Run from this checkout

Use Node.js 24.9 or later within the Node.js 24 series. The app installs the single `ds-superagent` product package from this repository:

```powershell
npm --prefix superagent ci
npm --prefix superagent run build
npm --prefix app ci
npm --prefix app start
```

For a DSH profile without the Electron shell, link [`superagent/`](superagent/README.md) and list
`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app` and `ds-superagent` as profile bundles.

## Validate

The repository uses targeted checks for a changed area:

```powershell
npm --prefix superagent run typecheck
npm --prefix superagent run build
npm --prefix superagent run test:client
npm --prefix superagent run lint
npm --prefix app test
```

The product profile check boots the real package assembly on throwaway data:

```powershell
node app/scripts/check-superagent-profile.mjs
```

Real model, Feishu tenant, second-device, hosted PostgreSQL and full four-goal acceptance remain separate environment
gates. Mock UI or unit results do not replace those checks.

## Repository layout

| Directory | Purpose |
|---|---|
| `superagent/` | The single DSH package: Engine, durable business store, Host, product HTTP bridge, existing client UI, Office tools and web-search provider |
| `app/` | Electron shell, single product profile, data isolation, process lifecycle and packaging |
| `docs/superagent/` | R5 specification, implementation records and environment evidence |

R5-34 removed the former roster, group/round, peer-agent, team governance, native-history, activation/reversal and
dual-profile paths. The existing client and Office/web-search capabilities now live in the `dsh/` part of `ds-superagent`; this repository
does not ship a second renderer, standalone app engine or separate DSH plugin.

## License

[Apache-2.0](LICENSE)
