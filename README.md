<p align="center">
  <img src="docs/images/banner.png" alt="Lamplit: your games, from the couch" width="100%">
</p>

<p align="center">
  <a href="https://github.com/YordiLorenzo/lamplit/actions/workflows/ci.yml"><img src="https://github.com/YordiLorenzo/lamplit/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/YordiLorenzo/lamplit/releases/latest"><img src="https://img.shields.io/github/v/release/YordiLorenzo/lamplit?label=release&color=FCA545" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-PolyForm%20Noncommercial-AB84DE" alt="Licence: PolyForm Noncommercial 1.0.0"></a>
</p>

**Lamplit is a console-style home screen for the games on a Windows PC, made for the TV and a controller.**

A gaming PC under the TV usually comes with a handful of store apps, sign-in windows and Windows pop-ups, most of
them made for a mouse. Lamplit shows every game you have installed in one row of covers, whatever store it came from.
Press Cross and it starts the store apps the game needs, waits while they sign in or update, and gets out of the way
while you play. When the game closes, Lamplit is back on screen.

[Download for Windows](https://github.com/YordiLorenzo/lamplit/releases/latest) ·
[What it changes on your PC](docs/security-and-privacy.md) · [How it compares](#how-it-compares)

![Lamplit's home screen: a row of game covers along the bottom, the focused game's art and logo filling the screen](docs/images/home.jpg)

<table>
  <tr>
    <td width="50%"><img src="docs/images/launch.jpg" alt="The starting screen: Lamplit asks to sign in to the store app a game needs, with buttons to open it, try anyway or cancel"><br><sub>Starting a game: each store app it needs, and what it needs from you.</sub></td>
    <td width="50%"><img src="docs/images/settings.jpg" alt="The Settings panel: Sound, Headset, Controllers, Overlay and pop-ups, Stores and System, each with a one-line summary"><br><sub>Settings: each section with a one-line summary.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/sound.jpg" alt="The Sound section: output and microphone devices, volume, mute and the sound-follows switch"><br><sub>Sound: output, microphone and volume, from the sofa.</sub></td>
    <td width="50%"><img src="docs/images/controllers.jpg" alt="The Controllers section: touchpad as mouse, and a Bluetooth controller's battery, headphones and Turn off"><br><sub>Controllers: battery, headphones, and Turn off.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/find.jpg" alt="Find a game: an on-screen keyboard with rdr typed, store and sort choices, and the row narrowed to Red Dead Redemption 2"><br><sub>Find a game: "rdr" finds Red Dead Redemption 2.</sub></td>
    <td width="50%"></td>
  </tr>
</table>

## What it does

### Your library

- **Every installed game in one row.** Lamplit reads what Steam, the Epic Games Launcher, GOG, the EA app, Ubisoft
  Connect, the Rockstar Games Launcher and the Xbox app have installed, and finds games outside any store too. There
  is nothing to import, connect or sign in to.
- **Last played first,** then by name, so the game you're in the middle of is the first cover.
- **Find a game.** Square opens a search with an on-screen keyboard, and the row keeps only the games that match as
  you type. A search matches the start of any word in a game's name, or its first letters: "red dead" and "rdr" both
  find Red Dead Redemption 2. You can also show one store's games, or sort the row A to Z. Above the row, Lamplit
  shows what it is narrowed by, and Circle brings every game back.
- **Cover, background and logo art.** Lamplit takes it from Steam's own library cache when it can, and otherwise
  from Steam's public store, which it also searches by name for games from other stores. A game with no match shows
  its name instead. You can switch online art off.
- **New installs show up by themselves.** Lamplit looks again every time it comes back to the front.
- **Steam's install and update state** on the game: "Installing" or "Update pending".

### Launching

- **The store apps a game needs, started for you.** That is the game's own store, plus the launcher some publishers
  add on top: the EA app for some Steam games, Ubisoft Connect for others, the Rockstar Games Launcher for Rockstar
  titles. Lamplit starts each one and waits for it to sign in.
- **Sign-in and updates on screen.** If a store app isn't signed in, Lamplit says so and can open it for you, then
  carries on once you have signed in. A Steam update shows its progress before the game starts.
- **Out of the way while you play.** Lamplit minimises itself once the game runs and comes back when the game
  closes. A launcher that hands over to the game a few seconds after starting doesn't fool it.
- **Hold the PS button to come back.** Lamplit appears over the running game; press Cross to return to the game.
- **Awake while it waits.** The PC and the TV don't go to sleep while a store app starts or Steam downloads an
  update.
- **Steam stays in the background.** Lamplit closes Steam's Big Picture mode whenever Steam opens it, and minimises
  Steam's window after a Steam game.

### Sound and accessories

- **Sound settings on the TV:** choose the output and the microphone, change the volume, mute either.
- **Sound that follows you.** Turn the PRO X 2 headset on and the sound moves to it. Plug headphones into a
  controller on a USB cable and the sound moves there. When they go, it moves back. This is on by default.
- **Headset settings, for the Logitech G PRO X 2 LIGHTSPEED only (for now):** whether it is on, its battery,
  sidetone (how much of your own voice you hear) and its auto-off timer. Other headsets work as normal Windows sound
  devices.
- **DualSense:** battery, whether headphones are plugged in, and Turn off for a controller on Bluetooth.
- **The touchpad as a mouse,** for store apps and Windows dialogs. One finger moves the pointer, pressing the left
  or right half of the pad clicks, two fingers scroll. Off by default, and never active over a full-screen game.
- **NVIDIA's performance stats** (frame rate, GPU and CPU load) on and off, when NVIDIA's overlay is installed.

### Quiet

- **Quiet mode** stops pop-ups over your games and over Lamplit: Windows' notification banners, tips and
  suggestions, Game Bar's start-up tips and controller button, Ubisoft Connect's notifications and overlay, and
  Steam's notifications (that part needs Steam's DevTools port, see
  [What Lamplit changes on your PC](#what-lamplit-changes-on-your-pc)). It also turns off Game Bar's recording.
  Switch it off and every setting goes back to what it was.

### Controller

- **DualSense and DualSense Edge,** over USB or Bluetooth, several at once. Lamplit only reads the controller: it
  doesn't touch its lights, rumble or mode, so Steam and your games see it as before.
- **Console-style navigation:** a held direction repeats and speeds up, and L1 and R1 jump five games at a time.
- **A keyboard and mouse work too.**

## Supported stores and hardware

### Stores

| Store | How Lamplit finds its games | Before the game starts |
| --- | --- | --- |
| Steam | The app manifest in each Steam library folder | Starts Steam, checks who is signed in, shows update progress |
| Epic Games Launcher | The launcher's install manifests | Starts the launcher, checks for a saved sign-in |
| EA app | The installer data every EA game carries | Starts the EA app, checks for a saved sign-in |
| Ubisoft Connect | The launcher's list of installs | Starts Ubisoft Connect, checks for a saved sign-in |
| Rockstar Games Launcher | The launcher's list of titles | Starts the launcher, checks for a saved sign-in |
| GOG (GOG Galaxy or GOG's offline installers) | GOG's list of installed games | Nothing: GOG games start from their own exe |
| Xbox app, including PC Game Pass | The Xbox games installed for your Windows account | Nothing: Xbox games start without the app |
| No store | Folders in `<drive>:\Games`, installed programs that look like games, and games Windows' Game Bar has seen | Starts the game's exe |

Only Steam says live who is signed in. For the other store apps Lamplit checks whether they keep a saved sign-in,
and if it can't confirm one, it lets you go ahead anyway.

Battle.net, the Amazon Games app, itch.io and other stores aren't read yet. Their games can still turn up as games
outside any store, but Lamplit then starts the game's exe directly, which some of those games refuse.

### Controllers

| | USB cable | Bluetooth |
| --- | --- | --- |
| Buttons, d-pad and left stick | Yes | Yes |
| Hold PS to bring Lamplit forward | Yes | Yes |
| Battery level | Yes | Usually (see below) |
| Touchpad as a mouse | Yes | Usually (see below) |
| Sound through the headphone jack | Yes | No: the controller is a sound device only over USB |
| Turn off from Lamplit | No: unplug it | Yes |

Over Bluetooth, a DualSense sends its battery level and touchpad only after a program has asked for its full
reports. Steam usually has done this already. Lamplit never asks itself: the switch lasts until the controller turns
off, and older games that read the controller through DirectInput stop working with it.

The DualSense is tested over USB and Bluetooth. The DualSense Edge sends the same reports and is read the same way,
but hasn't been tested. Xbox, Switch and other controllers aren't read yet (see the [FAQ](#faq)).

### Headset

One headset is supported for now: the Logitech G PRO X 2 LIGHTSPEED, through its USB receiver (USB id `046D:0AF7`).
Lamplit implements the receiver's protocol (Logitech's Centurion protocol) for it: it knows when the headset turns on
or off, reads the battery and charging state, and changes sidetone and the auto-off timer. It talks to the receiver
directly, so G HUB isn't needed, and both can run side by side. If something doesn't behave, an issue with the
`headset:` lines from `lamplit.log` helps.

Any other headset works as an ordinary Windows sound device: pick it in Settings > Sound. Support for more headsets
is welcome; [docs/accessories.md](docs/accessories.md) shows how the PRO X 2 protocol is handled.

### PC

- Windows 10 or Windows 11, 64-bit (x64).
- The Microsoft Edge WebView2 Runtime. Windows 11 includes it, and the installer downloads it from Microsoft when it
  is missing.

## Install

1. Download `Lamplit_0.1.0_x64-setup.exe` from the
   [latest release](https://github.com/YordiLorenzo/lamplit/releases/latest).
2. Run it. The installer installs Lamplit for your Windows account only, by default into `%LOCALAPPDATA%\Lamplit`
   (the folder that also holds its settings, logs and art), and adds it to the Start menu. It doesn't ask for admin
   rights.
3. Start Lamplit, then run the [first-time setup](#first-time-setup) so it starts when you sign in.

### Windows warns about the installer

Lamplit's builds aren't code-signed yet, so Windows doesn't recognise the publisher:

- **Your browser** may say the file isn't commonly downloaded. In Edge, open the download's **...** menu, choose
  **Keep**, then **Show more** and **Keep anyway**.
- **SmartScreen** shows "Windows protected your PC" with "Unknown publisher". Click **More info**, then
  **Run anyway**.
- **Smart App Control**, if it is on, blocks unsigned apps and offers no way past. This build can't be installed
  while it is on. Switching it off (Windows Security > App & browser control) is a system-wide security change, so
  weigh it before you do.

Every new version starts with no reputation, so expect the same warnings when you update.

### First-time setup

Lamplit runs with your normal rights. Two jobs need admin rights, so it asks Windows once:

1. **A logon task** that starts Lamplit when you sign in to Windows. Registering a task that runs at sign-in takes
   admin rights.
2. **Steam's background service repaired** with Valve's own repair tool. Otherwise Steam stops to ask for admin
   rights when it updates that service, with a prompt you can't answer from the sofa.

Open Settings (Triangle, or C on a keyboard), go to **System**, and choose **First-time setup**. Answer the Windows
prompt with a mouse or keyboard: it runs on a secure screen that a controller can't reach. You can also run it
from PowerShell opened as administrator; the pipe makes PowerShell wait and show what setup did:

```powershell
& "$env:LOCALAPPDATA\Lamplit\lamplit.exe" --setup | Out-Host
```

On a standard Windows account, the prompt asks for an administrator's password; the logon task is still made for
your own account. Without setup Lamplit works the same, but you start it yourself.

### Updating

Run the new version's installer and install into the same folder. Your settings, art and logon task stay.

### Uninstalling

First switch off **Quiet mode** and **Steam's DevTools port** in Settings: the uninstaller can't undo those. Then
uninstall Lamplit from **Settings > Apps > Installed apps**. Windows usually asks for admin rights to delete the
logon task.
[What Lamplit changes on your PC](docs/security-and-privacy.md#removing-lamplit) has the full list.

## Controls

| | DualSense | Keyboard |
| --- | --- | --- |
| Move along the row | D-pad or left stick, left and right | Left and Right arrows |
| Jump five games | L1, R1 | Page Up, Page Down |
| Play the game, or return to it while it runs | Cross | Enter |
| Game details | Options | I |
| Settings | Triangle | C |
| Find a game | Square | F |
| Back, close, or cancel a launch | Circle | Esc or Backspace |
| Every game again, after a search | Circle | Esc |
| Return to the running game from the row | Circle | Esc |
| Bring Lamplit over a running game | Hold PS for 0.6 seconds | Alt+Tab |
| Close Lamplit | | Alt+F4 |

While a game starts, Cross opens the store app that needs you, Triangle goes ahead without a confirmed sign-in, and
Circle cancels. In Settings, Up and Down move, Cross or Right opens a section, Left and Right change the volume,
sidetone and auto-off timer, Circle goes back, and Triangle closes Settings. In Find, Cross types the key or picks
the choice you're on, Square deletes, Triangle adds a space, and Circle closes Find on the games it found. On a
keyboard, type the name and press Enter.

With a mouse, click a cover to select it and click it again to play. Settings rows take a click too.

## What Lamplit changes on your PC

| Change | When | How to undo it |
| --- | --- | --- |
| A logon task, `lamplit-<your account's SID>`, that starts Lamplit at sign-in | First-time setup | The uninstaller deletes it |
| Steam's background service repaired with Valve's `SteamService.exe /repair` | First-time setup | Nothing to undo: it is Steam's own repair |
| Windows notification, tips and Game Bar settings; Ubisoft Connect's and Steam's notification settings | While quiet mode is on | Switch quiet mode off |
| The file `.cef-enable-remote-debugging` in Steam's folder, and Steam started with `-cef-enable-debugging` | While **Steam's DevTools port** is on (off by default) | Switch it off in Settings > Stores |
| Steam's **Guide Button Focuses Steam** turned off | Whenever Steam's DevTools port is open | Steam > Settings > Controller |
| Windows' default sound output and microphone | When the headset or controller headphones come and go (on by default) | Switch **Sound follows** off in Settings > Sound |
| Mouse input from the DualSense touchpad | While **Touchpad as mouse** is on (off by default) | Switch it off in Settings > Controllers |
| Prefs, logs and art in `%LOCALAPPDATA%\lamplit` | Always | Tick **Delete the application data** when you uninstall |

Lamplit goes online only to fetch game art from Steam's store, and you can switch that off. No accounts, no
telemetry. [What Lamplit changes on your PC, and what it sends](docs/security-and-privacy.md) has every detail,
including the risk of Steam's DevTools port.

## How it compares

|  | Lamplit | Steam Big Picture | Playnite (fullscreen mode) |
| --- | --- | --- | --- |
| Price and source | Free, source on GitHub (noncommercial licence) | Free, closed source | Free, MIT licence |
| Runs on | Windows | Windows, macOS, Linux, SteamOS | Windows |
| Games it lists | Installed games from seven stores and outside any store, found by itself | Steam games; others as shortcuts you add by hand | Games from the libraries you connect through its add-ons, and emulated games |
| Before a game starts | Starts the store apps it needs, waits for sign-in, shows Steam's update progress | Steam updates its own games first | Starts the game through its store or its exe |
| Controllers | DualSense and DualSense Edge; keyboard and mouse | Most controllers, through Steam Input | Many controllers, through SDL |
| Themes, add-ons, emulators | No | No themes or add-ons; emulators as shortcuts you add | Yes, with an add-on browser |
| Also does | Quiet mode, sound that follows the headset, PRO X 2 headset settings, NVIDIA stats switch | Store, friends and chat, Steam Input remapping, Remote Play | Metadata, filters and collections, play time |

Choose Big Picture if nearly everything you play is on Steam, or if your controller isn't a DualSense. Choose
Playnite if you want themes, emulators, or a library you shape yourself. Lamplit is for a TV PC that already has
games in several stores and should show them all without setup.

What comes next, including other controllers and a power menu: [ROADMAP.md](ROADMAP.md).

## FAQ

### Does Lamplit replace Steam?

No. Steam games still start through Steam, which has to be installed and signed in. Lamplit only takes over Steam's
job as the big-screen interface: it closes Big Picture whenever Steam opens it, and with the DevTools port on, it
stops the PS button from opening Big Picture. You don't need Steam at all for games from other stores; art still
comes from Steam's public store website.

### Is it safe to use with anti-cheat?

Lamplit doesn't inject code into games, hook them or draw over them. To know when a game starts and closes, it reads
the list of running processes and the folder each one runs from, as other launchers do. If a game's anti-cheat ever
objects to Lamplit, please open an issue.

### Which controllers work?

The DualSense and DualSense Edge, over USB or Bluetooth. Xbox, Switch and other controllers aren't read yet. Anything
that turns a controller's buttons into keys (Steam's desktop controller layout can do this) works through the
keyboard controls, but holding PS to bring Lamplit forward and the controller rows in Settings need a DualSense.
Support for more controllers is welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

### Why only Windows?

Most gaming PCs run Windows, and the EA app, Ubisoft Connect, the Rockstar Games Launcher and the Xbox app exist only
there. Lamplit is built on Windows' own interfaces: the registry where stores record their games, Task Scheduler,
Windows' sound devices and its Bluetooth stack. A version for another system would be a different program. On Linux,
SteamOS's game mode already does this job for Steam.

### Does it replace the Windows shell?

No. Windows starts as usual, and the logon task starts Lamplit after you sign in. If Lamplit crashes, it starts again
within seconds; after five crashes in two minutes it stops trying until the next sign-in.

### How do I stop it starting at sign-in?

Uninstall it, or open Task Scheduler as administrator and disable or delete the task `lamplit-<your account's SID>`.

### A game is missing, or shows up twice.

Please open an issue with the store, the game's install folder, and the `discovery` lines from `lamplit.log`.

### Where are the logs?

In `%LOCALAPPDATA%\lamplit`: `lamplit.log` for the app, `supervisor.log` for the process that restarts it, and
`setup.log` for first-time setup. They name your games and their folders, so read them before you post one.

### Does it send anything online?

Only requests for game art to Steam's store, and only while **Find art online** is on: the names of games that
aren't from Steam, Steam app ids, and your country. Details are in
[the privacy section](docs/security-and-privacy.md#network-art-only).

## Build from source

You need Windows, Rust 1.95 or newer with the MSVC toolchain, and the Visual Studio Build Tools.

```powershell
git clone https://github.com/YordiLorenzo/lamplit.git
cd lamplit\src-tauri
cargo build --release
```

That gives `target\release\lamplit.exe`, which runs without installing: the page is built into the exe. For the
installer, install the Tauri CLI and build the NSIS bundle:

```powershell
cargo install tauri-cli --version '^2' --locked
cargo tauri build --bundles nsis
```

The installer lands in `target\release\bundle\nsis\`. Cross-building from macOS or Linux, the tests and the code
layout are covered in [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/architecture.md](docs/architecture.md).

## Contributing

Bug reports, games Lamplit misses, new stores, other controllers and headsets are all welcome.
[CONTRIBUTING.md](CONTRIBUTING.md) explains how to build, test and send a change. Please report security problems
privately, as [SECURITY.md](SECURITY.md) describes, not in a public issue.

## Support Lamplit

If Lamplit is how you start your games now, you can support it through
[GitHub Sponsors](https://github.com/sponsors/YordiLorenzo). Sponsorship pays for code signing, so Windows names the
publisher and each new version keeps the trust SmartScreen gave the last one. It also buys more headsets and
controllers for Lamplit to support, and time to work on it.

## Licence

Lamplit is free to use, change and share for any noncommercial purpose, under the
[PolyForm Noncommercial License 1.0.0](LICENSE). Playing games with it at home is exactly what it's for. Selling
it, or bundling it into something you sell, isn't allowed; for any commercial use, open an issue to ask.

It is built with [Tauri](https://tauri.app). The DualSense and headset code follows protocol notes published by
[HeadsetControl](https://github.com/Sapd/HeadsetControl), [Solaar](https://github.com/pwr-Solaar/Solaar),
[SDL](https://github.com/libsdl-org/SDL), [SpecialK](https://github.com/SpecialKO/SpecialK) and the Linux kernel's
`hid-playstation` driver; [docs/accessories.md](docs/accessories.md) lists the sources. The store logos come from
[Simple Icons](https://simpleicons.org) (CC0), and the Xbox logo from
[Material Design Icons](https://pictogrammers.com/library/mdi/) (Apache License 2.0).

Lamplit is not affiliated with or endorsed by Sony, Valve, Microsoft, Logitech, NVIDIA, Epic Games, Electronic Arts,
Ubisoft, Rockstar Games or GOG. Their names, logos and products are trademarks of their owners and appear here only
to say what Lamplit works with. Game art in the screenshots belongs to its publishers.
