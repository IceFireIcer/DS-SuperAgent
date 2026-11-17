<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo.svg" alt="DS SuperAgent" width="260">
  </picture>
</p>

# DS SuperAgent

English | [中文](README.zh.md)

![version](https://img.shields.io/badge/version-R5_preview-blue) ![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.4-4D6BFE) ![license](https://img.shields.io/badge/license-Apache_2.0-green)

DS SuperAgent is a three-layer agent product for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). One **Main** stays in the conversation and
owns user intent. A **Router** turns accepted work into durable tickets, and independent **Workers** execute those
tickets with verified results. The existing DS Bot interface now presents this product in place.

## What the product does

- Main handles chat, follow-ups, questions, stop/resume and the result in one conversation.
- Router and Worker Sessions are automatically discoverable but read-only in the product UI.
- Work keeps a durable Ticket, Assignment, Session and delivery history across Host restarts and reconnects.
- Files, Office documents, browser resources, memory, MCP tools, credentials, schedules, proactive preparation and
  supervision are connected through explicit product commands instead of the former Bot team runtime.
- Execution can use the local Host or a paired remote device with an explicit capability probe. The product never
  substitutes one world silently.
- The app keeps one `ds-superagent` DSH profile, its own data root and an existing DSH Web front end. It never writes
  to the user's `~/.dsh`.

## Run the desktop app

Windows, macOS and Linux packages are built from [`app/`](app/README.md). The Windows source launcher:

```powershell
.\start.ps1
```

The first start asks for a data location and workspace, then opens the existing DSH interface. Configure a model in
DSH settings before sending work. The app stores product data under its own data location and leaves old DS Bot and
DSH files untouched.

## Run from this checkout

Use Node.js 24. The app installs `ds-bot` and `ds-superagent` from this repository:

```powershell
npm --prefix app ci
npm --prefix app start
```

For a DSH profile without the Electron shell, add both package directories as linked dependencies and list
`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `ds-bot` and `ds-superagent` as profile bundles. See
[`ds-bot/README.md`](ds-bot/README.md) and [`superagent/README.md`](superagent/README.md).

## Validate

The repository uses targeted checks for a changed area:

```powershell
npm --prefix ds-bot run build
node ds-bot/scripts/build-client.mjs --check
npm --prefix ds-bot run lint
npm --prefix superagent run typecheck
npm --prefix superagent run build
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
| `ds-bot/` | Existing client UI, `/api/product` bridge, Office tools and web-search provider |
| `superagent/` | Engine, durable business store, Host, execution adapters and public product commands |
| `app/` | Electron shell, single product profile, data isolation, process lifecycle and packaging |
| `docs/superagent/` | R5 specification, implementation records and environment evidence |

R5-34 removed the old roster, group/round, Bot-to-Bot, team governance, native-history, activation/reversal and
dual-profile compatibility paths. This repository no longer ships a second renderer or standalone app engine.

## License

[Apache-2.0](LICENSE)
