# Changelog

Every release of Lamplit, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- The in-game dock: holding PS over a game (View and Menu on an Xbox controller) opens a small dock along the bottom of
  the screen instead of the whole home screen. It springs open out of a pill on the bottom edge and folds back into it,
  what it shows fading as it goes; with Windows' animation effects off, it fades in and out where it is. It holds the
  volume, the sound output, quiet mode, NVIDIA's stats, Home and Close game, and shows the game with its cover and play
  time, the batteries and the time, in the colours of the game's art. On Windows 11 22H2 or later, with transparency
  effects on, it rests on Windows' own glass: a live blur of the game behind it. Holding Cross on Close game asks the
  game to close, and the dock offers Force close, held the same way, when the game isn't responding. The folded dock
  also shows for a moment when the headset turns on or off, a controller connects or disconnects, or a battery runs low.
  It is Lamplit's own window above the game, and over a game in exclusive full screen holding PS brings the home screen
  as before. Settings > Overlay and pop-ups switches it off. It moves on the home screen's springs and draws its icons:
  Close game shows an app window with a cross rather than the power symbol. Lamplit's log has a line on how smoothly
  each of the dock's animations ran.
- A screensaver. After a few minutes without input, while Lamplit is in front and no game runs, generative art covers
  the screen, so a still home screen can't mark an OLED TV: seven scenes drawn with WebGL2 (Gallery, Drift, Dunes,
  Ocean, Ink, Nebula and Aurora), coloured from the art of your games, and finished with a soft bloom, a filmic tone
  curve and depth of field. Gallery shows your covers in a dark room with a glossy floor, and Drift turns one game's
  hero art into another's through thousands of points of light; over the other five a game's logo or name drifts
  faintly. A new scene comes in every minute and a half or so, in a crossfade, through the dark parts first, through
  drifting noise or pushing in, and after an hour it fades to black. The first press only ends it. Lamplit gets the
  screensaver ready in the background while it sits unused for a moment, or as Settings > Screensaver opens, and keeps
  its art between shows, so it comes and goes without a stutter. Settings > Screensaver sets the delay (Off, 2, 5, 10
  or 20 minutes; 5 by default) and shows it now. Without WebGL2 it shows a moving gradient.
- `ui/screensaver/preview.html` shows the screensaver's scenes in a normal browser, for working on them.
- Battle.net: its installed games, from Battle.net's own list. Lamplit starts Battle.net, waits until its log says it
  has signed in, and asks it to start the game. A game too new for Lamplit's list of launch codes opens on its page
  in Battle.net, where you press Play.
- The Amazon Games app: its installed games, from the app's own list. They start through the app, which Lamplit
  starts first.
- itch.io: the games the itch app installed, from its own list. They start as the itch app would start them: the
  exe and arguments the game's launch manifest (`.itch.toml`) names, else the exe the app found, so the app doesn't
  have to run. Of several, the one you picked in the itch app goes first. A game the itch app runs in its sandbox
  starts through the app's launcher, `itch-setup --run-game` (itch 26.20 or newer), so it stays in the sandbox, and
  so does a game that asks the app for an itch.io API key, which only the app hands out. So does a game that may
  still need prerequisites the app installs before starting it, such as a VC++ or .NET runtime: on its first start
  from an install, and while its manifest names one not yet installed. So does a game you set a command template for
  in the itch app (arguments, environment variables or a wrapper). A game installed from two of its downloads
  starts from the one you used last, as the itch app starts it.
- The three stores have their own choice in Find's store filter, and their apps show in Settings > Stores. Battle.net
  and itch.io games carry the store's logo; the Amazon Games app has no logo Lamplit can use, so it shows its name.
- A game's menu (Options, or Menu on an Xbox controller) lifts the game's cover out of the row toward you, blurs the
  rest of the screen, and opens beside the cover with the game's details and choices.
