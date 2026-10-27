# How Lamplit is built

Lamplit is a [Tauri 2](https://tauri.app) app. A Rust core in `src-tauri/` does everything that touches Windows, and
a page in `ui/` (plain HTML, CSS and ES modules, no bundler and no runtime packages) draws the screen in WebView2.
The page is built into lamplit.exe, so the exe runs without any other files.

## Folders

```text
src-tauri/
  src/
    main.rs          which of Lamplit's processes this is: supervisor, app or setup
    supervisor.rs    restarts the app after a crash
    lib.rs           starts the app: its state, its commands, its background threads
    commands.rs      every command the page calls
    events.rs        every event Rust sends the page
    error.rs         the one error type, sent to the page as { kind, message }
    prefs.rs         the player's choices in Settings (prefs.json)
    data.rs          the data folder and the JSON files in it
    files.rs         path helpers: drive-letter checks, safe joins, atomic writes
    logging.rs       lamplit.log, supervisor.log and setup.log
    library/         the game list: discovery, sorting, art, favourites, hidden games and play time
    stores/          one file per store app; loose.rs finds games outside any store
    launch/          starting a game, watching it, and Lamplit's own window
    devices/         controllers (pad/), the headset, sound devices, where the sound goes
    system/          quiet mode, NVIDIA's overlay, first-time setup, sleep, restart and shut down
    win/             the calls into Windows, and the only place unsafe code is allowed
  capabilities/default.json   what the page may call
  windows/installer-hooks.nsh the uninstaller's extra steps
  tauri.conf.json
ui/
  index.html, style.css
  main.js          starts the page and connects events to their handlers
  api.js           every command and event, with JSDoc types; no other file names one
  state.js         the page's state and its elements
  input.js         controller, keyboard and mouse as one set of actions
  library.js       the cover row and the focused game
  find.js          the Find panel: the on-screen keyboard, the store filter and the sort
  launch.js        the starting screen
  settings.js      the Settings panel
  logic.js         pure functions (the cover row's search and order, the Settings rows), tested in Node
  hints.js         the button hints and short messages
  sounds.js        interface sounds made with Web Audio
  screensaver/     the screensaver: when it shows and what ends it (index.js), the show (saver.js), the WebGL2
                   renderer, the scenes' shaders, palettes from the game art, and preview.html to view it in a browser
tests/
  ipc/             payloads both sides are tested against
  *.test.mjs       the page's tests; page.mjs serves the page with a fake Tauri
  screenshots.mjs  takes the README's screenshots
  fixture-game/    a stand-in game, and fixtures.ps1 to place it, for discovery tests on Windows
scripts/restart.ps1  puts a new build in place during development
.github/             CI (Rust on Windows, the page on Ubuntu), the release workflow, issue forms
```

## Processes

lamplit.exe runs as one of three processes. `main.rs` picks one from the command line:

| Started as | Process | What it does | Log |
| --- | --- | --- | --- |
| `lamplit.exe` (the logon task, the Start menu) | Supervisor | Starts the app as a child process and starts it again when it exits with an error, at most 5 times in 2 minutes. Ends when the app ends cleanly, which is how Lamplit closes. | `supervisor.log` |
| `lamplit.exe --app` | App | The window and everything below. | `lamplit.log` |
| `lamplit.exe --setup [--for <SID>]` | Setup | First-time setup, with admin rights. Settings starts it through Windows' admin prompt and passes its own account's SID, so the logon task is made for that account even when an administrator answers the prompt. | `setup.log` |

The supervisor and the app each hold a named mutex (`Local\lamplit-supervisor`, `Local\lamplit-app`). A second
Lamplit brings the first one's window forward and exits. Task Scheduler only restarts a task that fails to start, not
one that crashes later, which is why the supervisor exists.

Lamplit keeps its files in the data folder, `%LOCALAPPDATA%\lamplit`: `prefs.json`, `games.json` (per game id:
favourite, hidden, when it was last played and how long Lamplit saw it run; 0.1.0's `played.json` is still read for
the last-played times), `art.json` and `art\<steam appid>\` (art lookups and downloads), `setup.json` (setup is
done, for which exe) and `quiet-saved.json` (the settings quiet mode replaced), plus the logs. WebView2 keeps its
profile in `%LOCALAPPDATA%\io.github.yordilorenzo.lamplit`.

## Inside the app

`lib.rs` loads the prefs, starts the first library scan and these threads:

| Thread | Does |
| --- | --- |
| Library scan | Reads every store side by side, then games outside any store, then art on disk, then missing art online. Runs at start and when the page asks (each time Lamplit comes forward), at most every 30 seconds. |
| Headset | Looks for the PRO X 2 receiver every 10 seconds and owns it while it is plugged in. |
| Controllers | Looks for DualSense controllers every 2 seconds and reads each one on a thread of its own. |
| Other controllers | Reads XInput and Windows.Gaming.Input every 15 ms while one of their controllers is connected, and looks for new ones every 2 seconds. |
| Upkeep | Every 10 seconds: Steam's DevTools port and PS button setting, and quiet-mode changes that had to wait. |
| Big Picture guard | Every 2 seconds: closes Steam's Big Picture mode if it is open. |
| Shell | Opens links and exes with ShellExecute, one at a time. |

A Tauri command that isn't `async` runs on the main thread, where waiting freezes the window and controller
navigation. So every command that touches the disk, the registry, COM, HID, a socket or the process list is `async`
and does its work on Tauri's pool for blocking work.

Controller presses reach the page as `pad` events only while Lamplit's window is in front, so a game never moves the
menu behind it. Holding PS, or View and Menu, is the exception: it brings Lamplit forward from anywhere. Each kind of
controller is read into the same buttons, by position (south is Cross or A), so navigation doesn't care which it is.

## How a launch works

1. The page calls `launch_start` with the game's id and shows the starting screen.
2. Rust starts a new launch generation, so an older launch's checks stop, and keeps the PC and the screen awake.
3. For each store app in the game's `requires` list (its own store, then any publisher's launcher), `launch/mod.rs`:
   - stops with an error if the store app isn't installed;
   - starts it if it isn't running, and waits up to 90 seconds for it;
   - waits up to 45 seconds more for a saved sign-in to go through;
   - otherwise shows "Sign in to ..." and waits up to 15 minutes for a sign-in, or for the player to choose
     Try anyway.

   Each of these is a line on the starting screen, sent as a `launch-step` event.
4. For a Steam game, a line says whether an update is needed first.
5. Lamplit opens the game: the store's link (`steam://rungameid/<appid>` for Steam) or the game's exe.
6. `launch/watch.rs` reads the process list once a second. A process counts as the game when its exe is inside the
   game's folder, or has one of the game's exe names:
   - Seen for 1.5 seconds: the game runs. A `play` event says `running`, Lamplit minimises itself and records the
     time in `games.json`.
   - While it runs: the time between two polls that both see it counts as play time, at most 5 seconds per poll (a
     longer gap is the PC asleep). It is saved to `games.json` every minute and when the game's processes go.
   - Gone again within 20 seconds of starting: a launcher handing over to the game, or a crash at start. A `play`
     event says `starting`, Lamplit comes forward and keeps waiting.
   - Gone for 5 seconds after a longer run: the game has ended. A `games` event brings the new play time, a `play`
     event says `ended`, Lamplit comes forward, and after a Steam game it minimises Steam's window.
   - Nothing after 45 seconds and no download running: a hint that the store app may need the player. Nothing after
     3 minutes: a warning, and Lamplit keeps waiting until the player cancels. A Steam download holds this timeout
     off.
7. A launch that can't go on ends with a `play` event that says `failed`, with a message for the player.

## Commands

The page calls these with `invoke` (wrapped in `ui/api.js`). Tauri hands the page's camelCase argument keys to the
snake_case parameters in `commands.rs`. A failed command rejects with `{ kind, message }`: `kind` is `player` when the
message is written for the player, and the page shows it.

| Command | Arguments | Returns |
| --- | --- | --- |
| `library_games` | | Every game, or `null` until the first scan has finished |
| `library_rescan` | | Nothing; scans unless the last scan was under 30 seconds ago |
| `library_set_favourite`, `library_set_hidden` | `id`, `on` | Every game, after the change |
| `launch_start` | `id` | Nothing; `launch-step` and `play` events follow |
| `launch_anyway` | | Nothing; the launch goes ahead without a confirmed sign-in |
| `launch_cancel` | | Nothing |
| `launch_resume` | | Nothing; brings the running game's window forward |
| `launch_running` | | The running game's id, or `null` |
| `stores_status` | | Every store app: installed, running, account state |
| `stores_open` | `store` | Nothing; brings that store app's window forward |
| `overlay_state` | | Whether NVIDIA's overlay is installed and its stats show |
| `overlay_toggle_stats` | | Whether the stats show now, or `null` when the overlay doesn't say |
| `quiet_state` | | Quiet mode: `on`, `off` or `partly`, and notes for the player |
| `quiet_set` | `on` | The same report, after the change |
| `setup_state` | | Whether setup is needed |
| `setup_start` | | Nothing, once the admin prompt is answered; a `setup` event follows |
| `sound_state` | | Outputs, microphones, volume and mute |
| `sound_set_default` | `id` | The sound state after the change |
| `sound_change_volume` | `delta` | The new volume |
| `sound_set_mute` | `mic`, `muted` | Nothing |
| `accessories_state` | | The headset and the controllers |
| `headset_set` | `setting` (`sidetone` or `auto-off`), `value` | The headset's state, read back |
| `controller_turn_off` | `id` | Nothing |
| `controller_kind` | | The kind of controller used last (`dualsense`, `playstation`, `xbox`, `other`), or `null` before any was |
| `prefs_state` | | The prefs |
| `prefs_set_sound_follows`, `prefs_set_touchpad_mouse`, `prefs_set_steam_devtools`, `prefs_set_online_art` | `on` | The prefs after the change |
| `prefs_set_screensaver_minutes` | `minutes` (0 for never) | The prefs after the change |
| `prefs_set_screensaver_style` | `style`: `mix`, `2d` or `3d` | The prefs after the change |
| `power_sleep` | | Nothing, once the PC has woken up again |
| `power_restart`, `power_shut_down` | | Nothing, once Windows has started to restart or shut down |
| `display_mode` | | The screen's mode, such as `3840 × 2160 at 120 Hz` |

## Events

Rust sends these without being asked (`events.rs`):

| Event | Payload | When |
| --- | --- | --- |
| `games` | Every game | The game list changed, or a game that ran has ended with more play time |
| `art` | `{ id, art }` | Art for one game came in |
| `pad` | `up`, `down`, `left`, `right`, `ok`, `back`, `menu`, `triangle`, `l1`, `r1` or `square` | A controller press, while Lamplit is in front |
| `pad-kind` | `dualsense`, `playstation`, `xbox` or `other` | Another kind of controller than before was used; the hints show its buttons |
| `play` | `{ state, id }`, plus `message` when `state` is `failed` | A launched game is `running`, `starting` again, `ended` or `failed` |
| `summoned` | The running game's id, or `null` | Holding PS, or View and Menu, brought Lamplit forward |
| `launch-step` | `{ id, key, state, label, store }` | A line of the starting screen; a step with the same `key` replaces the line |
| `stores` | Every store app's status | After each library scan |
| `accessories` | `null` | The headset, a controller or a sound device changed; the page asks for the details |
| `notice` | A short message | Something the player should know, such as where the sound went |
| `setup` | `{ needed }` | Setup started from Settings has ended |

## Keeping the two sides in step

The payloads live once, in `tests/ipc/*.json`. Rust tests compare what Rust sends with them (the `ipc_fixture!` macro
reads them at build time), and the page's tests feed the same files to the page. `tests/ipc/values.json` lists every
value of the enums the page branches on. `tests/contract.mjs` reads `lib.rs`, `commands.rs`, `events.rs` and
`ui/api.js` and fails when a command, an argument or an event exists on one side only. To add a command: write it in
`commands.rs`, register it in `generate_handler!` in `lib.rs`, add its wrapper to `ui/api.js`, and add a fixture
when it returns something new.
