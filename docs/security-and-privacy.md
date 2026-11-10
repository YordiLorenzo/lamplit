# What Lamplit changes on your PC, and what it sends

Lamplit runs as your own Windows account, with your normal rights. Repairing Steam's background service asks for
admin rights. Removing a sign-in task created by an older Lamplit may also need them.
This page lists everything Lamplit changes outside its own data folder (`%LOCALAPPDATA%\lamplit`), everything else it
does to other apps, and everything it sends over the network. How to report a security problem is in
[SECURITY.md](../SECURITY.md).

## Network: game art, trailers and app updates

Lamplit goes online for cover, background and logo art for your games. It does so only while
**Settings > System > Find art online** is on. That setting is on until you switch it off, so the first scan after
Lamplit's first start goes online. Switching it off also stops a search or download that is under way. Art that
Steam already keeps on your PC (its library cache) is used without going online. While the setting is on:

| Host | What it receives |
| --- | --- |
| `store.steampowered.com` (store search) | The name of each game that isn't from Steam and has no art yet, and the country of your Windows region. A game outside any store is named after its folder. A name that matched nothing is asked about again after 7 days. In **Change art**, the game's name, or the words you type instead. |
| `api.steampowered.com` (`IStoreBrowseService/GetItems`) | The Steam app ids whose art is missing, or that Change art found, and the country of your Windows region. |
| `shared.steamstatic.com` | Requests for the art files themselves. |

Art requests carry the user agent `lamplit/<version>`.

### Trailers

While **Settings > Sound > Trailers** is not **Off** and **Find art online** is on, resting on a cover for 2.5 seconds
can request that game's details and stream its trailer from Steam's video servers. The trailer setting defaults to
**Muted**. **With sound** uses 40% volume. A poster is loaded from the local art folder through the asset protocol.
The details request sends the game's Steam app id to `store.steampowered.com`.

The page's media policy permits only itself, `video.akamai.steamstatic.com` and `video.fastly.steamstatic.com`.
These servers receive your IP address, the requested trailer URL and WebView2's user agent. Lamplit adds no account
or device identifiers. The trailer is streamed by WebView2 rather than saved in Lamplit's art folder.
Input pauses and mutes the video; its source is removed after a 200 ms fade to stop the download. Playback also ends
when another screen opens, a game runs, or Lamplit leaves the foreground. Reduce Motion disables trailers.
The trailer sound preference stays in `prefs.json` and is not sent online.

### App updates

In **Settings > Check for updates**, the **Check by itself** switch controls automatic checks. It is on by default.
Ten seconds after start, Lamplit requests `https://github.com/YordiLorenzo/lamplit/releases/latest/download/latest.json` if its
last check attempt was at least 24 hours ago. Failed attempts count too. Switching the setting off prevents future
automatic requests; a request already sent can finish. The **Check** action still works with automatic checks off.

GitHub and its release download hosts receive your IP address, a request for Lamplit's release metadata and the
updater's user agent, `tauri-plugin-updater/<plugin version>`. The fixed URL sends no installed Lamplit version, game
names, account details or device identifiers. Version comparison happens on your PC. There are no accounts or
telemetry, and logs stay on the PC.

An automatic check only shows the available version. Choosing **Check** or **Download and install** in that section
also downloads the installer if a newer version exists, from the release URL in the metadata, normally GitHub's
release download hosts. It carries the same updater user agent. Lamplit verifies its signature against the public
key built into the app before running anything. This update signature is separate from Windows publisher signing.

The verified download stays in memory until no game is starting or running and Lamplit is in front. The passive
installer then closes Lamplit, replaces its installed files and starts the new Lamplit with its supervisor. It asks
for no clicks or admin rights in the normal per-account installation and keeps the player's settings, art and sign-in
task. Closing Lamplit before installation discards the download. What's new comes from the changelog built into the
exe; displaying it sends nothing online.

### Other network access

Two more things go online, but not from Lamplit itself:

- The installer downloads Microsoft's WebView2 Runtime installer from Microsoft when WebView2 isn't on the PC yet.
- The store apps Lamplit starts for a game (Steam, the EA app and so on) go online as they always do.