- Change art, in a game's menu, for when Lamplit matched the wrong game on Steam's store. It shows what Steam's store
  finds for the game's name as covers to pick from, and the search can be edited on the on-screen keyboard. "No art,
  show the name" shows the game's name instead, and "Back to automatic" undoes the choice. The choice is kept in
  `games.json`, so it lasts through restarts and new scans.
- Add a game by hand, from Settings > Add a game, or with Cross on the empty home screen when Lamplit found no games:
  one of the installed programs Lamplit didn't take for games, or an exe found by browsing the PC's drives and
  folders. Name it on the on-screen keyboard, which has Shift and the signs game names use, then choose its art.
  Lamplit starts it from its exe, like a game outside any store, and its menu has Remove from Lamplit.

### Changed

- What can't be taken back is held, as the dock's Close game: Remove from Lamplit, Restart, Shut down, and Close game,
  which the game menu now offers while its game runs. Holding Cross fills a ring round the choice's icon, and it
  happens once the ring is full; let go before, and nothing happens. Each says beforehand what it does ("Closes
  Titanfall 2", "Lamplit forgets it. The files stay."), and Restart and Shut down name a running game that will
  close. Sleep and Hide this game can be undone, so one press does them. A mouse holds from button down to up.
- A game's menu grows out of the lifted card: a sliver on the card's edge widens into the menu, and its rows fade in
  as it does. Under the game's name one line says its store, when it was last played and for how long, and the
  folder sits dim at the bottom. Play (or Back to game) is lit and comes first, every choice has an icon, and
  Favourite is one choice that fills its star. Change art opens in the same panel, which grows from the menu's size
  to its own, and the card fades from one cover to the next as you move through the choices. The background keeps
  drifting under the menu, so Change art closes without a stutter.
- Find works on the line above the row instead of in a panel over it. The search field stands there, with a chip for
  the store and one for the sort beside it and how many games the row holds. The keyboard grows up out of the field,
  and the store chip opens a list of store logos upward. A search already set widens from its pill into the field and
  goes back into it. The row stays in full view below as the results, the game's details fade while you search, and
  one focus ring moves across the keys and the chips.
- On the starting screen, the step that may need you carries what Cross (A) does as a chip on its line, Show the
  window or Open Steam, as well as in the hints, and a click on it does it. Each step's mark is one of the shared icons
  rather than a text character.
- Messages on the home screen are pills, as the dock's news, each with an icon. One about a game stands on the line
  above the row and names the game; any other shows at the top right, under the clock. Neither covers the games.
- Everything on the home screen moves on one set of springs, named for what they move. A step along the row no longer
  overshoots its place; Settings, Find and messages open on one spring and close on a quicker one; the game menu's card
  lifts a little past its place and settles, and lowers without.
- The home screen's icons are drawn in the dock's style, with thin round strokes: the search field's glass, the
  controller's buttons and Add a game's drives, folders and programs.
- Settings, Find, the game menu, Change art and messages are drawn on one glass: the same fill, rim of light,
  shadow and corners. The glass is a little darker over bright art, so text on it stays readable.
- With Reduce Motion on, Settings, Find, Add a game and messages fade in place rather than sliding, the covers move
  without overshooting, and the end of the row no longer bumps.
- Add a game opens inside the Settings panel rather than as a second panel over it: Settings moves out, the panel
  widens, and Add a game comes in. Back returns to Settings on Add a game. On the empty home screen the panel grows
  out of the "No games found" line, and goes back into it.
- Lamplit coming forward over a running game (holding PS, or the dock's Home) no longer appears at once: the home
  screen settles in under a veil in the game's colours, on the game. From the dock, the veil first comes over the game.
  Back to game does the reverse: the home screen eases out under the veil before the game comes forward.
- The first press after Lamplit starts, the first step to each game and the first Find no longer drop frames on a
  4K TV. Settings, Find and Add a game close without a stutter: the background keeps drifting under them, so the
  graphics card doesn't drop to its idle speed while they're open. Find fits a 16:9 screen without scrolling,
  also with games from every store.
- Settings' quiet mode row shows how you switched it. Switched off where Windows' own settings were already quiet, it
  says Off, and that Windows is quiet on its own, rather than On.
- Games from these three stores no longer turn up as games outside any store.
- The button hint for a game's details says Game menu.
- Exes in Windows' cache of installers (`Package Cache`) are no longer taken for games outside any store.
- Bringing Lamplit over a game no longer waits on a game that stopped responding.
- Starting a game no longer shows the desktop, store apps' windows, a game's splash or the taskbar. The starting
  screen stays in front until the game's window covers the screen, fades to black, and hands the screen over. Lamplit
  then waits behind the game rather than minimising, so the desktop doesn't show when the game closes either. A window
  that may need you gets a line on the starting screen, which Cross (A) shows.

## 0.2.0 - 2026-10-26

### Added

- Store logos: in the store badge on the home screen, in a game's details, on the starting screen and in
  Settings > Stores.
- Settings > Power: sleep, restart and shut down. Cross asks once to confirm, and names a running game that
  restarting or shutting down would close.
- Play time for each game, on the home screen and in its details: Steam's own count for a Steam game, else the time
  Lamplit sees the game running.
- Favourites, which come first in the row, and hidden games, which leave it, both set from a game's details.
  Settings > Hidden games shows a hidden game again.
- Find a game: Square (F on a keyboard) opens a search with an on-screen keyboard, which narrows the row as you type.
  It matches the start of any word in a game's name, or its first letters, such as "rdr" for Red Dead Redemption 2.
  It also shows one store's games, and sorts the row A to Z. The home screen shows what narrows the row, and Circle
  brings every game back.
- Xbox controllers and others that work like one, read through XInput, and other controllers Windows knows (a
  DualShock 4, a Switch Pro Controller), read through Windows.Gaming.Input. Holding View and Menu for a second brings
  Lamplit over a game from an Xbox-style controller. The button hints show A, B, X and Y when one of these was used last,
  and Settings > Controllers lists every controller with its name, connection and battery. Not yet tested on real
  Xbox or other controllers.

### Changed

- Triangle opens Settings also when the row is empty, so Power and Hidden games are always in reach.
- A held key repeats only the arrows, as a held button on the controller does.
- Lamplit keeps what it knows per game in `games.json`; the `played.json` of 0.1.0 is still read.

## 0.1.0 - 2026-10-26

The first public release, free for noncommercial use under the PolyForm Noncommercial License 1.0.0.

### Added

- A full-screen home screen with one row of covers for every installed game from Steam, the Epic Games Launcher,
  GOG, the EA app, Ubisoft Connect, the Rockstar Games Launcher and the Xbox app, and for games outside any store:
  folders in `<drive>:\Games`, installed programs that look like games, and games Windows' Game Bar has seen. Last
  played first.
- Cover, background and logo art from Steam's library cache, else from Steam's public store, which is also searched
  by name for games from other stores. **Find art online** switches the online part off.
- Launching that starts each store app a game needs (including the launchers some publishers add), waits for it to
  sign in, shows Steam's update progress, steps aside while the game runs and comes back when it closes.
- DualSense and DualSense Edge over USB and Bluetooth: navigation, holding PS to bring Lamplit over a running game,
  battery, the headphone jack, Turn off for a controller on Bluetooth, and the touchpad as a mouse.
- Logitech G PRO X 2 LIGHTSPEED: on or off, battery, sidetone and the auto-off timer. Not yet confirmed on a real
  headset.
- Sound settings: output, microphone, volume and mute, and sound that follows the headset and controller headphones.
- Quiet mode for Windows' notifications and tips, Game Bar, Ubisoft Connect and Steam, which puts every setting back
  when switched off.
- A switch for NVIDIA's performance stats overlay.
- Steam's DevTools port as a setting, off by default, for keeping the PS button out of Big Picture and for Steam's
  notifications in quiet mode.
- First-time setup with one admin prompt: a logon task that starts Lamplit at sign-in, and a repair of Steam's
  background service.
- A per-user installer. The uninstaller deletes the logon task and, if you tick the box, Lamplit's data.
- Keyboard and mouse controls.
