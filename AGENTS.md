# AGENTS.md

Instructions for AI coding agents that work on this repository. Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md), which has the same rules with more detail.

## What this project is

DS SuperAgent has three product layers built on DeepSeek Harness (DSH): Main owns the user conversation, Router turns
accepted work into durable tickets, and independent Workers execute those tickets. The repository has two parts:

- `superagent/`: the single DSH package. Its package root runs the Domain Engine and product Host, `./client`
  provides the existing browser UI, and `./web-search` provides search.
- `app/`: the desktop app for Windows, macOS and Linux. It runs a pinned DSH with `ds-superagent` in one
  product profile and its own `DSH_HOME`; it never writes the user's `~/.dsh`.

Main, Router and Worker run as separate DSH Agent Sessions. Accepted work keeps durable work identity, authority,
execution generation and delivery facts. The product does not load the former roster, group/round, Bot-to-Bot,
production Bot governance, old history or profile-switch compatibility runtime.

## Hard rules

1. **Build on DSH; never patch it.** Bot features use the documented plugin APIs. The desktop app starts DSH only through its documented entry points (`@deepseek-ai/dsh/profile-boot`, the `dsh` CLI). Never patch DeepSeek Harness or depend on files inside a DSH install. If something is missing in DSH, stop and say so; do not work around it with a patch.
2. **No secrets.** Never write, print or commit API keys, tokens, cookies or `DSH_HOME` contents. Use the mock model (`superagent/dsh/dev/mock-llm.mjs`) for tests; it needs no key.
3. **Only original material.** Do not copy code, text, icons, logos or graphics from other products or websites. Code under a license compatible with Apache 2.0 is the only exception: say where it comes from and add its notice to the `NOTICE` file.
4. **`client.js` is generated.** Change `superagent/dsh/src/client/`, then run `npm run build` in `superagent/` and commit the generated `superagent/dsh/client.js`. Never edit it by hand.
5. **Do not touch the user's own DSH data.** The desktop app keeps its data in its own `DSH_HOME`; its import only reads `~/.dsh` and never writes there. The test bench keeps its data in `.dsh-test-<name>/`. Never point a test at `~/.dsh`, at the desktop app's data or at a DSH that the user runs.
6. **Preserve the existing product UI.** Do not create a renderer, replacement desktop surface, or alternate frontend. Integrate the Super-agent core through documented DSH APIs and the existing product protocol (`/api/product`, client events, Main history/work cards, questions and delivery history). Changes to `app/`, `superagent/dsh/src/client/` or `superagent/dsh/client.js` require an explicit user request for that UI change.

## Commands

Run package commands in `superagent/`. `DSH_HARNESS` can point source-resolving tests at a DeepSeek Harness checkout.

```sh
npm ci                                 # package dependencies
npm run build                          # TypeScript + dsh/client.js + dsh/office.js
npm test                               # Server and browser-side tests
node dsh/scripts/build-client.mjs --check
npm run lint                           # oxlint
node ../scripts/check-ui-boundary.mjs --base origin/dev  # UI files need DS_SUPERAGENT_UI_CHANGE_APPROVED=1
```

Run `npm run typecheck`, `npm run build` and `npm run lint` in `superagent/` after Engine or Host changes. Run
`npm test` in `app/` after profile, lifecycle or packaging changes. A product-profile boot on throwaway data is
`node app/scripts/check-superagent-profile.mjs`; use it for assembly changes that need more than unit tests.

On Windows, run `npm`, `node` and the repository's `.mjs` wrappers in PowerShell. Prefer the `.mjs` scripts over
ad-hoc multi-line shell commands for long checks.

Targeted checks are the normal ticket loop. Run the checks for every changed package before committing. Full CI is a
release gate unless the current ticket says otherwise. Before committing UI changes, run the UI boundary check; it
lists changes under `superagent/dsh/src/client/` and `superagent/dsh/client.js` and fails unless the user asked for
that UI change and the check runs with `DS_SUPERAGENT_UI_CHANGE_APPROVED=1`.

## Branches, pull requests and issues

The full workflow is in [CONTRIBUTING.md](CONTRIBUTING.md#how-we-work). The parts that an agent must follow:

- Work directly on `dev` for daily changes; only `dev` and `main` stay long-lived. If a change needs isolation or review, start a short-lived `fix/<issue>-<name>`, `feat/<issue>-<name>`, `docs/<name>` or `chore/<name>` branch from the latest `dev`, open the pull request into `dev`, and delete the branch locally and on `origin` after merge. Never start a branch name with `dev/`. Only releases and hotfixes go into `main`.
- Bring a work branch up to date with `git merge dev`. Never rebase a pushed branch and never force-push.
- Fill in the pull request template. Link the issue with `Fixes #<number>`; a bug fix names the bug it fixes. Write the user-visible change in the Changelog field, and do not edit `CHANGELOG.md`.
- Do not start work on an issue or pull request with the `maintainer` label; it waits for the maintainer. Do not take an issue that someone else is assigned to.
- Before you change behavior, read the design for it in `docs/plans/` (and `docs/vision.md`); for interface work also `docs/design/ui-standard.md`. A change to a decided design needs the maintainer; a new large feature adds its design note to the same pull request.
- Do not close an issue without evidence: the pull request or commit that fixed it, the issue it duplicates, or the reason it will not be fixed.
- To triage issues, follow [.agents/skills/issue-triage/SKILL.md](.agents/skills/issue-triage/SKILL.md).
- To record a demonstration GIF for an interface change, follow [.agents/skills/record-browser-gif/SKILL.md](.agents/skills/record-browser-gif/SKILL.md).

## Layout

- `superagent/src/`: the business Engine, Host, persistence, execution and retained capability adapters.
- `superagent/dsh/src/client/`: the existing DSH browser surface for Main, work cards and product settings.
- `superagent/dsh/office.js` and `superagent/dsh/src/office/`: the Office tooling.
- `superagent/dsh/web-search.js`: the `auto` web-search provider.
- `superagent/test/` and `superagent/dsh/test/`: Engine, product UI, Office and search tests.
- `superagent/dev/` and `superagent/dsh/dev/`: test fixtures, the minimal model mock and retained utilities.
- `app/`: the desktop app, one DSH product profile, data isolation, lifecycle and packaging.

## Style

- Follow the code around your change. Keep functions small and names plain.
- Write a comment only when the reason is not clear from the code: a hidden constraint, an invariant, a workaround. Do not describe what the code does.
- Commit messages in English, imperative subject, the reason in the body. Keep commits small.
- The person who asked for the change is the commit author. Do not set an AI agent or bot as author or committer, and do not add `Co-authored-by` lines for one.
- User-facing text in the plugin is English. Keep the README and README.zh.md in step when you change one of them.