Lamplit follows only folders on a drive letter from a store's files. A network share (`\\server\share`) named there,
such as a Steam library folder, a Steam game's folder or an Epic install folder, is skipped, so looking for games
never signs in to another computer.

## Epic's local files

Lamplit reads Epic's installed-game records from the legacy launcher's ProgramData manifests and the Preview's
`%LOCALAPPDATA%\com.epicgames.eglv2\installations.jsonl`, plus its `cache\prod\catalog-cache.json` for game names.
It reads the launcher protocol registration to find the exe. These files and registry entries are not changed.

For a saved sign-in, the legacy check reads its `RememberMe` settings. The Preview check reads only the file type
and size of `auth\access-token-prod.dpapi` in the Preview's data folder. Lamplit does not read or decrypt that
token, access Windows Credential Manager, read the account cache, or send account information anywhere. A saved
file is only a hint that the launcher can sign in; it does not confirm a live session.

## The logs

Lamplit writes `lamplit.log`, `supervisor.log`, `setup.log` and `restore.log` in its data folder, and keeps them there.
The app's log names the games it found, their folders and your sound devices. `setup.log` records Steam repair and
legacy task removal, under the account that runs the helper. `restore.log` records command-line and uninstall
restoration. Read a log before attaching it to a public issue, and remove anything you'd rather not share.

**Settings > System > Save a report** shows a plain-text preview before saving one file in your account's Downloads
folder. It contains Lamplit and Windows versions, the screen mode and screen count, controller kinds, connections
and batteries, headset status, the number of sound outputs and the default output's kind, store status and game
counts, counts of added, hidden and favourite games, selected prefs, and the last 50 warning and error lines from
`lamplit.log`.
Device names and identifiers are left out. In log lines, paths become `<folder>`, the Windows account name becomes
`<user>`, and current library game names become their ids. Path-based game ids also have their paths removed.
Device names in sound-switch errors and device addresses are removed, including errors about disconnected devices.
Read the whole preview before sharing it. Saving writes exactly that preview; nothing is uploaded or sent.

Lamplit also keeps one previous good copy of each JSON settings file in its data folder, with `.bak` added to the
name. If a settings file is damaged, Lamplit copies it with `.damaged` added to the name, replacing an older damaged
copy, and restores the good copy when available. These files stay on the PC and can contain the same game names,
folders and settings as the original files. Once quiet mode has restored all settings, its record and backup are
removed; a damaged copy is kept. The same applies to completed Steam restore records.
Interface sound levels and the two introductory hints' counts and completion stay in `prefs.json`; they are not
sent online.

## Steam's DevTools port (off unless you switch it on)

Two features need Steam's DevTools port: keeping the PS button from opening Steam's Big Picture, and switching off
Steam's notifications in quiet mode. Steam opens that port on `127.0.0.1:8080` without any password, and **while it
is open, any program on your PC (including programs of other Windows accounts) can control the Steam client**: change
its settings, or a game's launch options.

So Lamplit opens it only when you switch on **Settings > Stores > Steam's DevTools port**. Then Lamplit puts the empty
file `.cef-enable-remote-debugging` in Steam's folder, and starts Steam with `-cef-enable-debugging` when a game
needs Steam. Switching the setting off removes the file; Steam closes the port the next time it starts. If you opened
the port yourself, Lamplit uses it too.

Through the port, Lamplit reads and changes three of Steam's settings and nothing else: **Guide Button Focuses
Steam**, and Steam's two notification switches (all notifications, and notifications in game) while quiet mode is on.

While **Keep the Guide button for Lamplit** is on (the default), Lamplit switches off **Guide Button Focuses Steam**
(Steam > Settings > Controller) whenever the port is open. It saves the previous setting in `steam-saved.json` before
changing it. That file also saves the original presence and contents of any DevTools flag Lamplit changes. Restore
puts these back and switches both Steam prefs off, including the guard that closes Big Picture.

## Start when I sign in

