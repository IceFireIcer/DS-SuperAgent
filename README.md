<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo.svg" alt="DS SuperAgent" width="260">
  </picture>
</p>

# DS SuperAgent

English | [中文](README.zh.md)

Created and maintained by [IceFireIcer](https://github.com/IceFireIcer).

![version](https://img.shields.io/badge/version-R5_preview-blue) ![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-4D6BFE) ![license](https://img.shields.io/badge/license-Apache_2.0-green)

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

## Connect a phone

The [Expo companion](mobile/README.md) connects to Main through an encrypted relay. Pairing is read-only unless the
computer explicitly grants message sending. The phone cannot manage desktop controls, credentials or files.
Build the companion from source; this repository does not provide a mobile store release.

## Run the desktop app

The [desktop packages](app/README.md) install **DS SuperAgent** on Windows, macOS and Linux. On Windows you can also launch from source:

```powershell
.\start.ps1
```

The first start asks for a data location and workspace, defaulting to `~/.ds-superagent` and `~/DS SuperAgent`, then
opens Main. In Settings, configure the provider credentials and select models for Main, Router and Worker before
sending work. Data from previous product installs and personal DSH files stay in their original locations.

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
| `mobile/` | Expo companion for pairing, Main chat and read-only work status |
| `docs/superagent/` | R5 specification, implementation records and environment evidence |

R5-34 removed the former roster, group/round, peer-agent, team governance, native-history, activation/reversal and
dual-profile paths. The existing client and Office/web-search capabilities now live in the `dsh/` part of `ds-superagent`; this repository
does not ship a second renderer, standalone app engine or separate DSH plugin.

## License

[Apache-2.0](LICENSE)
