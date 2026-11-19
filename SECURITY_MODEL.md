# DS SuperAgent security model

The baseline for security reviews and repository scans. Infrastructure is in `docker/`.

## System overview and trust boundaries

DS SuperAgent runs on DeepSeek Harness (DSH) as one product profile:

- Main owns the user conversation and source intake.
- Router creates durable Tickets from accepted work.
- Workers execute an Assignment in a local or paired remote Environment.

The desktop app starts the pinned DSH in its own `DSH_HOME`. The Docker image runs DSH Web in a container; the
container is the host-filesystem and process sandbox.

Trust boundaries:

1. Untrusted web, file, GitHub, Feishu, MCP, connector and Worker content can reach a model; model output cannot grant
   authority or bypass Engine policy.
2. User/client commands -> `POST /api/product` or the authenticated client Gateway -> `superagentProduct`.
3. Source identity and actor allowlists are fixed by trusted Host configuration. Request objects cannot replace them.
4. Main/Router/Worker native Sessions run through the public DSH Agent loop and persistent Session provider.
5. Credentials stay in DSH credential records or the Electron main process; business projections contain references,
   never secret values or private keys.
6. Desktop browser pages and imports cross isolated Electron IPC; cookie and credential values stay in the trusted
   main process until the exact authorized write.
7. A local or remote Environment is selected by explicit policy and capability probe; the core does not fall back to
   another execution world silently.

## Components

- **engine/host** — `superagent/src/`: Engine commands, durable TTL/Receipts, Host lease/fencing, execution,
  Sources, Effects, delivery, client access and product Host.
- **client** — `superagent/dsh/src/client/`: the existing DSH UI for Main, work cards and settings; generated
  `superagent/dsh/client.js`.
- **product bridge** — `superagent/src/profile.ts`, `superagent/src/product-http.ts`: `/api/product`, native Session refusal and
  `superagentProduct` dependency.
- **retained capability adapters** — memory, browser resources, MCP, credentials, schedules, Office, attachments,
  remote devices, PostgreSQL Session persistence, Watchdog and Supervisor under `superagent/src/`.
- **desktop app** — `app/src/`: one profile, data isolation, lifecycle, credential/cookie import, browser guest IPC,
  updates and packaging.
- **web search** — `superagent/dsh/web-search.js`.
- **Docker** — `docker/`: DSH Web plus the one product stack; the container is the sandbox boundary.

## Entry points and who reaches them

- User chat/commands are trusted only within the configured Instance and actor allowlist.
- `/api/product` is same-origin and Host-scoped. Client Gateway commands require an enrolled client capability grant.
- External sources are attacker-controlled until authorization and current-source checks pass.
- Native `/api/session/*` and `/api/session.export` are unavailable to the browser product surface.
- Electron IPC validates the sender window and exact pending operation.
- Remote device RPC requires the paired device identity, Environment grant and current Host epoch.

## Assets

1. **Critical: credentials, provider keys and remote Host private keys.** These must not enter business records,
   prompts, logs, UI projections, telemetry or another role's tool world.
2. **Critical: user files and DSH data.** The app never writes `~/.dsh`; product state and workspace paths must not
   overlap DSH or the product core. Remote work must stay in its authorized root.
3. **Critical: work authority.** Ticket/Assignment/Session generations, stop/waiting-human state and Host leases
   prevent an old process or callback from acting as current.
4. **High: browser sessions, attachments, memory and outbound delivery.** They can contain private user data and
   must retain scope, revocation and deletion evidence.

## Attacker profiles

- **Primary:** prompt injection in a source, file, page or tool result causes a role to exceed its authority.
- **Primary:** a stale Host, Assignment, Session writer, command replay or client tries to act after replacement or
  revocation.
- **Secondary:** a compromised remote Device or MCP/browser resource returns stale, forged or unknown results.
- **Secondary:** a Docker/LAN user reaches the Web UI without the intended host/network boundary.

## Controls

- Source actor and Instance authorization are checked inside Engine transactions.
- Host lease, Assignment generation and Session writer epoch fence old work.
- Command IDs are stable; same-ID/different-input is `IDENTITY_CONFLICT`; unknown outcomes stay visible for
  reconciliation.
- Stop, waiting-human, revocation and unknown side effects block automatic retry or reassignment.
- Credential values are redacted and scoped; remote private keys live in DSH credential records.
- Browser operations are resource/grant/lease scoped; write operations require the capability path and human control
  where declared.
- Product native Session list is empty and all other native Session browser access is refused.
- Electron browser guests use isolated partitions with `contextIsolation`; cookie and credential imports are
  value-free until the trusted apply/read step.
- Docker mounts only `/data` and `/workspace`; the container itself is the full-access boundary.

## Accepted risk

- Docker runs the full-access permission preset because the container is the boundary. A compromise inside it is an
  issue; by itself, changing files mounted into `/workspace` is intended.
- DSH is upstream software and is updated or reported upstream; this repository never patches it.
- Real model judgement, real Feishu tenants, second-device networks and hosted combinations require their separate
  environment gates; mock success is not a security acceptance claim.
