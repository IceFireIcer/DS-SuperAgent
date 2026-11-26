# CI modes

Daily pushes and pull requests into `dev` use a short validation path:

- Repository script tests, implementation evidence checks, legacy naming and the tracked-file leak scan always run. `node scripts/check-product-naming.mjs` checks product filenames and runtime source, including the client, Office and search bundles. Only upstream attribution headers and specific old-data boundary literals are exempt.
- Changed packages run their checks in parallel. The plugin keeps its complete unit tests, generated-client check and lint on Linux with the pinned DSH; the app keeps its profile tests; mobile keeps its typecheck.
- Super-agent typecheck/lint run separately from its tests. Tests run the six product smoke files in `scripts/superagent-ci-tests.mjs`, plus changed test files, tests named after changed modules and tests directly importing a changed module/helper. The log lists the selection. Indirect dependency coverage is deferred to the full gate.
- App installation, update and uninstall matrices and older DSH compatibility checks do not run on daily pushes. Docker build/migration checks run when Docker files change.
- New pushes cancel older daily runs for the same event/ref. npm downloads are cached; installed dependency trees are recreated with `npm ci`.

Full validation ignores path filters. Four Windows shards and one required Ubuntu job together run every Super-agent Server test file. The allocation sends `product-terminal.test.mjs` to Ubuntu for its native PTY lifecycle and puts every other Server test in the Windows shards. The pinned Windows DSH ConPTY provider can retain a `MessagePort` after the terminal process and provider have closed. Native Windows PTY teardown remains an upstream limitation. [Reproduction](../superagent/implementation/r5-17.md#限制)

Full validation also runs the product-client suite, app and mobile checks, Windows/macOS arm64/macOS x64/Linux package checks, and Docker startup and migration checks. The Windows package check uses an isolated profile and fixtures to verify that the app leaves retired renderer storage and former product data alone. Tests retain the existing per-runner concurrency limit because process and PTY fixtures compete for machine resources.

The desktop checks log the candidate SHA, package version, architecture, and fingerprints. They compare the packaged client bundle with the candidate checkout before launching Main. The Linux AppImage and installed deb must both find the authorized fixture workspace before submitting to the mock model. On Windows, the installed app uses a local feed to download the next build, quits normally, and starts again with the same Main, messages, settings, and usage. A separate Windows probe exercises work questions and the two stop actions. The Windows job uploads the desktop visual cases and logs keyboard, focus, and reduced-motion results.

Full validation runs automatically for pull requests into `main` and as a required dependency of `release.yml` for both pre-releases and stable releases, including manual release dry runs. The release workflow cannot publish npm packages or upload release artifacts unless this gate succeeds. The GitHub `release: published` trigger means the release page already exists at that point; the release PR checks provide the validation before that page is published.

For an extra full check on any branch, open **DS-SuperAgent CI → Run workflow**, and enable **full**. A normal manual run uses the daily smoke selection. In both modes, **Test result** fails if a required job fails, is cancelled or is skipped. Release validation requires all jobs in the full matrix to pass.

For a Windows x64 public preview candidate, run the same workflow with **desktop_preview** instead of **full**. It builds only the Windows package, runs the packaged preview probe, and keeps the installer, SHA-256 identity, and probe evidence as artifacts. This path is for candidate acceptance, not a replacement for complete release validation.
