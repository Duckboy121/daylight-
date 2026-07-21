# Daylight

A custom Minecraft launcher + client mod, Lunar/Dawn style.

**Launcher** (this repo, Electron): Microsoft login, modpack profiles, Modrinth
mod manager, optimized launching. Default MC version: **1.21.11**.
**Mod** (two builds): in-game module GUI on <kbd>Right Shift</kbd> — HUD
modules, zoom, fullbright, toggle sprint, emotes.
- `../daylight-mod-1.21.11` — MC 1.21.11 (yarn, loom 1.16, Java 21)
- `../daylight-mod` — MC 26.2 (unobfuscated/official names, loom 1.17, Java 25)

The launcher bundles a jar per version in `bundled/daylight-mod-<version>.jar`
and drops the matching one into a pack's mods folder based on the pack's MC
version (`modBuildFor()` in `src/main.js` — any bundled jar is auto-detected,
no code change needed to add a version). The mod is **built-in**: it's always
re-copied on launch and can't be removed from the Mods tab. Packs on a version
without a build just get the performance mods.

Version coverage is produced by a build matrix
(`tools/matrix-build.ps1`-style loop) over the yarn-generation source; run it
again to add versions. Versions whose fabric-api API differs from the source
won't build and simply have no mod jar.

## Run the launcher

Dev mode:

```
npm install
npm start
```

Build the installable Windows app (Start Menu + desktop shortcut, pin it to
the taskbar from there):

```
npm run dist
```

The installer lands in `dist/Daylight Setup <version>.exe`. The app keeps
running in the system tray when you close the window — reopen it from the
tray icon, quit from the tray menu.

## Install on Linux

One command downloads the latest AppImage, adds a `daylight` command and an
application-menu entry (no root, no package manager):

```
curl -fsSL https://raw.githubusercontent.com/Duckboy121/daylight-/main/install.sh | bash
```

Then launch it with `daylight` or from your apps menu. Re-run the same command
any time to update. Prefer to grab the file yourself? Download
`Daylight-<version>.AppImage` from the
[Releases page](https://github.com/Duckboy121/daylight-/releases/latest),
`chmod +x` it, and run it.

AppImages need **FUSE 2** to run (`sudo apt install libfuse2`, `dnf install
fuse`, or `pacman -S fuse2`); the installer detects a missing FUSE and prints
the fix. Without it you can still run `daylight --appimage-extract-and-run`.
Zero-setup Java applies here too — the launcher downloads the right JRE from
Adoptium if your machine has none.

The Linux AppImage is built on a Linux CI runner
(`.github/workflows/build-linux.yml`) and attached to each GitHub release
automatically, so the Windows release flow and the Linux download stay in sync.
Auto-update works when running the AppImage (via `latest-linux.yml` on the
release).

## Packs

Every pack — including ones you create — automatically includes the Daylight
mod (when the pack is on MC 26.2) and the performance mods (Sodium, Lithium,
FerriteCore, EntityCulling, ImmediatelyFast, Krypton) resolved for the pack's
version.

- **Daylight** — the built-in default, starts on MC 1.21.11; switch its
  version from the Packs page.
- **Custom packs** — any stable MC version; add extra mods from the Mods tab
  (searches Modrinth for the pack's version).

## Mods tab

- **Installing to pack** — pick which pack downloads and imports land in.
- **Search** — Modrinth search for the pack's MC version; one-click Install
  downloads into that pack.
- **Add mod file(s)** — import local `.jar` files into the pack's mods folder.
- **Open mods folder** — opens that pack's mods folder in Explorer.
- The Daylight mod shows a 🔒 **Built-in** badge and can't be removed.

## Accounts

The top-left account switcher (via [msmc](https://github.com/Hanro50/MSMC))
holds multiple Microsoft accounts. Add accounts with the real Microsoft sign-in
popup, click one to switch (silent token refresh), or remove one. The active
account launches the game; tokens are stored locally and never shown in the UI.
Minecraft can't change account mid-session, so switch in the launcher then
launch.

## Distribution

`npm run dist` builds `dist/Daylight Setup <version>.exe` and, via the
`afterAllArtifactBuild` hook (`tools/after-build.js`), copies it to
`C:\Users\Alexj\Documents\day` — that exe is what you send to others.

## Note on Fabric Loader 0.16+ and canonical paths

Fabric Loader 0.16+ recognizes its own libraries (sponge-mixin, ASM) by
matching classpath entries against the code sources it loaded from. On Windows
AppContainer setups `%APPDATA%` is redirected, so the launcher canonicalizes
the game root with `fs.realpathSync.native()` before launching — otherwise the
paths mismatch and every mod's mixin plugin fails with a "loader 'knot' vs
'app'" ClassCastException. This is a no-op in normal (non-sandboxed) installs.

Each pack has its own game directory under `%APPDATA%\.daylight\packs\<id>`
(own mods, worlds, settings). Downloads (assets/libraries) are shared. Pack
mods auto-install on first launch; auto-installed mods are swapped out when
you change a pack's version.

Launches use tuned G1GC JVM flags for smoother frametimes. Real FPS gains come
from the bundled Sodium/Lithium stack (typically 2x+ vanilla).

## The Daylight mod (in game)

- <kbd>Right Shift</kbd> — module GUI: toggle modules, **drag HUD elements**
  to reposition them, play emotes
- <kbd>C</kbd> (hold) — zoom
- <kbd>V</kbd> (hold) — **Freelook**: third-person camera orbits with the
  mouse while your player keeps facing/walking the same direction
  (camera-only; note some public servers disallow freelook)
- Modules: FPS, CPS, Keystrokes, Coordinates, Ping, Clock, Armor HUD,
  Toggle Sprint, Zoom, Freelook, Fullbright
- Emotes: Wave, Spin, Bow — driven through real player state (swings,
  rotation, sneak), so other players see them
- Config saves to `config/daylight.json` in the pack folder

To rebuild the mod after changes: `cd ../daylight-mod && gradlew build`, then
copy `build/libs/daylight-1.0.0.jar` to `bundled/daylight-mod.jar` here.
Requires JDK 25 (MC 26.x is Java 25).

## Java

MC 26.x needs **Java 25** — the launcher auto-detects a suitable JDK (on
Windows under `Program Files\Eclipse Adoptium` / `Program Files\Java`; on Linux
under `/usr/lib/jvm`, `/opt`, SDKMAN, etc.), downloads the right JRE from
Adoptium if none is found, or you can set an explicit path in Settings.

## Microsoft login — your own Azure app (for distribution)

Login works out of the box via msmc. To ship this launcher publicly, register
an Azure app: Azure Portal → Entra ID → App registrations → new app, personal
Microsoft accounts, redirect URI `http://localhost` (mobile & desktop
platform). Then apply for Minecraft API permission at
**https://aka.ms/mce-reviewappid** (new Azure apps get 403 from
api.minecraftservices.com until approved). Paste the client ID into Settings.
