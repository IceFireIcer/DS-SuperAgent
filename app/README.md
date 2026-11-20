# DS SuperAgent desktop app

The Electron app for Windows, macOS and Linux. It installs a pinned DeepSeek Harness (DSH 0.2.2-rc.1), boots the
single `ds-superagent` profile through `@deepseek-ai/dsh/profile-boot`, and keeps its data in its own `DSH_HOME`. It
never writes to `~/.dsh`. Its window shows DSH's existing Web front end with the single `ds-superagent` product
surface. The design is in [docs/plans/2026-10-16-desktop-app.md](../docs/plans/2026-10-16-desktop-app.md).

## Run

```sh
npm --prefix ../superagent ci
npm --prefix ../superagent run build
npm ci
node node_modules/electron/install.js   # when npm did not download Electron (no node_modules/electron/dist)
npm start                               # starts the app
```

When GitHub downloads are slow, set `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` before the Electron download. Unset `ELECTRON_RUN_AS_NODE` before `npm start` if your terminal has it (terminals inside some Electron-based editors do): with it, Electron runs as plain Node and the app does not start.

`npm run runtime` downloads the runtime payload (Python with the document libraries, a standalone Node, the Office skill assets) into `build/runtime`. On Linux, run it before `npm start`: the Host uses this plain Node to keep sharp's libvips out of Electron's process. On macOS and Windows the payload is optional for source runs; without it only the Office skills are unavailable. `beforePack` prepares the payload for every package.

npm installs `ds-superagent` from `../superagent` as a copy of its package files (`install-links` in `.npmrc`), so the app runs this checkout's Engine, product Host, existing client and web-search provider. Run `npm ci` again after you change that package or merge a branch that changes it. `overrides` in `package.json` pins the shared DSH peers to the tested version.

