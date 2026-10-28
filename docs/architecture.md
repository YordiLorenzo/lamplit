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
    library/         the game list: discovery, sorting, art and the art the player chose, favourites, hidden
                     games, play time, and games added by hand
    stores/          one file per store app; loose.rs finds games outside any store
    launch/          starting a game, watching it, handing the screen over to it, and Lamplit's own window
    dock/            the in-game dock: its window over a game, the news it shows, closing the game
    devices/         controllers (pad/), the headset, sound devices, where the sound goes
    system/          quiet mode, NVIDIA's overlay, first-time setup, sleep, restart and shut down
    win/             the calls into Windows, and the only place unsafe code is allowed
  capabilities/default.json   what the page may call
  capabilities/dock.json      the same for the in-game dock's page
  windows/installer-hooks.nsh the uninstaller's extra steps
  tauri.conf.json
ui/
  index.html, style.css
  main.js          starts the page and connects events to their handlers
  api.js           every command and event, with JSDoc types; no other file names one
  state.js         the page's state and its elements
  input.js         controller, keyboard and mouse as one set of actions
  library.js       the cover row, the focused game and its menu
  lift.js          a game's menu lifting its cover over the blurred screen
  art.js           Change art, in a game's menu
  add.js           Add a game: the programs Lamplit passed over, browsing the drives, naming the game
  keyboard.js      the on-screen keyboards: Find's, and the one for names and art searches
  find.js          the Find panel: the on-screen keyboard, the store filter and the sort
  launch.js        the starting screen
  settings.js      the Settings panel
  logic.js         pure functions (the cover row's search and order, the Settings rows), tested in Node
  hints.js         the button hints and short messages
  sounds.js        interface sounds made with Web Audio
  screensaver/     the screensaver: when it shows and what ends it (index.js), the show and the games' art it loads
                   (saver.js), the WebGL2 renderer with its particles, the scenes' shaders, palettes from the game art,
                   and preview.html to view it in a browser
  dock.html, dock/ the in-game dock's page: main.js draws it and acts on presses, logic.js (pure, tested in Node)
                   works out its tiles, hints and spring, dock.css
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
favourite, hidden, when it was last played, how long Lamplit saw it run, the art the player chose, and for a game
added by hand its name and exe, or that it was removed again, which keeps it off the row when a scan finds its exe
outside any store; 0.1.0's `played.json` is still read for the last-played times), `art.json` and
`art\<steam appid>\` (art lookups and downloads), `setup.json` (setup is done, for which exe) and `quiet-saved.json`
(the settings quiet mode replaced), plus the logs. WebView2 keeps its profile in
`%LOCALAPPDATA%\io.github.yordilorenzo.lamplit`.

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
| Dock news | Every second: compares the headset and the controllers with a second before, for the news the folded dock shows. |
| Shell | Opens links and exes with ShellExecute, one at a time. |

A Tauri command that isn't `async` runs on the main thread, where waiting freezes the window and controller
navigation. So every command that touches the disk, the registry, COM, HID, a socket or the process list is `async`
and does its work on Tauri's pool for blocking work.

Controller presses reach the page as `pad` events only while Lamplit's window is in front, and the dock's page as
`dock-pad` events only while the dock is open, so a game never moves the menu behind it. Holding PS, or View and
Menu, is the exception: over a running game it opens the dock, and anywhere else it brings Lamplit forward. Each kind of
controller is read into the same buttons, by position (south is Cross or A), so navigation doesn't care which it is.

## How a launch works

1. The page calls `launch_start` with the game's id and shows the starting screen.
2. Rust starts a new launch generation, so an older launch's checks stop, and keeps the PC and the screen awake.
   Lamplit holds the screen (`launch/window.rs`): its window is topmost, raised again every 250 ms because Windows
   puts the taskbar back on top whenever another window takes the foreground, and counts as in front for the
   controller. It takes the foreground back from a window that opens later only during the checks in step 3 and while
   it offers a window that may need the player (step 6), and never while a window of the game's covers the screen:
   a game may need the foreground to set its screen mode.
3. For each store app in the game's `requires` list (its own store, then any publisher's launcher), `launch/mod.rs`:
   - stops with an error if the store app isn't installed;
   - starts it if it isn't running, and waits up to 90 seconds for it;
   - waits up to 45 seconds more for a saved sign-in to go through;
   - otherwise shows "Sign in to ..." and waits up to 15 minutes for a sign-in, or for the player to choose
     Try anyway.

   Each of these is a line on the starting screen, sent as a `launch-step` event. While it waits, the starting screen
   takes the keyboard back about once a second from a store app's window that took the foreground, so Enter and
   Escape reach it, until the player opens that app (Open the store app, Show it) and Lamplit lets go.
4. For a Steam game, a line says whether an update is needed first.
5. Lamplit opens the game: the store's link (`steam://rungameid/<appid>` for Steam), the store app told which game
   to start (`Battle.net.exe --exec="launch <code>"`), or the game's exe.
6. `launch/watch.rs` reads the process list once a second. For a store's game, a process counts as the game when its
   exe is inside the game's folder, or has one of the game's exe names:
   - Seen for 1.5 seconds: the game runs, and Lamplit records the time in `games.json`.
   - Every 250 ms until then, `launch/handover.rs` judges the windows that opened since Play, and the game's own
     windows also when they were open already (a game that runs already, which the launch brings back). A window of
     the game's processes that covers the screen and answers Windows for half a second is up: a `play` event says
     `up` and the page fades to black, then Lamplit places itself right behind that window and gives it the
     foreground, and a `play` event says `running`. The session counts as started from then on (so its end is told
     even when it comes within the first 1.5 seconds). Lamplit stays there, not minimised (restored without taking
     the foreground, if Open the store app minimised it), while the game runs. A window that goes during the fade (a
     game that replaces its window) leaves the launch and its starting screen going until the next one is up. Any
     other window that stays 5 seconds (a store app's, also one that opens maximised, or a small window of the
     game's) gets a `window` line on the starting screen, which `launch_show` brings forward: the newest such window,
     and once it goes, the one before it again. While it offers one, the starting screen keeps the keyboard, so Enter
     and Escape reach Show it and Cancel. With none left, the line says the window has closed, and Cross goes back to
     a store app that may still need the player. Only the player gives such a window the screen. After the game has
     run 12 seconds with only small windows of its own, the front one gets the screen.
   - For a game outside any store, added by hand or found (Windows' game list may name an exe in Downloads, which
     then counts as its folder), the game's processes are the exe Lamplit started and every process that came from
     it, wherever it runs from, leaving out Windows' own helpers (a shell, a console host) on the way, and the
     player's own programs it may open, with what they start: a browser, a store or chat app (`NOT_THE_GAME` in
     `watch.rs`). Lamplit keeps each of the game's processes open until a poll finds it gone (the exe it started,
     from launch on), so meanwhile Windows gives its id to no other program: a process whose parent has that id came
     from it. A launcher that starts the game and exits before the first poll still leads to it, and so does a helper
     between them that no poll saw: a process in the game's folder that started after the launcher and whose parent
     has ended is the game's (one the player opens there has a parent that runs, such as Explorer), and a program
     that gets a launcher's id once it has gone is not the game.
   - While it runs: the time between two polls that both see it counts as play time, at most 5 seconds per poll (a
     longer gap is the PC asleep). It is saved to `games.json` every minute and when the game's processes go.
   - Gone again within 20 seconds of starting: a launcher handing over to the game, or a crash at start. A `play`
     event says `starting`, Lamplit holds the screen again and keeps waiting.
   - Gone for 5 seconds after a longer run: the game has ended. A `games` event brings the new play time, a `play`
     event says `ended`, Lamplit comes forward, and after a Steam game it minimises Steam's window.
   - Nothing after 45 seconds and no download running: a hint that the store app may need the player. Nothing after
     3 minutes: a warning, and Lamplit keeps waiting until the player cancels. A Steam download holds this timeout
     off.
