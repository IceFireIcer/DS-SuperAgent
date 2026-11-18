# The vision of DS SuperAgent

English | [中文](vision.zh.md)

DS SuperAgent is a three-layer agent product built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Main owns the conversation and user intent. Router turns accepted work into durable tickets. Independent Workers execute those tickets and return verifiable results.

The product runs as one DSH package named `ds-superagent`, either in a compatible DSH profile or in the desktop app. The desktop app supplies a pinned DSH, its own profile and isolated data folders. Both forms use the same Engine, Host and existing DSH client surface.

## Product principles

- **One source of authority.** Main owns user intent; durable work, authority, assignment and delivery facts belong to the Engine.
- **Work is inspectable.** Tickets, assignments, questions, evidence and results remain visible across restarts and reconnects.
- **Execution is explicit.** Work runs in a selected local or paired remote environment with required capabilities; the product does not silently switch execution worlds.
- **Capabilities keep their boundaries.** Files, Office, browser resources, memory, MCP tools, credentials, schedules and external sources use explicit product commands and authorization.
- **Data stays under the user's control.** The desktop app uses its own data root and does not write to the user's `~/.dsh`.
- **Done means checked.** Targeted behavior tests verify changes; platform and external-service claims require evidence from those environments.

## Who sets the direction

The maintainer decides product direction, changes to decided designs, collaboration rules, releases and architecture. Anyone can do the remaining work; see [CONTRIBUTING](../CONTRIBUTING.md#how-we-work).
