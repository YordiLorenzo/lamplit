# What Lamplit changes on your PC, and what it sends

Lamplit runs as your own Windows account, with your normal rights. Only the first-time setup asks for admin rights.
This page lists everything Lamplit changes outside its own data folder (`%LOCALAPPDATA%\lamplit`), everything else it
does to other apps, and everything it sends over the network. How to report a security problem is in
[SECURITY.md](../SECURITY.md).

## Network: art only

Lamplit goes online for one thing: cover, background and logo art for your games. It does so only while
**Settings > System > Find art online** is on. That setting is on until you switch it off, so the first scan after
Lamplit's first start goes online. Switching it off also stops a search or download that is under way. Art that
Steam already keeps on your PC (its library cache) is used without going online. While the setting is on:

| Host | What it receives |
| --- | --- |
| `store.steampowered.com` (store search) | The name of each game that isn't from Steam and has no art yet, and the country of your Windows region. A game outside any store is named after its folder. A name that matched nothing is asked about again after 7 days. In **Change art**, the game's name, or the words you type instead. |
| `api.steampowered.com` (`IStoreBrowseService/GetItems`) | The Steam app ids whose art is missing, or that Change art found, and the country of your Windows region. |
| `shared.steamstatic.com` | Requests for the art files themselves. |

Every request carries the user agent `lamplit/<version>`. Nothing else leaves the PC: no accounts, no telemetry, no
update checks, and the logs stay in Lamplit's data folder.

Two more things go online, but not from Lamplit itself:

- The installer downloads Microsoft's WebView2 Runtime installer from Microsoft when WebView2 isn't on the PC yet.
- The store apps Lamplit starts for a game (Steam, the EA app and so on) go online as they always do.

Lamplit follows only folders on a drive letter from a store's files. A network share (`\\server\share`) named there,
such as a Steam library folder, a Steam game's folder or an Epic install folder, is skipped, so looking for games
never signs in to another computer.

## The logs

Lamplit writes `lamplit.log`, `supervisor.log` and `setup.log` in its data folder, and keeps them there. They name
the games it found, their folders and your sound devices. Read a log before you attach it to a public issue, and
remove anything you'd rather not share.

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

Whenever the port is open, Lamplit switches off **Guide Button Focuses Steam** (Steam > Settings > Controller), so the
PS button doesn't open Big Picture. Steam keeps that setting, so it stays off after Lamplit is gone until you switch
it back on.

## First-time setup (admin rights, once)

`lamplit.exe --setup`, or **Settings > System > First-time setup**, asks Windows for admin rights once and then:

1. Repairs Steam's background service with Valve's own `<Steam>\bin\SteamService.exe /repair`, after checking that
   Steam's folder is on a fixed drive of this PC and that the file carries Valve's signature. Without this, Steam
   asks for admin rights itself whenever it updates that service.
2. Registers the logon task `lamplit-<your account's SID>`, which starts Lamplit when you sign in, with your normal
   rights.

On a standard account, Windows' prompt asks for an administrator's password, and the logon task is still made for
the account that asked. lamplit.exe is built so that Windows loads the DLLs it needs from System32 only, so a DLL
placed next to lamplit.exe can't run with admin rights during setup.

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
- Picking a device in **Settings > Sound** makes it Windows' default for everything, calls included.
- **Turn off** on a DualSense on Bluetooth drops its Bluetooth link.
- While **Touchpad as mouse** is on, the DualSense touchpad sends ordinary mouse input to Windows (never over a
  full-screen game).
- Lamplit only reads the controllers and the headset receiver. It never changes a controller's mode, lights or
  rumble. A DualSense is read over HID, Xbox-style controllers through XInput and others through
  Windows.Gaming.Input; none of these takes a controller from a game or from Steam Input, or changes what they see.
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
- It closes Steam's Big Picture mode whenever it opens, and minimises Steam's main window when Lamplit takes the
  screen back after a Steam game.
- It keeps the PC and the screen awake while a game is starting or Steam is updating it, and lets them sleep again
  once the game runs.
- While a game starts, its own window stays above the other windows, the taskbar included. Once the game's window
  covers the screen, Lamplit puts that window in front and its own right behind it. **Show it** on the starting
  screen brings forward a window that opened during the start.
- When you switch NVIDIA's performance stats from Settings or the in-game dock, it presses the overlay's own shortcut
  (Alt+R, or the one you set in NVIDIA's overlay).
- The in-game dock is a window of Lamplit's own that Windows shows above the game. While it is open it is the window
  in front; Lamplit gives the focus back to the game when it closes. **Close game** posts `WM_CLOSE` to the game's
  windows, as their close button does. **Force close** ends the game's processes (`TerminateProcess`), the ones
  that are certainly the game's: those running from its folder, and by one of its exe names only a process whose
  path Windows doesn't tell. For a game you added by hand, whose folder may hold other programs, only its exe and
  the processes it started. It is offered only when the game isn't responding or
  didn't close when asked, and Windows refuses it for a game run as administrator.
- To know when a game runs, it reads the list of running processes and the folder each runs from. It doesn't inject
  code into games or read their memory. For a game added by hand, it keeps the game's processes open while it watches
  them, with the right to read their basic facts only, so Windows doesn't give their ids to other programs meanwhile.
- **Settings > Power** asks Windows to sleep, restart or shut down (`SetSuspendState`, `InitiateShutdownW`). For
  that, Lamplit enables the shutdown privilege, which a standard account holds but has switched off, in its own
  process only. It doesn't force apps to close, and it doesn't sign out another account that is signed in.

## Removing Lamplit

Before you uninstall Lamplit, undo what it changed outside its data folder that the uninstaller can't:

1. Switch **Steam's DevTools port** off in Settings, or delete `.cef-enable-remote-debugging` from Steam's folder
   yourself. Otherwise Steam keeps opening the port at every start.
2. Switch **Quiet mode** off, so your notification, Game Bar, Ubisoft Connect and Steam settings go back to what
   they were.
3. If Lamplit ever had Steam's DevTools port open, switch **Guide Button Focuses Steam** back on in Steam > Settings >
   Controller, if you want the PS button to open Steam again.

Then uninstall it from **Settings > Apps > Installed apps**. The uninstaller deletes the logon task
`lamplit-<your account's SID>` (Windows usually asks for admin rights for that) and the setup record. A silent or
passive uninstall (`/S` or `/P`) can't show that prompt and leaves the task; delete it in Task Scheduler. Tick
**Delete the application data** to also delete the data folder `%LOCALAPPDATA%\lamplit`, which is also where the
installer puts lamplit.exe unless you choose another folder.

If you run lamplit.exe without installing it, delete the task in Task Scheduler (this asks for admin rights), then
lamplit.exe and the data folder yourself.