7. A launch that can't go on ends with a `play` event that says `failed`, with a message for the player.

## The in-game dock

`dock/` and `ui/dock.html` make a second window, `dock`, transparent and topmost, out of the taskbar and Alt+Tab. It
is made hidden at start while the dock is switched on, since a WebView2 page takes a moment to load, and Lamplit
shows, places and hides it with `win/dock.rs` rather than Tauri, which can only show a window by focusing it.

- **Holding PS** (`dock::summon`) opens the dock when a game runs, Lamplit isn't in front and Windows doesn't report
  a Direct3D app in exclusive full screen (`SHQueryUserNotificationState`); otherwise Lamplit comes forward as
  before. A second hold folds the dock. Over exclusive full screen, Windows shows no other window, and one that takes
  the foreground makes the game leave full screen.
- **Open**, the window covers the game's screen, transparent but for the dock, and takes the foreground, as the home
  screen does. The island takes its size at once, while it still shows nothing, clipped to the pill at its bottom
  centre. Once two frames in a row have come on time (or 100 ms in), the clip springs open: the folding below in
  reverse, with nothing laid out per frame. The window's first frames over the game come late while Windows composes
  the screen anew, and the spring waits them out. When a game starts the hidden page gets ready (it
  reads what it shows, draws and decodes the art, and works out the open layout once), and the real glass is made with
  the window, so the first opening has nothing to do but open.
  A window that left the game the foreground (`WS_EX_NOACTIVATE`) would leave the game reading every press: XInput,
  HID and Steam Input don't say which app a press is for. Games are expected to ignore the controller while another
  window is in front (`XInputEnable` is meant for `WM_ACTIVATEAPP`), and Steam Input switches to its desktop layout,
  which sends keys; the page counts a press and its key once.
