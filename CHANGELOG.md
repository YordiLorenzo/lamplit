# Changelog

Every release of Lamplit, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Store logos: in the store badge on the home screen, in a game's details, on the starting screen and in
  Settings > Stores.
- Xbox controllers and others that work like one, read through XInput, and other controllers Windows knows (a
  DualShock 4, a Switch Pro Controller), read through Windows.Gaming.Input. Holding View and Menu for a second brings
  Lamplit over a game from an Xbox-style controller. The button hints show A, B and Y when one of these was used last,
  and Settings > Controllers lists every controller with its name, connection and battery. Not yet tested on real
  Xbox or other controllers.

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
