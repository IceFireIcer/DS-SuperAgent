# Desktop release foundations (#203-#207)

## Result

- #203: first start asks only for the product data folder. Without a project, Main stays available and
  Router/Worker start no Ticket. The existing sidebar directory control remains the explicit project
  selection path; canceling it leaves Main running without a fallback directory.
- #204: Router notifications use a per-Ticket scope, so independent Tickets can overlap. A covered
  integration case starts two Workers, keeps one waiting for an answer while the other reports and
  delivers, sends a normal Main message, then resumes only the answered Ticket.
- #205: a Ticket can carry exact path grants with separate read, write, search and command operations.
  A Worker can request an outside path while its Ticket is `waiting-human`; only the exact approval
  option on that question adds the grant. Existing valid grants survive the answer, and a later
  direction change retires them.
- #206: update checks and downloads remain automatic, but installation waits for an explicit choice.
  Later, quit, startup failure and installer failure do not change the installed version.
- #207: one fail-closed build record binds the five desktop artifacts to one full commit SHA, version,
  platform, architecture, distribution form and SHA-256. A complete record declares neither package
  acceptance nor platform support.

## Verification

Run from the repository with Node 24.22.3. The focused suites were serial.

- Super-agent path, Attention, parallel delegation, concurrency, Main control and startup:
  `29/29` and the later path/background regression `32/32`.
- Desktop first start, no-project Main, update confirmation/failure, backups and build record:
  `73/73`.
- `npm run typecheck`, `node scripts/build.mjs` and `npm run lint` pass. Lint reports only existing
  warnings outside this change.
- Full CI and real candidate-package acceptance were not run under the requested bounded scope.

## Boundaries

- Failed-install rollback and previous-version restoration are #208, not part of #206.
- Path grants govern the typed local file/search tools and the working directory of commands. The
  product still exposes an explicitly enabled arbitrary Shell to local Workers; this is an
  environment-level capability, not an OS sandbox. It must not be described as a hard filesystem
  boundary.
- The build-record tests prove matrix validation and artifact generation logic. They do not prove
  that any published package runs, and they do not declare Windows, macOS or Linux support.