**Settings > System > Start when I sign in** registers `lamplit-<your account's SID>` without an admin prompt. It
starts Lamplit in your desktop session with your normal rights. It is off on a fresh install until you switch it
on. The switch reads Task Scheduler: a deleted or disabled task, or one pointing to a different lamplit.exe, is off.

Switching it off deletes the task. Tasks created by 0.3 or earlier may have permissions that prevent your normal
account from deleting them. Only after Windows refuses that deletion does Lamplit ask for admin rights. That helper
deletes only the original account's Lamplit task, even if another administrator answers the prompt.

## Repair Steam's background service

**Settings > System > Repair Steam's background service** asks Windows for admin rights. From the command line,
`lamplit.exe --setup` must be run as administrator; it does not open the prompt itself.
The repair runs Valve's own `<Steam>\bin\SteamService.exe /repair`, after checking that Steam's folder is on a fixed drive
and the file carries Valve's signature. This stops Steam asking for admin rights to repair that service itself.
It does not change Lamplit's start at sign-in. Restore does not undo Valve's service repair.

On a standard account, Windows' prompt asks for an administrator's password. lamplit.exe is built so that Windows
loads the DLLs it needs from System32 only, so a DLL beside it cannot run with admin rights during repair.

## Quiet mode (when you switch it on)

Quiet mode writes your own (HKCU) settings for Windows' notification banners (this hides Windows Security's banners
too), tips and suggestions, and Game Bar's start-up tips, controller button and recording. It switches off Ubisoft
Connect's notifications and overlay in its `settings.yaml` (only while Ubisoft Connect is closed, since it rewrites
that file when it exits), and, through the DevTools port above, Steam's notifications. It records what was there
before in `quiet-saved.json` and puts it all back when you switch quiet mode off. A change that has to wait (Steam
not running, Ubisoft Connect open) is made within 10 seconds of becoming possible.

NVIDIA's overlay notifications aren't covered; switch those off in NVIDIA's overlay itself.

## Sound, controllers and the mouse

- While **Sound follows the headset and controller headphones** is on (the default), Lamplit changes Windows' default
  output and microphone when the headset turns on or off, or headphones go into or out of a controller on a USB
  cable. A separate default communications device (the one chat apps use) stays where you set it.
  Output and microphone endpoint ids are kept separately in `sound-return.json` in the local data folder so the
  return survives a restart. A missing device stays recorded until it returns or a newer choice cancels the return.
  Pending returns are checked every ten seconds while Sound follows is on. These ids are not sent online.
- Picking a device in **Settings > Sound** makes it Windows' default for everything, calls included, and cancels the
  pending return for that output or microphone.
- **Turn off** on a DualSense on Bluetooth drops its Bluetooth link.
- While **Touchpad as mouse** is on, the DualSense touchpad sends ordinary mouse input to Windows (never over a
  full-screen game).
- Lamplit reads controllers without changing their mode, lights or rumble.
  A DualSense and the 2026 Steam Controller are read over shared HID handles, Xbox-style controllers through
  XInput and others through Windows.Gaming.Input; none of these takes a controller from a game or from Steam Input,
  or changes what they see.
  On the headset it changes only what you change in Settings (sidetone and the auto-off timer), and those settings
  are stored on the headset.

## What Lamplit does to other apps

These don't change any setting, but you may notice them:

- It starts the store apps a game needs: Steam with `-silent` (plus `-cef-enable-debugging` when the DevTools port
  setting is on), the others as they start by default. A Battle.net game starts through Battle.net:
  `Battle.net.exe --exec="launch <code>"`, or `--game=<id>` to open Battle.net on the game's page. An itch.io game
  that the itch app runs in its sandbox (a Windows account of its own, with less access than yours) starts through
  the app's launcher, `itch-setup --run-game <id>`, which keeps it in the sandbox; Lamplit never starts such a game
  from its exe. So does a game that asks the itch app for an itch.io API key, which only the app hands out.
- While **Keep the Guide button for Lamplit** is on, it closes Steam's Big Picture mode whenever it opens.
  It minimises Steam's main window when Lamplit takes the screen back after a Steam game.
- It keeps the PC and the screen awake while a game is starting or Steam is updating it, and lets them sleep again
  once the game runs.