- Over a game that stopped responding, taking the foreground must not wait for the game: `force_foreground` asks the
  window in front for a reply first (`SendMessageTimeout` with `WM_NULL`, 200 ms) and attaches to its input queue
  only when it answers. `IsHungAppWindow` alone missed a game suspended while it waited for input, and Lamplit's main
  thread then waited with it. Should Windows still keep the foreground with the game, the controller works in the
  open dock all the same: Lamplit reads it whatever window is in front.
- **Folding**, the island keeps its size and a `clip-path` squeezes it into the pill at its bottom centre on the
  opening's spring, which then drops onto the edge and goes; its shadow, a layer of its own, fades at once. What it
  shows fades in the squeeze's first 110 ms, tiles, top line and hints with it, which only then take their places for
  the next opening, out of sight. The clip,
  translate and opacity run on the compositor (Chromium animates `clip-path` there), so nothing on the full-screen
  window is laid out or painted again per frame. The page sends Rust the pill and the spring's curve
  (`dock_glass_fold`), and Rust squeezes the real glass's clip the same way with Windows.UI.Composition key frames,
  then hides the window 520 ms in. Only then does the window that was in front when the dock opened get the foreground
  back (or the game's window, if that one has gone): a game coming back to full speed, and window calls, cost the fold
  frames. When another window takes the foreground, the dock folds and leaves it there. Alt+F4 on the dock folds it as
  Circle does: its window refuses to close, since Lamplit keeps its handle for the next hold of PS. After each
  opening, fold and Home the page logs its frames, the longest wait between two and the 95th percentile (`dock: fold
  64 frames, worst 9 ms, 95% 8 ms`); the home page logs its veil the same way (`home: arrive`, `home: leave`).
  Coming forward, the home page asks for a rescan 0.9 s later, once its veil has lifted: reading the drives and the
  art meanwhile cost it frames.
- **News** (`dock/news.rs`) shows in a strip around the folded pill at the bottom centre, with `WS_EX_NOACTIVATE`
  and `WS_EX_TRANSPARENT`: the game keeps the foreground and its clicks. Only over a running game, with Lamplit not
  in front and no exclusive full screen.
- **Close game** posts `WM_CLOSE` to the game's windows and gives the game the foreground, so it can ask whether to
  quit. **Force close** ends the game's processes: those certainly the game's (`Watch::own_pids`), and for a game
  outside any store only its exe and what came from it as far as Windows tells, not a process found by its folder
  alone. The page offers it when a game window doesn't answer within a second, the game has no window, or a close
  asked 10 seconds ago hasn't happened. With none of those processes, `GameState::closable` is false and the dock has
  no Close game at all.

The page sizes the dock in hundredths of the screen's height (`--u`, from `screen.height`), as the home screen is
sized in `vh`. The island's width and height follow the face it shows, with a spring easing built as a CSS `linear()`
curve; one focus ring springs from tile to tile on a quicker one. Behind the faces, the game's own art is drawn small
(`createImageBitmap` scales it down off the page's thread) and blurred into a canvas, which the page scales up to the island: a blur that costs nothing while the island moves,
where CSS `backdrop-filter` couldn't see the game behind a transparent window at all. Once the island rests open,
Windows' real glass takes the art's place where Windows 11 22H2 or later has transparency effects on (`dock/glass.rs`,
`win/glass.rs`): a Windows.UI.Composition visual in the dock's own window, behind the page, filled with the host
backdrop (what is behind the window, blurred live by Windows) and clipped to the island's rounded rectangle. Acrylic
for a whole window (`DWMWA_SYSTEMBACKDROP_TYPE`, Tauri's window effect) fills the window's rectangle and ignores a
window region, and goes flat on a window that isn't in front, so it can't take the island's shape. The glass doesn't
follow the island's springs: before the island moves, the page puts its own glass back and lets the real glass go, and
asks for it again where the island comes to rest. Close game asks for Cross held: the pad sends `dock-pad` with
`ok-up` when Cross is let go after a press (`devices/pad/navigation.rs`), or when the controller holding it goes, and
only the open dock hears of it. Home draws a veil in the game's colours over the whole of the open dock's window,
which covers the screen; behind the veil the home window comes forward under a veil of its own (`dock/mod.rs` home).
Its first frames in front redraw the whole screen (65 to 80 ms on TOASTER), so the home page waits for its hero to
decode and two frames to pass, then says so (`dock_home_drawn`): the dock's window goes, and the home page lifts its
veil as it settles in (`ui/main.js` arrive). Without word from the home page, the dock folds 450 ms in all the same.
Back to game is the reverse: the home page eases out under the same veil, then asks Rust to bring the game forward (`launch_resume`), and drops the veil once its window has lost the
foreground (`ui/launch.js` backToGame).

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
| `prefs_set_sound_follows`, `prefs_set_touchpad_mouse`, `prefs_set_steam_devtools`, `prefs_set_online_art`, `prefs_set_dock` | `on` | The prefs after the change |
| `prefs_set_screensaver_minutes` | `minutes` (0 for never) | The prefs after the change |
| `prefs_set_screensaver_style` | `style`: `mix`, `2d` or `3d` | The prefs after the change |
| `power_sleep` | | Nothing, once the PC has woken up again |
| `power_restart`, `power_shut_down` | | Nothing, once Windows has started to restart or shut down |
| `display_mode` | | The screen's mode, such as `3840 × 2160 at 120 Hz` |
| `dock_state` | | The game the dock is over: `{ id, name, art, started, responding, force_close }`, or `null` |
| `dock_resume` | | Nothing; the dock folds and the game is in front again |
| `dock_home` | | Nothing; the home screen comes forward and the dock goes |
| `dock_home_drawn` | | Nothing; the home page has drawn behind the veil, and the dock goes |
| `dock_glass` | `island`: `{ x, y, width, height, radius }` in the window's pixels, or `null` | Whether real glass is under the island now |
| `dock_glass_fold` | `fold`: `{ to, ms, curve, after, fade, drop }`, the pill and the spring the page folds the island with | Nothing; Rust squeezes the real glass the same way |
| `dock_close_game` | `force` | Nothing, once Windows has the request; the game's end follows as after any game |

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
| `dock` | `{ mode }`: `open`, `closed`, or `status` with `icon`, `text` and `warn` | The dock opens, folds away, or shows news |
| `dock-pad` | The same steps as `pad`, and `ok-up` when Cross is let go | A controller press, while the dock is open |

## Keeping the two sides in step

The payloads live once, in `tests/ipc/*.json`. Rust tests compare what Rust sends with them (the `ipc_fixture!` macro
reads them at build time), and the page's tests feed the same files to the page. `tests/ipc/values.json` lists every
value of the enums the page branches on. `tests/contract.mjs` reads `lib.rs`, `commands.rs`, `events.rs` and
`ui/api.js` and fails when a command, an argument or an event exists on one side only. To add a command: write it in
`commands.rs`, register it in `generate_handler!` in `lib.rs`, add its wrapper to `ui/api.js`, and add a fixture
when it returns something new.
