# Epic Launcher Preview integration evidence

Researched on 2026-11-09. The Preview launched on 2026-10-14. Epic says migration can remove the legacy launcher
and carry over installed games without downloading them again. See [Epic's migration help](https://www.epicgames.com/help/c-32735058/a12104725)
and [release notes](https://launcher.epicgames.com/release-notes).

## Paths and formats

| Used by Lamplit | Evidence | What remains inferred or untested |
| --- | --- | --- |
| Preview default exe: `%LOCALAPPDATA%\Epic Games\Launcher\EpicGamesLauncher.exe` | [Epic troubleshooting help](https://www.epicgames.com/help/c-32735058/a13131646) explicitly lists this Windows path. [TcNo Account Switcher's platform definitions](https://github.com/TCNOco/TcNo-Acc-Switcher/blob/master/Platforms.json) use it too. | Starting it and foregrounding an existing instance have not been tested here. |
| `HKCR\com.epicgames.launcher\shell\open\command` | [Arcadia issue 174](https://github.com/jc-sw-git/Arcadia/issues/174) reports that this existing lookup still finds the Preview after the old launcher and its default path are gone. | This is an observation from another integration, not an installer registry dump. No new uninstall key is assumed. Lamplit keeps its existing HKCR lookup, which Windows merges from user and machine registrations. |
| Legacy manifests: `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item`; legacy index: `%ProgramData%\Epic\UnrealEngineLauncher\LauncherInstalled.dat` | [Playnite's EpicLauncher.cs](https://github.com/JosefNemec/PlayniteExtensions/blob/master/source/Libraries/EpicLibrary/EpicLauncher.cs) reads both. [Legendary issue 797](https://github.com/legendary-gl/legendary/issues/797) reports Preview migration breaking the old manifest sync. | Lamplit continues reading `.item` files unchanged. It did not read `LauncherInstalled.dat` before and does not add it now. There is no evidence that the Preview maintains that index. |
| `%LOCALAPPDATA%\com.epicgames.eglv2\installations.jsonl`; `complete`, `dir`, `platform`, `namespace`, `itemId`, `artifactId`, `launchExecutable` | [Taiga Launcher issue 8](https://github.com/GabrielTaiga/Taiga-Launcher-for-Steam/issues/8) provides this Windows path and a Windows 11 record from Preview 0.102.0. | The tests use invented ids and temporary folders, not a captured private installation. |
| Journal replay by `installationId`; full replacement snapshots; `deleted: true`; DLC `parentInstallationId` | [Heroic PR 5981](https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher/pull/5981), specifically [eglv2_sync.ts at 5ea0a78](https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher/blob/5ea0a78c1c251749e682c40b8830b3c1b110b167/src/backend/storeManagers/legendary/eglv2_sync.ts), documents and implements these fields against Preview 0.95.2 on Linux. | Applying these journal semantics to Windows is inferred from the shared record format. Filtering `UE_` artifacts preserves the legacy Unreal Engine exclusion. |
| `cache\prod\catalog-cache.json`, title at `items[itemId].item.title` | [ProtonUp-Qt's epicutil.py](https://github.com/davidotek/protonup-qt/blob/main/pupgui2/epicutil.py) reads this exact cache layout and uses the install folder when no title exists. [Jolven issue 65](https://github.com/zonaro/jolven/issues/65) independently records the layout. | Both sources inspect Linux. Using the same relative path and format under the Windows Preview data directory is inferred. Missing titles use the folder name, with no network lookup added. |
| `com.epicgames.launcher://apps/<namespace>%3A<itemId>%3A<artifactId>?action=launch&silent=true` | [Playnite's EpicLauncher.cs](https://github.com/JosefNemec/PlayniteExtensions/blob/master/source/Libraries/EpicLibrary/EpicLauncher.cs) supplies the existing full URI. [Jolven issue 65](https://github.com/zonaro/jolven/issues/65) reports a successful Preview game launch using the same scheme and `apps/<artifactId>?action=launch`, resolved internally to the three-part id. | Acceptance of the full three-part URI and `silent=true` by the Windows Preview remains inferred and needs a live launch. No undocumented Preview command-line switches are added. |
| `%LOCALAPPDATA%\com.epicgames.eglv2\cache\prod\account` | [Epic's account-id help](https://www.epicgames.com/help/c-45487929/c-35761596/a24590453?lang=en-US) explicitly gives the new path and describes filenames as accounts that previously logged in. | Historical cache files cannot prove a saved or current session, so Lamplit deliberately does not use or read them. |
| `%LOCALAPPDATA%\com.epicgames.eglv2\auth\access-token-prod.dpapi` | [TcNo Account Switcher's platform definitions](https://github.com/TCNOco/TcNo-Acc-Switcher/blob/master/Platforms.json) use this encrypted file to identify the Preview account and also document its Credential Manager session. | A non-empty file is only a saved-sign-in heuristic. Expiry, sign-out cleanup and a session kept solely in Credential Manager need Windows validation. Lamplit reads only file metadata. |
| `EpicGamesLauncher.exe`, helper `EpicWebHelper.exe` | [TcNo Account Switcher's platform definitions](https://github.com/TCNOco/TcNo-Acc-Switcher/blob/master/Platforms.json) list both for the Preview. | Lamplit waits for the selected main exe's full path, not the helper. No window class/title was established or is needed by Lamplit's existing show-store path. |

The Playnite Epic plugin source still uses the legacy layout. Its issue search for Epic updates since 2026-10-14
returned no results during this research. Heroic's new sync is explicitly Linux-only; its documented observations
are used for parsing, not as proof of Windows runtime behaviour.

The selected executable also selects the game-record source. This avoids stale legacy manifests reviving a game
deleted in the Preview, or stale Preview records overriding a game after rollback. If no launcher is installed,
both sources are listed and duplicate app ids are merged, so Lamplit can explain the missing launcher on Play.

## Worker validation

`cargo fmt --check` and `git diff --check` pass. On the M1 Max, `npm --prefix tests run typecheck` and
`npm --prefix tests test` pass: 166 of 166 Node tests and 524 of 524 Chromium checks. The initial runner copy
omitted `docs/images`, which correctly failed the screensaver preview check; the complete fixture copy passed.
The browser uses fake Tauri. It does not exercise the Rust implementation or the real Epic launcher. Five new
Rust tests cover executable parsing, journal replay, migration and rollback, game filtering, and sign-in isolation;
they have not been compiled or run, as required by the worker brief.

## Validation still needed on Windows

1. Cross-compile, run Clippy with warnings denied, and run the Rust tests, including the Epic tests.
2. On each launcher, launch a game with the launcher closed and open, and use Open Epic to show its window.
3. With the Preview installed outside its default folder, confirm the registry path, main process and full game URI.
4. Sign in, restart, sign out and expire the session; check the encrypted-file heuristic and Try anyway.
5. Install, update, uninstall and migrate a game; compare the displayed title, stable id and required publisher launcher.