- While a game starts, its own window stays above the other windows, the taskbar included. Once the game's window
  covers the screen, Lamplit puts that window in front and its own right behind it. **Show it** on the starting
  screen brings forward a window that opened during the start.
- When you switch NVIDIA's performance stats from Settings or the in-game dock, it presses the overlay's own shortcut
  (Alt+R, or the one you set in NVIDIA's overlay).
- The in-game dock is a window of Lamplit's own that Windows shows above the game. While it is open it is the window
  in front; Lamplit gives the focus back to the game when it closes. **Close game** posts `WM_CLOSE` to the game's
  windows, as their close button does. **Force close** ends the game's processes (`TerminateProcess`), the ones that
  are certainly the game's: those running from its folder, and by one of its exe names only a process whose path
  Windows doesn't tell. For a game outside any store, whose folder may hold other programs, only its exe and the
  processes that came from it as far as Windows tells. It is offered only when the game isn't responding or didn't
  close when asked, and Windows refuses it for a game run as administrator. When Lamplit knows none of the game's
  processes for certain, the dock has no Close game.
- To know when a game runs, it reads the list of running processes and the folder each runs from. It doesn't inject
  code into games or read their memory. For a game outside any store, it keeps the game's processes open while it
  watches them, with the right to read their basic facts only, so Windows doesn't give their ids to other programs
  meanwhile.
- **Settings > Power** asks Windows to sleep, restart or shut down (`SetSuspendState`, `InitiateShutdownW`). For
  that, Lamplit enables the shutdown privilege, which a standard account holds but has switched off, in its own
  process only. It doesn't force apps to close, and it doesn't sign out another account that is signed in.
- **Settings > Power > Exit to Windows** closes Lamplit and its supervisor. It leaves running games and settings
  as they are.

## Removing Lamplit

Hold **Settings > System > Restore Lamplit's changes**. Its report shows quiet mode, Steam's Guide setting,
Steam's DevTools flag, and the sign-in task one by one. It turns quiet mode and Lamplit's two automatic Steam prefs
off, so the changes stay restored while Lamplit runs. If Lamplit saved a pre-existing DevTools flag, it puts that
file back; Steam will still open its port as before. Restart Steam to apply any flag change.
Restore leaves sound choices, headset settings and Steam's service repair as they are. It does not reset your
library or other preferences.

If Steam is closed or its DevTools port is unavailable, or Ubisoft Connect is running, the report says what to do.
The originals remain in `quiet-saved.json` and `steam-saved.json`; Lamplit retries while it runs. Keep those files
until every change is back. Steam must be signed in with its DevTools port open for its settings to be restored;
when necessary, restart Steam with `-cef-enable-debugging` for the restore, then restart it normally afterwards.

Versions before 0.4 did not save the Guide setting or the DevTools flag's original state. Restore names this
limitation. Check **Guide Button Focuses Steam** in Steam's Controller settings yourself. If Lamplit's port switch
was on and the flag has no saved original, restoration stays pending while that file exists. This can also happen
with a flag that was already present when you switched the port on. Remove `.cef-enable-remote-debugging` from
Steam's folder only if Lamplit created it, then try Restore again. A flag you had before Lamplit can stay, but the
report will still mark that step as needing attention.

Uninstall from **Settings > Apps > Installed apps**. The uninstaller runs the same restore before removing the exe;
updates and reinstalls in place keep your settings. Silent and passive removal (`/S` or `/P`) cannot ask for admin
rights, so a protected legacy task may remain. Remove it in Task Scheduler. If anything could not be restored,
the uninstaller keeps the saved data and `restore.log`, even if **Delete the application data** was selected.
Reinstall Lamplit into the same folder to finish restoring the saved settings. When restoration succeeds, that
checkbox also removes `%LOCALAPPDATA%\lamplit`, where the installer puts lamplit.exe by default.

For a copy used without the installer, close Lamplit and run `lamplit.exe --restore`. It writes `restore.log` and
returns a nonzero exit code for pending changes. Finish those before deleting the exe and its data folder.