| Variable | What it sets | Default |
|---|---|---|
| `DS_SUPERAGENT_HOME` | The outer data location. Its `superagent` folder holds the product profile. This override skips first run folder selection | The folder chosen at the first start |
| `DS_SUPERAGENT_WORKSPACE` | With `DS_SUPERAGENT_HOME`, the initial product workspace | `superagent/workspace` in the data location |
| `DS_SUPERAGENT_SHELL_DATA` | Window settings, Chromium storage, browser logins and `locations.json` | `DS SuperAgent` in Electron's app data folder, or `desktop/` under an explicit `DS_SUPERAGENT_HOME` |
| `DS_SUPERAGENT_UPDATE_URL` | A test feed that overrides the GitHub release lookup (see [Updates](#updates)) | The newest DS SuperAgent release |

Windows uses `%APPDATA%\DS SuperAgent` for shell settings. On macOS it is `~/Library/Application Support/DS SuperAgent`.
The app starts with its own settings and leaves data from previous product installs, browser logins and saved locations in place.

## Run from source (Windows)

From the repository root, run in PowerShell (Node.js 24.9+ within the Node.js 24 series and npm required):

```powershell
.\start.ps1
```

The launcher builds `ds-superagent`, installs dependencies when they change, refreshes the app's copy of the package when its source changes, and starts the desktop app. The first run downloads dependencies and Electron; later runs reuse them. Configure real model providers in the app's Settings.

Data persists across starts under the gitignored `.ds-superagent-local/` in the repository: `data/` holds the product
profile, model settings, credentials and business store; `workspace` holds Main and Worker files; `shell/` holds
window and browser storage. The launcher does not clear these folders or read the user's old team. Back up this
directory before removing the checkout. Close the app before updating dependencies or launching changed source.

Use `.\start.ps1 -DataRoot <folder>` for a different data root (relative paths are resolved against the repository root). The launcher always uses `data/`, `workspace` and `shell/` inside that root. It does not use the installed app's data or the user's `~/.dsh`. `-PrepareOnly` installs and builds without opening a window. If script execution is blocked, use `pwsh -NoProfile -ExecutionPolicy Bypass -File .\start.ps1`; this applies only to that process.

## First start

At its first start the app asks for a data location (`~/.ds-superagent` by default) and workspace (`~/DS SuperAgent`).
It checks that both can be written and offers to change a location if it fails. The choices go into the app's own
`locations.json`. Keep the folders outside each other, the program folder, personal DSH data and data from previous product installs.
The startup window stays up while the Host starts and closes once the local product page loads.

Use **Desktop locations** in the tray to review both paths and move the data folder. Change the default workspace in
**Settings → General → Work directories**. The app names the user's DSH data to the
product (`DS_SUPERAGENT_USER_DSH_HOME`), so neither the workspace nor an execution directory can be set there. The data
location moves through the app (`src/move-data.mjs`): the new folder must be empty or new and apart from the old
data, the workspace, the desktop settings, the user's DSH data and the program folder. The app stops the Host, copies the data into a
staging folder beside the new one, renames it to the new folder once it is whole, writes `locations.json` and starts
again. A failed or interrupted copy leaves the old location in use and removes the staging folder; the old folder
always stays. A run on throwaway folders (`DS_SUPERAGENT_HOME`) keeps its data location.

The app does not import or activate a legacy team runtime. Existing DSH files and data from previous product installs remain untouched.
Optional browser, credential and memory import are product actions inside the running SuperAgent profile and use
their own isolated import contracts.
Choose a supported export stored outside the product, personal DSH and former product data folders. The file chooser
checks the resolved path and size before reading. Cookie and credential previews keep values in the app until the
product Host authorizes an import.

The Host reads model settings through DSH. If a model call fails, Main points to Settings so you can check the role model and provider credentials. Settings shows when the provider has no models or a key is missing. Provider and credential files belong to the product's own DSH home.

## The profile

The Host's profile `ds-superagent` is in `profiles/ds-superagent` in the product home. It stacks these bundles, and
after them the bundles that the user installs:

| Bundle | What it adds |
|---|---|
| `@deepseek-ai/dsh-base` | DSH's shared core: models, Sessions, tools, settings, plugin management |
| `@deepseek-ai/dsh-web-app` | DSH's Web front end, which the window shows, and the host services that the product uses |
| `@deepseek-ai/dsh-experimental-voice-input-bundle` | DSH's optional speech input surface |
| `ds-superagent` | Engine, Host, business store, execution adapters, existing client and web search |

At every start the Host puts these bundles at the head of the profile's bundle list, removes retired standalone UI
and engine bundles from older manifests, and keeps the user's later bundles. Settings for one machine go into the
profile's `cordis.patch.yml`, as in DSH. The profile fails to start when `superagentProduct` or `workspaceRegistry`
is missing, so it cannot silently fall back to an old runtime.

`node scripts/check-superagent-profile.mjs` boots the profile without the Electron shell and checks that the product
service, workspace registry, web server and connection start.

## Check a change

`npm test` checks the single profile and its retired-bundle cleanup, first-run boundaries, data moves and that every
package the app runs is a dependency (see [Package](#package)). It also checks the window and the tray: the close
hides the window, the tray opens it again, a window that is gone is built anew against the Host that runs, the
application menu of macOS has no Quit of its own, the launch URL of the Host is used once, and the update waits for
a window that is hidden. The main process runs with Electron test doubles (`test/helpers/`), so no display, DSH or
user data is needed.

`scripts/shot.mjs` starts the app on throwaway folders, saves a screenshot of its window, prints the page text, closes the window the way a user does (it hides, and the app goes on) and ends the app the way the tray's Quit ends it. Use the package's mock model, `../superagent/dsh/dev/mock-llm.mjs` (`MOCK_PORT=<port> node ../superagent/dsh/dev/mock-llm.mjs`).

```sh
DS_SUPERAGENT_HOME=<tmp>/home DS_SUPERAGENT_SHELL_DATA=<tmp>/shell \
DEEPSEEK_BASE_URL=http://127.0.0.1:<port>/v1 DEEPSEEK_API_KEY=mock-key \
node scripts/shot.mjs <tmp>/shot.png 20
```

Use throwaway folders for `DS_SUPERAGENT_HOME` in checks.

## Package

[electron-builder](https://www.electron.build/) packages the app with the settings in `electron-builder.yml`. Build on the platform that you package for: the native modules (`node-pty`, `sharp`, `koffi`) are taken from `node_modules` as npm installed them, not rebuilt.

```sh
npm run pack           # the app without an installer: dist-pack/win-unpacked/ (Windows), dist-pack/mac*/ (macOS), dist-pack/linux-unpacked/ (Linux)
npm run dist           # DS-SuperAgent-<version>-... in dist-pack/ (Windows exe, macOS zip, Linux AppImage and deb)
npm run check-packed   # starts the packaged app on throwaway folders with the mock model, chats once, closes it
```

macOS produces one zip per architecture. Build arm64 on an Apple chip Mac and x64 on an Intel Mac, or under Rosetta with an x64 Node that also ran `npm ci`. Do not cross-build: it packages native modules from `node_modules`; a combined build put 12 arm64-only native modules in its x64 app. `scripts/before-pack.mjs` stops a build whose architecture is not the one of the Node that runs it. The app is ad-hoc signed so downloaded copies are sealed. It ships as a zip, not a dmg: macOS 26 calls a downloaded unsigned dmg damaged and does not open it, and an ad-hoc signature on the dmg does not help (#351). Safari unzips the download. Move DS SuperAgent to Applications. On first open, use System Settings → Privacy & Security → Open Anyway. Do not disable Gatekeeper.

`check-packed` takes another executable as its first argument, and a file for a screenshot of the window as its second. It runs an app that lies inside this checkout from a copy in its throwaway folder: from inside the checkout, Node would find a module that the package left out in the checkout's own `node_modules`.

electron-builder packs only the packages that it finds through `dependencies` and `optionalDependencies`. The DSH packages ask for many packages as peers, which npm installs but electron-builder would leave out, so `package.json` lists them as dependencies. `npm test` fails when one is missing and names it.

The Windows installer installs for the current user without administrator rights. A fresh install defaults to `%LOCALAPPDATA%\Programs\DS SuperAgent`. The DS SuperAgent installer registers its own product identity. Updates to DS SuperAgent reuse its registered program folder. Uninstall keeps product data and desktop settings. The desktop package check builds the installer, runs the app, checks an update, and uninstalls it.

Linux gets an AppImage and a deb for Debian/Ubuntu. An AppImage mounts through FUSE 2 (`libfuse2t64` on Ubuntu 24.04+/Debian 13+, `libfuse2` on Ubuntu 22.04, `fuse-libs` on Fedora, `fuse2` on Arch). `--appimage-extract-and-run` works without FUSE. On Ubuntu 24.04 and later, AppArmor restrictions can prevent the AppImage from starting. The deb sets up `chrome-sandbox` and its AppArmor profile during installation. The deb installs `/opt/DS SuperAgent/ds-superagent` and the `ds-superagent.desktop` launcher. The desktop package check tests AppImage updates on a temporary copy and installs, checks and removes the deb.

## Updates

The installed app on Windows updates itself with electron-updater (`src/updates.mjs`), and so does an AppImage on Linux (`APPIMAGE` is set then). At its start and every 4 hours it reads `latest.yml` (Windows) or `latest-linux.yml` (AppImage) of the newest GitHub release, which names the installer and its sha512. It downloads that installer in the background and checks its sha512. When the download is done, a dialog on the window asks whether to restart now: then the app stops its Host and runs the installer, which opens the app again. Otherwise the installer runs when the app quits.

The checks start before the Host, so that a version whose Host does not start can still update. When the start
fails, the app waits up to 15 seconds for the newest check. When it found a newer version, the error box says so;
after the box the app waits for the download, then installs it and opens again.

On macOS, the app checks GitHub's releases at start and every 4 hours. It asks once per version, after that release's zip for this Mac is attached. A Linux deb waits for the `linux-amd64` deb (Debian's name for x64). Stable installs ignore prereleases. Download opens the release page for manual installation. `DS_SUPERAGENT_UPDATE_URL` on macOS and for a deb points to a JSON list like the `releases` API response. A release needs `tag_name`, an HTTPS `html_url`, and the machine's package in `assets`.

On Windows and for an AppImage, `app-update.yml` tells the app where its releases are; `npm run dist` writes it from `publish` in `electron-builder.yml`, together with `latest.yml` / `latest-linux.yml` beside the installer (`npm run pack` writes neither). Neither command publishes. The release workflow (`.github/workflows/release.yml`) builds the packages when a release is published and attaches the Windows installer with its `.blockmap` and `latest.yml`, the AppImage with its `.blockmap`, the deb and `latest-linux.yml` to the release. The release tag is the version of `ds-superagent`, and `npm test` checks that the app has the same version. The macOS release job builds each zip on a matching-architecture runner and attaches only the zip.

On throwaway folders (`DS_SUPERAGENT_HOME`) the app checks for updates only from `DS_SUPERAGENT_UPDATE_URL`. Any downloaded update waits until the app quits. `scripts/check-update.mjs` checks the update of a packaged app with such a feed:

```sh
npx electron-builder --publish never -c.extraMetadata.version=<next version> -c.directories.output=dist-next   # the feed
node scripts/check-update.mjs "dist-pack/win-unpacked/DS SuperAgent.exe" dist-next --kill   # Windows
node scripts/check-update.mjs ./ds-superagent.AppImage dist-next --kill                    # a Linux AppImage (latest-linux.yml)
```

It serves the feed folder, runs the app on throwaway folders and waits for the update download and its SHA-512 check. Use `--kill` to end the check before installation on your machine. The desktop package workflow runs the install step on disposable runners and checks the updated program.

On macOS and for a Linux deb, pass the app executable and a version to mock a newer release:

```sh
node scripts/check-update.mjs "<app executable>" 99.0.0
```

The script serves a releases list with one release of that version that has this machine's package (the Mac's zip, or the `linux-amd64` deb), starts the app on throwaway folders with it, waits until the app logs the new version, and ends the app the way the tray's Quit ends it. It does not open a browser.

## The tray and quitting

The app builds a system tray icon on Windows, macOS and Linux (`src/shell.mjs`, `src/tray.mjs`). The menu describes the Host's current state and offers “Open DS SuperAgent” and “Quit DS SuperAgent”. Some Linux desktops need a tray extension to display the icon.

Closing the window hides it: Main, Router and Worker go on running, and browser resource tabs stay. Starting the
app again brings the window back, because the second copy hands itself to the one that runs. When the window is gone
for good, the tray's Open builds a new one that talks to the Host that runs: it loads the Host's plain address, and
the cookie of the first load still carries the session, so neither the launch token nor a second Host is needed.

No window closed ends the app; the tray's Quit is the one ordinary way out. The first close asks once, because
the app stays in the tray; the answer is kept in the app's own data (the `tray-close-acknowledged` file in its
user data folder). A close during the first start or during a data move cancels that work. An update that restarts
the app, a data move that restarts it, a failed start and the end of the operating system's session close the
window for good.

A computer that sleeps pauses the Host with it: the tray says so instead of claiming that work continues. When the
computer wakes, the app reads the Host again; a window that was closed loads what the Host kept. If the Host did not
survive the sleep, the app starts it again on the same profile and data, and only when that fails does it show the
error. A Host that does not start outside a sleep is not the end of the app either: the error box offers "Try again",
so a directory or an account can be fixed and checked again without starting the first run over.

The application menu of macOS has no Quit and no ⌘Q, for the same reason: the tray's Quit is the one ordinary way out. Only when the tray cannot be built does the menu carry a Quit, so that the app can still be ended.

Without a tray (some Linux desktops have none), closing the window asks whether the app should end, and minimizes it when the answer is no: the window stays reachable, and the app does not vanish. This is the one exceptional path, and it is the only place where the app asks before it ends.

The launch URL of the Host is good for one use only. When the first load never came through (the window died while it loaded), no window carries the token again: the new window loads the Host's plain address, and the Host refuses it when the cookie is not there. Starting the app again then gives a new token.

New replies and questions can show a system notification and a desktop badge. A notification opens Main, and its text
contains only the event type. Downloads from the product window ask for a save location. Settings exposes recent shell
event codes alongside Host and update events for diagnostics. Computer control starts off. The local user must enable
it, allow a running application, then approve its exact current Worker in a native dialog. One 60-second lease can
operate at a time. A screen indicator stays visible, and the tray can stop control. Take over to abort actions;
release to allow a fresh request. Input already sent is not undone. The driver refuses unsupported systems or
missing permissions. The settings page can show the last window snapshot while its lease is active.

`scripts/check-lifecycle.mjs` (`npm run check-lifecycle`) checks this in a real Electron with a fake Host: no DSH, no model, no data of the user. It keeps its data in `app/.dsh-test-tray-lifecycle` and removes it afterwards. It checks that the Host keeps working while the window is hidden, that the window reads what it missed when it comes back, that a window that is gone is built anew against the same Host, the sleep status, and the explicit quit. It needs a desktop; the unit tests cover the same rules without one.

`scripts/check-resident.mjs` (`npm run check-resident`) runs the real app with the real DSH Host on throwaway folders: it closes the window, asks the Host for its own page, starts a second copy that must bring the same window and Host back, and quits explicitly, after which the Host must stop listening. It needs a desktop and the DSH packages of `node_modules`.

An upgrade does not migrate the Host's data: the app only puts its own bundles first in the product profile and
keeps the user's bundles, dependencies, role presets and settings after them. Business state and native Sessions
stay where the Host keeps them; the profile file is the only file the upgrade rewrites (see
`test/upgrade.test.mjs`). A business or Session backup restore is the new core's own contract.

## Layout

| File | What it does |
|---|---|
| `src/main.mjs` | Main process: one instance, the window, which loads the Host's loopback address as DSH Web does, and the sign-in page DSH opens, which goes to the system browser |
| `src/shell.mjs`, `src/tray.mjs`, `src/background-notice.mjs` | The window and the tray: the window hides instead of closing, the tray opens it again and quits the app, and the one-time confirmation before the window hides |
| `src/update-prompt.mjs` | An update prompt that waits for the window to be shown again |
| `src/host-port.mjs` | The Host's port, kept between starts, since the page keeps its storage per address |
| `src/preload.cjs` | Hands the product settings the data location and data move, and browser imports their isolated IPC. On Windows it marks the page for the frameless window and sends caption button colors |
| `src/bot-browser.mjs` | Product browser resource webviews: only a leased one attaches, with fixed preferences; each resource's storage stays on disk until the resource is forgotten; pages cannot reach the Host |
| `src/cookie-parse.mjs`, `src/cookie-import.mjs`, `src/browser-sources.mjs` | Cookie imports: the cookie-file parser (Cookie-Editor JSON, Netscape, Playwright storageState), the write into an authorized resource partition with read-back and flush, and the installed-browser profiles a source is cloned from — the source browser itself decrypts its own store over a CDP pipe; values never leave the main process |
| `src/window-frame.mjs`, `src/mica.css` | The frameless Windows window: the caption band, when Mica is available (Windows 11 22H2 and later), and the stylesheet that lets Mica through the sidebar |
| `src/host-process.mjs` | Starts the Host in the bundled plain Node on Linux, Electron's Node mode elsewhere, and owns its exit |
| `src/host.mjs` | Boots the single product profile with `runProfile()`, verifies its public services and reports the launch URL |
| `src/profile.mjs` | The one `ds-superagent` profile, its bundles and retired-bundle cleanup |
| `src/dsh-home.mjs` | Resolves the user's DSH home for read-only path isolation checks |
| `src/first-run.mjs` | The first start's data and workspace dialogs plus data-move copy |
| `src/move-data.mjs` | The move of the data location: which folders can take it, and the copy through a staging folder |
| `src/updates.mjs` | The self-updates (Windows installer, Linux AppImage) and the release-page checks (macOS, Linux deb) |
| `test/` | `npm test`: the composition of the profile, the dependencies that the package needs, and the window and the tray (the main process runs there with the Electron parts as test doubles, in `test/helpers/`) |
| `assets/` | The app icon: `icon.svg`, `icon.png` (1024 px) and `icon.ico` (Windows, 16 to 256 px), and the tray marks: `tray.ico` (Windows), `tray.png` (Linux) and `trayTemplate.png` with its `@2x` (macOS). `npm run icon` (`scripts/icon.mjs`) draws them again from the whale in `../superagent/dsh/src/client/characters.js` |
| `electron-builder.yml`, `build/` | The package and the installers: app identity, files, icons, the Windows installer, the macOS zip and the Linux AppImage and deb |
| `scripts/check-packed.mjs` | `npm run check-packed`: the check of a packaged app |
| `scripts/check-update.mjs` | The check of a packaged app's update from a feed folder (Windows, AppImage) or a mocked release (macOS, deb) |
| `scripts/check-lifecycle.mjs` | `npm run check-lifecycle`: the check of the window and the tray in a real Electron, with a fake Host |
| `scripts/check-resident.mjs` | `npm run check-resident`: the check of the resident Host with the real app and the real DSH, on throwaway folders |

The Host installs plugins with the app's own pnpm (`node_modules/pnpm`).

Some files adapt code from DSH Desktop (MIT); see [NOTICE](../NOTICE).
