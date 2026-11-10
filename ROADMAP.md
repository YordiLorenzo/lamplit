# Roadmap

What comes next for Lamplit, and what stays out. Plans can change; to suggest something, open an issue.

Lamplit stays a home screen for the games you already have, driven from the sofa, with nothing to set up. The next
releases make that promise hold on more PCs before they add much that is new: a download Windows trusts, updates and
undo from the controller, no dialog that needs a mouse, and a TV that is set up once.

## Done

0.4.0 (2026-11-09) brought updates from the sofa, Start when I sign in without an admin prompt, Restore
Lamplit's changes, Save a report, Exit to Windows, interface sounds, two first-minute hints, and Epic's new
launcher. Lamplit's listing on WinGet waits for Microsoft's review.

0.3.0 (2026-10-30) brought the in-game dock, a screensaver, a game's menu, Change art, Add a game by hand, and
Battle.net, the Amazon Games app and itch.io.

0.2.0 (2026-10-26) brought other controllers, a power menu, Find a game, favourites and hidden games, and play time.

[CHANGELOG.md](CHANGELOG.md) has every change.

## Next: 0.5, every game worth a look

- **A trailer on the focused game.** Rest on a cover for a moment and its trailer plays behind it, muted unless
  you choose sound. Settings can switch it off.
- **A page for each game,** from its menu: what the game is, who made it, when it came out, and its screenshots.
- **Your captures,** from the game's menu: the screenshots you took in it with Steam, the Game Bar or the NVIDIA
  app.
- **A list of what's been tested:** controllers (Xbox over its adapter, Bluetooth and USB, DualSense Edge, DualShock
  4, 8BitDo, the new Steam Controller), the dock over real games, and Windows' Xbox mode next to Lamplit.

## 0.6, never reach for the mouse

- **Control this window.** When a store app shows a sign-in or a question Lamplit can't answer, the stick moves a
  pointer and the on-screen keyboard types into that window, with any controller. One press brings you back.
- **Every action from the d-pad, Cross and Circle.** Settings, Find, a game's menu and the dock each get a place you
  can move to, so a TV remote, a Flirc or one hand is enough. Every hold also has a press that does the same.
- **Which controller is which.** Settings > Controllers > Press a button lights up the controller you press, with its
  connection and battery, and offers to ignore the copy Steam Input or DS4Windows makes of it.
- **After sleep,** Lamplit finds the controllers, the sound output and the screen again. A wake check shows which
  devices can wake the PC. Hibernate joins the power menu where the PC supports it.
- **Lamplit through Moonlight.** A tested app entry for Sunshine and Apollo: Lamplit opens on the stream's screen and
  sound, and a game keeps running when the stream drops for a moment.

## 0.7, the TV, set up once

- **Play on TV.** Choose the TV once. Lamplit moves itself and the sound there, switches the desk monitors off if you
  like, and puts the desk back when you leave. Each change asks "Keep this?" and undoes itself after 15 seconds
  without an answer.
- **HDR per game:** on, off or as it was, and back to how it was when the game closes.
- **Resolution and refresh rate per game,** chosen from what the TV offers.
- **Sound by name.** Call outputs "TV" or "Headphones", keep your choice when a device comes and goes, and set the
  game and a voice chat apart in the dock.
- **Quiet only while playing,** and the Game Bar's recording kept apart from pop-ups, so quiet mode no longer turns
  off clips.
- **Turn the TV on, on the right input,** paired once over the network: Google TV first, other TVs through Home
  Assistant.
- **A restart waiting for Windows Update** shows in Settings, with a button that opens Windows Update.

## 0.8, your library, your way

- **Shortcuts you already made.** Steam's non-Steam shortcuts and your own shortcut files, started the way they're set
  up, through Steam when that's how they get Steam Input. Emulator shortcuts made elsewhere come in the same way.
- **GOG games through GOG Galaxy** when it's installed, so cloud saves sync. Without it, they start as they do now.
- **More places games come from:** Heroic, the Riot Client, and Legacy Games, whose store closes on 2026-12-31 while
  its installed games keep running.
- **One game, one cover.** A game installed from two stores shows once, and its menu picks which one to start.
- **Your own art:** a cover, background or logo from a file on the PC, and the art you set for your Steam shortcuts.
- **Recently played and recently installed,** and a few collections of your own, all made with the controller.
- **Play together:** the games with local co-op or versus, from Steam's store pages, shown only where it's known.
- **New games show up at once,** while their art still downloads.

## 0.9, readable for everyone

- **Bigger text and high contrast,** focus shown by shape as well as colour, and reduced motion as a Lamplit setting.
- **Screen readers.** Narrator and NVDA read the home screen, the menus and the dock.
- **Real text fields:** paste, accents, Chinese and Japanese input, and Windows dictation.
- **More languages:** Simplified Chinese, Russian, Spanish, Brazilian Portuguese, German, Japanese and French.
- **Change Lamplit's own buttons,** for one-handed play or a remote with few keys. Games keep their controls.
- **Handheld screens,** from 800p to 1200p, with touch, the handheld's own battery, and a lighter screensaver on
  battery.

## Later

Ideas we like, in no order and without a date:

- A signed download, so Windows names who made Lamplit and Smart App Control lets it install.
- Your screenshots as a game's background and in the screensaver.
- A screenshot or the last 30 seconds as a clip, from the dock, through the NVIDIA app or the Game Bar.
- Pause and skip the music that's playing, and mute the microphone, from the dock.
- A sleep timer that turns the PC off after the game you're in.
- "What changed" in a game's menu, from its patch notes.
- A look back at the year: what you played on this PC, and for how long.
- A guest view for visitors: a row you choose, with editing off.
- Games you uninstalled, kept in a separate row with Open in store.

## Not planned

If you're looking for one of these, other tools do it well:

- **Themes, add-ons and emulators:** [Playnite](https://playnite.link), or [ES-DE](https://www.es-de.org) for
  emulators. Emulator shortcuts set up there can come into Lamplit (0.8).
- **A store, friends and chat:** [Steam's Big Picture mode](https://store.steampowered.com/bigpicture).
- **A streaming app of its own:** [Sunshine](https://github.com/LizardByte/Sunshine) with
  [Moonlight](https://moonlight-stream.org), or [Steam Remote Play](https://store.steampowered.com/remoteplay).
  Lamplit works as the app they start (0.6).
- **Button remapping in games:** Steam Input, in Steam's controller settings. Lamplit leaves your controller to it.
- **Achievements:** the store apps already show them.
- **Signing in to stores for you:** Lamplit never asks for or keeps a password. It waits while the store app signs
  in, and 0.6 lets you type into it.
- **Replacing the Windows desktop:** Lamplit starts after sign-in and keeps Windows one button away.
- **Quick Resume, power limits, fans or graphics settings:** the handheld's own app, the NVIDIA app or AMD Software.
- **Parental controls and separate saves for each person:**
  [Microsoft Family Safety](https://www.microsoft.com/microsoft-365/family-safety) and
  [Steam Families](https://help.steampowered.com/en/faqs/view/054C-3167-DD7F-49D4).
- **Anything inside a game:** no injection, hooks or overlays, so anti-cheat has nothing to object to. The dock is
  Lamplit's own window above the game.
