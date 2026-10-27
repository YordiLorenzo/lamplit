// Watching a launched game: Lamplit hands the screen over once the game's window is up (handover.rs says when), counts
// how long the game runs, and comes forward again when it closes (session.rs says what the game's processes coming and
// going mean). `resume` brings a running game back to the front.

use super::handover::{self, Handover, Next, Seen};
use super::session::{PlayClock, STUB_RUN, Step, Tracker};
use super::window::{
    bring_lamplit_forward, hand_over, hold, is_lamplits, lamplit_screen, minimize_lamplit, release, take_keys,
};
use super::{Launcher, step, update_text};
use crate::events::{self, Event, Play, StepState};
use crate::files::folder_key;
use crate::library::{self, Game, Launch};
use crate::stores::{Proc, Processes, Store, steam};
use crate::win::process::{Held, keep_awake};
use crate::win::window;
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::ops::ControlFlow;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// No game process this long after opening it: point at the store app.
const STILL_WAITING: Duration = Duration::from_secs(45);
/// How often the watcher looks until the game's window has the screen: soon after it is up, the screen goes to it.
const LOOK_EVERY: Duration = Duration::from_millis(250);
/// How long the starting screen has to fade to black before the game's window gets the screen: the page's 300 ms
/// (`#curtain` in ui/style.css), and the moment the event takes to reach it.
const FADE: Duration = Duration::from_millis(400);
/// A window smaller than this either way is a helper of its program's, not something to show.
const SMALLEST: i32 = 64;
/// A window over the screen that doesn't answer within this isn't drawing yet.
const ANSWER_WITHIN: Duration = Duration::from_millis(100);

/// How to recognise a game's processes: by the folders they run from, or by name.
#[derive(Clone)]
pub struct Watch {
    dirs: Vec<String>,
    names: Vec<String>,
    /// A game outside any store, added by hand or found (Windows' game list may name an exe in Downloads): the exe
    /// Lamplit starts, and the processes seen coming from it. Its folder can hold other programs too, so the game is
    /// that exe and what it started, wherever that runs from (a launcher in `Launcher\` starts the game in `bin\`), and
    /// not everything in the folder, as for a store's game. Shared by the copies of a watch: the watcher's looks add to
    /// it (`track`), and the dock's close requests read it.
    launched: Option<(String, Arc<Mutex<Lineage>>)>,
    /// When this launch opened the game. What the player asked of the game before then was about an earlier session.
    pub opened: Instant,
}

impl Watch {
    fn of(g: &Game) -> Self {
        let dirs = std::iter::once(&g.dir).chain(&g.extra_dirs).map(|d| format!("{}\\", folder_key(d))).collect();
        let launched = match &g.launch {
            Launch::Exe(exe) if g.store.is_none() => Some((folder_key(exe), Arc::default())),
            _ => None,
        };
        Watch { dirs, names: g.exe_names.clone(), launched, opened: Instant::now() }
    }

    /// The watcher's look at `procs`, the newest list of processes: the game's processes among them. Only these looks
    /// add to a game's lineage and let go of what has ended. A list read earlier elsewhere (the dock's, say) may lack
    /// a process the watcher has found since, and would make the lineage lose it, and what it starts.
    fn track(&self, procs: &[Proc]) -> HashSet<u32> {
        match &self.launched {
            Some((exe, lineage)) => without_helpers(&lineage.lock().update(exe, &self.dirs, procs), procs),
            None => self.select(procs, false),
        }
    }

    /// The game's processes among `procs`, as far as the watcher has found them.
    pub fn pids(&self, procs: &[Proc]) -> HashSet<u32> {
        match &self.launched {
            Some((_, lineage)) => without_helpers(&lineage.lock().known(procs), procs),
            None => self.select(procs, false),
        }
    }

    /// The processes among `procs` that are certainly the game's, for closing it: one whose path Windows tells counts
    /// only when it runs from the game's folders. By its exe name alone, another program could be closed in its place.
    pub fn own_pids(&self, procs: &[Proc]) -> HashSet<u32> {
        match &self.launched {
            Some((_, lineage)) => without_helpers(&lineage.lock().known(procs), procs),
            None => self.select(procs, true),
        }
    }

    /// The watch of a game Lamplit has just started: `started` is the process that started, when Windows told.
    fn launched(g: &Game, started: Option<Held>) -> Self {
        let watch = Self::of(g);
        if let Some(started) = started {
            watch.seed(started);
        }
        watch
    }

    /// The process Lamplit started for a game outside any store, kept open from the start: it may start the game proper
    /// and end before the watcher first looks, which then has nothing else to tell the game's processes by.
    fn seed(&self, started: Held) {
        if let Some((_, lineage)) = &self.launched {
            let mut lineage = lineage.lock();
            lineage.since = Some(started.started);
            lineage.game.insert((started.pid, started.started), Some(started));
        }
    }

    /// `certain`: an exe name counts only for a process whose path Windows doesn't tell.
    fn select(&self, procs: &[Proc], certain: bool) -> HashSet<u32> {
        procs
            .iter()
            .filter(|p| {
                let name = p.name.to_string_lossy().to_lowercase();
                // Xbox's GameLaunchHelper sits in the game's folder and stays up while it shows a licence
                // error, so it says nothing about the game running.
                if name == "gamelaunchhelper.exe" {
                    return false;
                }
                self.runs_from(p) || (self.names.contains(&name) && !(certain && p.exe.is_some()))
            })
            .map(|p| p.pid)
            .collect()
    }

    /// The process runs from the game's folders. Xbox's GameLaunchHelper does too, and its licence question is the
    /// game's.
    fn runs_from(&self, p: &Proc) -> bool {
        p.exe.is_some_and(|exe| {
            let exe = exe.to_string_lossy().to_lowercase();
            self.dirs.iter().any(|d| exe.starts_with(d))
        })
    }
}

/// For a game outside any store: the processes of its lineage among `procs`, `lineage`, other than the helpers of
/// Windows' own a game starts on the way (a shell, a console host) and Xbox's GameLaunchHelper (see `Watch::select`),
/// which aren't the game and mustn't be closed with it; what they start still counts.
fn without_helpers(lineage: &HashSet<u32>, procs: &[Proc]) -> HashSet<u32> {
    let windows = std::env::var_os("SystemRoot").map(|root| format!("{}\\", folder_key(Path::new(&root))));
    let helper = |p: &Proc| {
        p.name.eq_ignore_ascii_case("gamelaunchhelper.exe")
            || p.exe.zip(windows.as_ref()).is_some_and(|(exe, windows)| folder_key(exe).starts_with(windows))
    };
    procs.iter().filter(|p| lineage.contains(&p.pid) && !helper(p)).map(|p| p.pid).collect()
}

/// Programs a game may start that are the player's own, not the game: a browser (a store page, a sign-in, patch notes),
/// and the store and chat apps. A game outside any store is what came from its exe (`Lineage`); these, and what they
/// start in turn, stay out of that, so they neither keep the game's session going and count as play time, nor close
/// with it.
const NOT_THE_GAME: &[&str] = &[
    "chrome.exe", "msedge.exe", "firefox.exe", "opera.exe", "opera_gx.exe", "brave.exe", "vivaldi.exe", "iexplore.exe",
    "arc.exe", "steam.exe", "steamwebhelper.exe", "epicgameslauncher.exe", "eadesktop.exe", "upc.exe",
    "ubisoftconnect.exe", "battle.net.exe", "battle.net launcher.exe", "discord.exe", "overwolf.exe",
];

/// The processes that came from a game's exe, by id and start time, kept from look to look: a launcher that starts the
/// game and exits leaves the game its own. Lamplit keeps each open (`Held`) until a look finds it gone, so meanwhile
/// Windows gives its id to no other process, and one whose parent has that id came from it; by then the look has
/// found what it started. One that ended before Lamplit could open it counts as a parent only while a look sees it.
#[derive(Default)]
pub struct Lineage {
    game: HashMap<(u32, u64), Option<Held>>,
    /// When the process Lamplit started began (`Watch::seed`).
    since: Option<u64>,
}

impl Lineage {
    /// Adds the processes running `exe` (a `folder_key`), every process one of the game's started, and every one that
    /// came through a step no look saw (see `came_through_unseen`), other than the programs in NOT_THE_GAME, and
    /// returns those that run now. `dirs`: the game's folders.
    fn update(&mut self, exe: &str, dirs: &[String], procs: &[Proc]) -> HashSet<u32> {
        for p in procs.iter().filter(|p| p.exe.is_some_and(|e| folder_key(e) == exe)) {
            self.add(p);
        }
        let not_the_game = |p: &Proc| NOT_THE_GAME.iter().any(|n| p.name.eq_ignore_ascii_case(n));
        loop {
            let found: Vec<&Proc> = procs
                .iter()
                .filter(|p| !self.game.contains_key(&(p.pid, p.started)) && !not_the_game(p))
                .filter(|p| {
                    p.parent.is_some_and(|parent| self.started_by_game(parent, p.started, procs))
                        || self.came_through_unseen(p, dirs, procs)
                })
                .collect();
            if found.is_empty() {
                break;
            }
            for p in found {
                self.add(p);
            }
        }
        // One this look finds gone is let go: what it started that still runs, this look has found, and from now on
        // Windows may give its id to another process.
        self.game.retain(|&(pid, started), _| procs.iter().any(|p| p.pid == pid && p.started == started));
        self.game.keys().map(|&(pid, _)| pid).collect()
    }

    /// Whether `p` came from a step between the launcher and the game that no look saw: a helper that started the game
    /// and ended between two looks, which leaves the game's parent unknown. It runs from the game's folders (`dirs`),
    /// started since the process Lamplit started, and its parent has ended. A program the player opens there has a
    /// parent that runs (Explorer, a browser), so it stays out, also from Downloads.
    fn came_through_unseen(&self, p: &Proc, dirs: &[String], procs: &[Proc]) -> bool {
        let inside = p.exe.is_some_and(|exe| dirs.iter().any(|d| folder_key(exe).starts_with(d.as_str())));
        let parent_runs =
            p.parent.is_some_and(|parent| procs.iter().any(|q| q.pid == parent && q.started <= p.started));
        self.since.is_some_and(|since| p.started >= since) && inside && !parent_runs
    }

    /// The processes among `procs` that the lineage has, as it is.
    fn known(&self, procs: &[Proc]) -> HashSet<u32> {
        procs.iter().filter(|p| self.game.contains_key(&(p.pid, p.started))).map(|p| p.pid).collect()
    }

    fn add(&mut self, p: &Proc) {
        self.game.entry((p.pid, p.started)).or_insert_with(|| Held::open(p.pid, p.started));
    }

    /// Whether the process with id `parent` that started a process at `at` is one of the game's: one Lamplit keeps
    /// open, whose id no other process can have had since it started, or one that runs now.
    fn started_by_game(&self, parent: u32, at: u64, procs: &[Proc]) -> bool {
        let runs = |started| procs.iter().any(|q| q.pid == parent && q.started == started);
        self.game
            .iter()
            .any(|(&(pid, started), held)| pid == parent && started <= at && (held.is_some() || runs(started)))
    }
}

/// Watches a launched game until it closes. Runs on the launch's own thread, which keeps the PC awake while
/// Lamplit waits for the game (or for Steam to update it), and lets it sleep while the game runs. `before`: the windows
/// open when the player pressed Play. `started`: the process Lamplit started, when Windows told (a game's exe).
pub fn watch_game(app: &AppHandle, generation: u64, game: &Game, before: &HashSet<isize>, started: Option<Held>) {
    let (id, name, watch) = (game.id.as_str(), game.name.as_str(), Watch::launched(game, started));
    let launcher = app.state::<Launcher>();
    let mut screen = Screen { handed: false, awake: true };
    let mut procs = Processes::now();
    let mut tracker = Tracker::new(Instant::now());
    let mut clock = PlayClock::default();
    let mut save_play = |running: bool| {
        if let Some(seconds) = clock.poll(running, Instant::now()) {
            library::add_play_time(app, id, seconds);
        }
    };
    let mut last_progress = None;
    // The store app most likely to be holding things up: the publisher's launcher if there is one, else the store.
    let blocker = game.requires.last().copied();
    let opened = watch.opened;
    let mut hinted = false;
    let mut reminded = false;
    let mut looking = Looking { app, generation, id, name, before, handover: Handover::default() };
    loop {
        std::thread::sleep(if screen.handed { Duration::from_secs(1) } else { LOOK_EVERY });
        if tracker.waiting() {
            if !launcher.is_current(generation) {
                return; // cancelled, or another launch replaced this one
            }
            // Steam updates a game before starting it: show how far it is, and don't time out meanwhile.
            let update = game.steam_appid.and_then(|a| steam::update(&game.dir, a)).filter(|u| u.downloading);
            if let Some(update) = &update {
                // The player may be watching the progress, so the screen stays on even after a timeout.
                screen.stay_awake(true);
                tracker.hold_off_timeout(Instant::now());
                let progress = update_text(update);
                if last_progress.as_ref() != Some(&progress) {
                    step(app, id, "update", StepState::Busy, &progress, None);
                    last_progress = Some(progress);
                }
            }
            // Nothing yet after a while, and no download to wait for: the store app is probably asking something
            // (sign-in, update, EULA).
            let hint_due = update.is_none() && !hinted && opened.elapsed() >= STILL_WAITING;
            if let Some(store) = blocker.filter(|_| hint_due) {
                hinted = true;
                let label = format!("Still waiting: {} may need you", store.name());
                step(app, id, "hint", StepState::Warn, &label, Some(store));
            }
        } else if !screen.handed && !launcher.is_current(generation) {
            // Cancelled, or another game started, while this one loads: it takes the screen when its window is up.
            log::info!("{name}: no longer waiting for its window");
            screen.hand();
            events::emit(app, Event::Play(Play::Running { id }));
        } else if screen.handed && launcher.running_id().as_deref() != Some(id) {
            log::info!("{name}: another game took over, no longer watching it");
            save_play(false);
            return;
        }
        procs.refresh();
        let list = procs.list();
        let pids = watch.track(&list);
        save_play(!pids.is_empty());
        if !screen.handed && launcher.is_current(generation) && looking.look(&list, &pids, &watch) {
            screen.hand();
            // Its window may get the screen before the tracker counts the game as started. From now on it has, so the
            // page, which now shows it running, hears of its end too.
            if tracker.announce(Instant::now()) {
                running(app, id, &pids, &watch);
            }
        }
        let Some(next) = tracker.poll(!pids.is_empty(), Instant::now()) else { continue };
        // Closed from the dock soon after it started: the game has ended, it isn't a launcher handing over.
        let next =
            if next == Step::Restarting && crate::dock::closed_from_dock(id, opened) { Step::Ended } else { next };
        match next {
            Step::Started => running(app, id, &pids, &watch),
            // Another game was started meanwhile: this one just closed, don't wait for it over that launch.
            Step::Restarting if !launcher.is_current(generation) => {
                log::info!("{name} closed; another game is being started");
                launcher.clear_running(id);
                events::emit(app, Event::Play(Play::Ended { id }));
                return;
            }
            Step::Restarting => {
                log::info!("{name} closed within {} s; waiting for it to come back", STUB_RUN.as_secs());
                screen.waits_again();
                launcher.clear_running(id);
                launcher.waiting_again(generation);
                events::emit(app, Event::Play(Play::Starting { id }));
                hold(app, generation);
                looking.handover = Handover::default();
            }
            Step::Ended => return ended(app, generation, game),
            Step::TimedOut => {
                log::warn!("{name} hasn't started after {} s; still waiting", opened.elapsed().as_secs());
                // Lamplit keeps waiting until the player cancels, which may be never, so the PC and TV may sleep now.
                // A download can't be running: it holds the timeout off.
                screen.stay_awake(false);
                step(app, id, "timeout", StepState::Warn, &format!("{name} hasn't started yet"), blocker);
                if !screen.handed && !std::mem::replace(&mut reminded, true) {
                    bring_lamplit_forward(app);
                }
            }
        }
    }
}

/// Whether the game has the screen: its window got it, or the launch stopped waiting for it. Until then the PC and
/// screen stay awake (`start` took the wake lock for the launch), unless the game is long in coming.
struct Screen {
    handed: bool,
    awake: bool,
}

impl Screen {
    fn stay_awake(&mut self, on: bool) {
        if self.awake != on {
            keep_awake(on);
            self.awake = on;
        }
    }

    /// The game has the screen, or the launch no longer waits for it: the PC and screen may sleep.
    fn hand(&mut self) {
        self.handed = true;
        self.stay_awake(false);
    }

    /// The game closed right after starting: the launch waits for it to come back, and keeps the PC awake meanwhile.
    fn waits_again(&mut self) {
        self.handed = false;
        self.stay_awake(true);
    }
}

/// The game runs: Lamplit records when it was played, and knows it as the running game.
fn running(app: &AppHandle, id: &str, pids: &HashSet<u32>, watch: &Watch) {
    log::info!("{id} is running (pids {pids:?})");
    library::record_start(app, id);
    app.state::<Launcher>().set_running(id, watch.clone());
}

/// The game has closed: the page hears of it, with the play time it saved, and Lamplit comes forward from behind it.
fn ended(app: &AppHandle, generation: u64, game: &Game) {
    log::info!("{} closed; Lamplit is back", game.name);
    let launcher = app.state::<Launcher>();
    launcher.clear_running(&game.id);
    launcher.started(generation);
    // Every game, with this one's play time, saved when its processes went. A game only starts once the library is
    // loaded, and it stays loaded.
    let games = app.state::<library::Library>().games().expect("the library is loaded");
    events::emit(app, Event::Games(&games));
    events::emit(app, Event::Play(Play::Ended { id: &game.id }));
    // Right after a game's window closes Windows may not hand the foreground over yet. Steam's window, if a Steam
    // launch opened it, shouldn't end up over Lamplit either.
    std::thread::sleep(Duration::from_secs(1));
    if game.store == Some(Store::Steam) {
        steam::minimize_main_window();
    }
    release(app, Some(generation));
    bring_lamplit_forward(app);
}

/// Looking for the game's window until it is up, for a launch.
struct Looking<'a> {
    app: &'a AppHandle,
    generation: u64,
    id: &'a str,
    name: &'a str,
    /// The windows open when the player pressed Play.
    before: &'a HashSet<isize>,
    handover: Handover,
}

impl Looking<'_> {
    /// One look at the windows: true once the game's window has got the screen. A window that may need the player
    /// gets a line on the starting screen, which offers to show it.
    fn look(&mut self, procs: &[Proc], pids: &HashSet<u32>, watch: &Watch) -> bool {
        let (app, id, name) = (self.app, self.id, self.name);
        let seen = seen_windows(self.before, procs, pids, watch);
        let next = self.handover.poll(&seen, !pids.is_empty(), Instant::now());
        // A window that may need the player takes the foreground as it opens, and with it the keys.
        if self.handover.keeps_keys(&seen) {
            take_keys(app, self.generation);
        }
        match next {
            Next::HandOver(to) => {
                log::info!("{name}: its window is up; it gets the screen");
                let emit = |play| events::emit(app, Event::Play(play));
                if !give_screen(id, emit, || hand_over(app, self.generation, to)) {
                    log::info!("{name}: its window went, or the launch stopped, while the screen faded");
                    return false;
                }
                app.state::<Launcher>().started(self.generation);
                true
            }
            Next::Hint { id: window, own } => {
                let whose = if own { "the game's" } else { "another program's" };
                log::info!("{name}: a window opened that may need the player ({whose})");
                *app.state::<Launcher>().waiting.lock() = Some(window);
                let label =
                    if own { format!("{name} may need you") } else { "A window opened that may need you".into() };
                step(app, id, "window", StepState::Warn, &label, None);
                false
            }
            Next::Gone => {
                log::info!("{name}: the window that may have needed the player has closed");
                *app.state::<Launcher>().waiting.lock() = None;
                // No longer something to show: ✕ goes back to a store app that may still need the player.
                step(app, id, "window", StepState::Ok, "That window has closed", None);
                false
            }
            Next::Wait => false,
        }
    }
}

/// Gives the game's window the screen (`hand_over`). The starting screen fades to black first, so nothing shows between
/// it and the game, and the page hears that the game runs only once its window has the screen: a game that replaces
/// its window during the fade fails the handover, and its launch goes on, starting screen and all, until the next
/// window is up.
fn give_screen<'a>(id: &'a str, mut emit: impl FnMut(Play<'a>), hand_over: impl FnOnce() -> bool) -> bool {
    emit(Play::Up { id });
    std::thread::sleep(FADE);
    let handed = hand_over();
    if handed {
        emit(Play::Running { id });
    }
    handed
}

/// The windows already open, to tell those that open after them.
pub fn open_windows() -> HashSet<isize> {
    let mut open = HashSet::new();
    window::for_each_window(|w| {
        if window::is_visible(w) {
            open.insert(w.0 as isize);
        }
        ControlFlow::Continue(())
    });
    open
}

/// Whether the handover looks at a window: one that opened since Play (not in `before`), or one of the game's, which
/// may have been open before: a game that runs already, which the launch only brings back to the front.
fn looked_at(id: isize, before: &HashSet<isize>, game: bool) -> bool {
    game || !before.contains(&id)
}

/// The windows the handover judges, front first (see `looked_at`): visible and drawn by Windows, big enough to see,
/// and not Lamplit's own. `pids`: the game's processes.
fn seen_windows(before: &HashSet<isize>, procs: &[Proc], pids: &HashSet<u32>, watch: &Watch) -> Vec<Seen> {
    let screen = lamplit_screen();
    let mut seen = Vec::new();
    window::for_each_window(|w| {
        let (id, pid) = (w.0 as isize, window::process_id(w));
        let game = pids.contains(&pid);
        let rect = window::rect(w).filter(|r| r.right - r.left >= SMALLEST && r.bottom - r.top >= SMALLEST);
        if let Some(rect) = rect.filter(|_| {
            looked_at(id, before, game) && window::is_visible(w) && !window::is_cloaked(w) && !is_lamplits(w)
        }) {
            let covers = screen.is_some_and(|screen| handover::covers(rect, screen));
            seen.push(Seen {
                id,
                game,
                own: game || procs.iter().any(|p| p.pid == pid && watch.runs_from(p)),
                covers,
                // Only the game's window gets the screen, so only its window is asked.
                answers: game && covers && window::responds(w, ANSWER_WITHIN),
            });
        }
        ControlFlow::Continue(())
    });
    seen
}

/// Back to the running game, if one runs: its window comes forward, and Lamplit stays behind it. Reads every
/// process, so not on the main thread; only the window change goes there.
pub fn resume(app: &AppHandle) {
    let Some((id, watch)) = app.state::<Launcher>().running() else { return };
    let pids = watch.pids(&Processes::now().list());
    let main = app.clone();
    let _ = app.run_on_main_thread(move || {
        let found = game_windows(&pids).first().copied();
        log::info!("resume {id}: game window {:?}", found.map(|w| w.0));
        match found {
            Some(w) => window::force_foreground(w),
            // A game whose window Lamplit can't tell may be behind it.
            None => minimize_lamplit(&main),
        }
    });
}

/// The game's own windows, front first: those of its processes `pids` that are visible, and not a dialog or tool
/// window of another.
pub fn game_windows(pids: &HashSet<u32>) -> Vec<window::HWND> {
    let mut found = Vec::new();
    window::for_each_window(|w| {
        if pids.contains(&window::process_id(w)) && window::is_visible(w) && !window::has_owner(w) {
            found.push(w);
        }
        ControlFlow::Continue(())
    });
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};

    /// A process whose path Windows tells, started at `started` by `parent`.
    fn proc(pid: u32, exe: &'static str, started: u64, parent: Option<u32>) -> Proc<'static> {
        let exe = Path::new(exe);
        Proc { pid, name: exe.file_name().unwrap(), exe: Some(exe), started, parent }
    }

    fn example() -> Watch {
        let mut game = Game::new(
            "xbox:example".into(),
            "Example".into(),
            Some(Store::Xbox),
            PathBuf::from(r"D:\Games\Foo"),
            Launch::Uri(String::new()),
        );
        game.exe_names = vec!["runner.exe".into()];
        Watch::of(&game)
    }

    #[test]
    fn recognises_the_games_processes() {
        let listed = [
            proc(1, r"D:\Games\Foo\bin\Foo.exe", 0, None),
            // Spelled in another case than the folder Lamplit found.
            proc(2, r"d:\GAMES\FOO\Foo-Win64.EXE", 0, None),
            // A sibling folder whose name starts with the game's.
            proc(3, r"D:\Games\Foo Bar\FooBar.exe", 0, None),
            // Stays up while it shows a licence error.
            proc(4, r"D:\Games\Foo\GameLaunchHelper.exe", 0, None),
            // By name alone, for a process whose path Windows doesn't tell.
            Proc { pid: 5, name: OsStr::new("Runner.exe"), exe: None, started: 0, parent: None },
        ];
        assert_eq!(example().pids(&listed), HashSet::from([1, 2, 5]));
    }

    #[test]
    fn closing_takes_only_processes_that_are_certainly_the_games() {
        let procs = [
            proc(1, r"D:\Games\Foo\bin\Foo.exe", 0, None),
            // Its path unknown: the name is all there is to go on.
            Proc { pid: 5, name: OsStr::new("Runner.exe"), exe: None, started: 0, parent: None },
            // Another program with the game's exe name, in a folder of its own.
            proc(6, r"C:\Tools\runner.exe", 0, None),
        ];
        let watch = example();
        assert_eq!(watch.track(&procs), HashSet::from([1, 5, 6]));
        assert_eq!(watch.own_pids(&procs), HashSet::from([1, 5]));
    }

    fn racer(exe: &str, dir: &str) -> Watch {
        let exe = PathBuf::from(exe);
        let mut game = Game::new("manual:racer".into(), "Racer".into(), None, PathBuf::from(dir), Launch::Exe(exe));
        game.manual = true;
        Watch::of(&game)
    }

    #[test]
    fn a_game_found_outside_any_store_is_its_exe_and_what_it_started() {
        // Windows' game list has an exe in Downloads, which discovery takes as the game's folder.
        let exe = PathBuf::from(r"D:\Downloads\Racer.exe");
        let game = Game::new(r"pc:d:\downloads".into(), "Racer".into(), None, r"D:\Downloads".into(), Launch::Exe(exe));
        let watch = Watch::of(&game);
        let procs = [
            proc(1, r"D:\Downloads\Racer.exe", 100, Some(900)),
            proc(2, r"D:\Downloads\Racer\RacerGame.exe", 101, Some(1)),
            // The player's own: an installer and an editor in Downloads.
            proc(3, r"D:\Downloads\setup.exe", 102, Some(900)),
            proc(4, r"D:\Downloads\Tools\editor.exe", 103, Some(900)),
        ];
        assert_eq!(watch.track(&procs), [1, 2].into());
        assert_eq!(watch.own_pids(&procs), [1, 2].into(), "closing the game would close the installer and the editor");
    }

    #[test]
    fn a_game_added_by_hand_is_its_exe_and_what_it_started() {
        // Added from Downloads, which holds other programs too.
        let watch = racer(r"D:\Downloads\Racer.exe", r"D:\Downloads");
        let procs = [
            proc(1, r"D:\Downloads\Racer.exe", 100, Some(900)),
            // What the game started: the game proper, and a helper it started through a shell outside the folder.
            proc(2, r"D:\Downloads\Racer\RacerGame.exe", 101, Some(1)),
            proc(3, r"C:\Windows\System32\cmd.exe", 101, Some(1)),
            proc(4, r"D:\Downloads\Racer\helper.exe", 102, Some(3)),
            // Another program in Downloads, and what it started: an installer, say, that the player runs meanwhile.
            proc(5, r"D:\Downloads\setup.exe", 50, Some(900)),
            proc(6, r"D:\Downloads\setup-tmp\unpack.exe", 103, Some(5)),
        ];
        // The installer neither keeps the game running nor gets closed with it.
        assert_eq!(watch.track(&procs), HashSet::from([1, 2, 4]));
        assert_eq!(watch.own_pids(&procs), HashSet::from([1, 2, 4]));
    }

    #[test]
    fn a_close_request_with_an_older_look_leaves_the_game_as_the_watcher_saw_it() {
        let watch = racer(r"D:\Old Games\Racer\Launcher.exe", r"D:\Old Games\Racer");
        // The launcher started a patcher, which started the game, and each ended in turn.
        let launcher = proc(1, r"D:\Old Games\Racer\Launcher.exe", 100, Some(900));
        let patcher = proc(2, r"D:\Old Games\Racer\Patcher.exe", 101, Some(1));
        let game = proc(3, r"D:\Old Games\Racer\bin\Racer.exe", 102, Some(2));
        assert_eq!(watch.track(&[launcher, patcher]), [1, 2].into());
        assert_eq!(watch.track(&[patcher, game]), [2, 3].into());
        assert_eq!(watch.track(&[game]), [3].into());
        // The dock read the processes before all that, while only the patcher ran, and asks now.
        watch.own_pids(&[patcher]);
        assert_eq!(watch.track(&[game]), [3].into(), "Lamplit would take the game for ended");
    }

    #[test]
    fn the_id_of_a_launcher_seen_gone_leads_to_the_game_no_more() {
        let watch = racer(r"D:\Old Games\Racer\Launcher.exe", r"D:\Old Games\Racer");
        let game = proc(2, r"D:\Old Games\Racer\bin\Racer.exe", 101, Some(1));
        assert_eq!(watch.track(&[proc(1, r"D:\Old Games\Racer\Launcher.exe", 100, Some(900)), game]), [1, 2].into());
        // The launcher has ended.
        assert_eq!(watch.track(&[game]), [2].into());
        // Between two looks, another program got its id, started one and ended: no look saw it.
        let unseen = [game, proc(3, r"C:\Tools\helper.exe", 301, Some(1))];
        assert_eq!(watch.own_pids(&unseen), [2].into(), "closing the game would close the helper too");
        assert_eq!(watch.track(&unseen), [2].into());
    }

    /// The launcher Lamplit started, which it keeps open from the start: this test's own process stands in for it.
    fn launcher() -> Held {
        let procs = Processes::now();
        let me = procs.list().into_iter().find(|p| p.pid == std::process::id()).unwrap();
        Held::open(me.pid, me.started).unwrap()
    }

    #[test]
    fn a_game_started_through_a_step_no_look_saw_is_found_in_its_folder() {
        // Found in D:\Games\Racer. Its launcher started a helper, which started the game and ended between two looks.
        let exe = PathBuf::from(r"D:\Games\Racer\Launcher.exe");
        let game =
            Game::new(r"pc:d:\games\racer".into(), "Racer".into(), None, r"D:\Games\Racer".into(), Launch::Exe(exe));
        let (watch, launcher) = (Watch::of(&game), launcher());
        let at = launcher.started;
        watch.seed(launcher);
        let explorer = proc(900, r"C:\Windows\explorer.exe", 0, None);
        let procs = [
            explorer,
            proc(2, r"D:\Games\Racer\bin\Racer.exe", at + 1, Some(5)),
            // The player's own: one opened from Explorer, and one that ran before the game was started.
            proc(3, r"D:\Games\Racer\Tools\editor.exe", at + 2, Some(900)),
            proc(4, r"D:\Games\Racer\Tools\server.exe", at.saturating_sub(60), Some(6)),
        ];
        assert_eq!(watch.track(&procs), [2].into(), "the starting screen would stay over the game");
        assert_eq!(watch.own_pids(&procs), [2].into());
    }

    #[test]
    fn a_launcher_that_ends_before_the_first_look_still_leads_to_the_game() {
        let watch = racer(r"D:\Old Games\Racer\Launcher.exe", r"D:\Old Games\Racer");
        let launcher = launcher();
        // It started bin\Racer.exe and ended before the watcher first looked.
        let game = [proc(2, r"D:\Old Games\Racer\bin\Racer.exe", launcher.started, Some(launcher.pid))];
        assert!(watch.track(&game).is_empty(), "nothing else leads to it");
        watch.seed(launcher);
        assert_eq!(watch.track(&game), HashSet::from([2]));
    }

    #[test]
    fn the_handover_looks_at_the_games_window_also_when_it_was_open_before() {
        let before = HashSet::from([7, 8]);
        // The game ran already, and the launch brought its window back: it was open at Play.
        assert!(looked_at(7, &before, true));
        // Another program's window that was open already isn't looked at; a new one is.
        assert!(!looked_at(8, &before, false));
        assert!(looked_at(9, &before, false));
    }

    #[test]
    fn the_browser_a_game_added_by_hand_opens_isnt_the_game() {
        let watch = racer(r"D:\Downloads\Racer.exe", r"D:\Downloads");
        let chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe";
        let browser = [
            proc(2, chrome, 102, Some(1)),
            // What the browser starts: its tabs, and a crash reporter by another name.
            proc(3, chrome, 103, Some(2)),
            proc(4, r"C:\Program Files\Google\Chrome\Application\crashpad_handler.exe", 103, Some(2)),
            // Steam, which a link opened, and a game Steam starts.
            proc(5, r"C:\Program Files (x86)\Steam\steam.exe", 104, Some(1)),
            proc(6, r"D:\SteamLibrary\steamapps\common\Other\other.exe", 105, Some(5)),
        ];
        let game = [
            proc(1, r"D:\Downloads\Racer.exe", 100, Some(900)),
            proc(7, r"D:\Downloads\Racer\RacerGame.exe", 101, Some(1)),
        ];
        let running: Vec<Proc> = game.iter().chain(&browser).copied().collect();
        assert_eq!(watch.track(&running), HashSet::from([1, 7]));
        assert_eq!(watch.own_pids(&running), HashSet::from([1, 7]), "closing the game leaves the browser open");
        // The game has closed, the browser is still open: the session is over.
        assert!(watch.track(&browser).is_empty());
    }

    #[test]
    fn a_launcher_added_by_hand_leads_to_the_game_in_another_folder() {
        // Its folder is Launcher, and the game it starts runs from a folder beside it.
        let watch = racer(r"D:\Foo\Launcher\launcher.exe", r"D:\Foo\Launcher");
        let start =
            [proc(1, r"D:\Foo\Launcher\launcher.exe", 100, Some(900)), proc(2, r"D:\Foo\bin\Foo.exe", 101, Some(1))];
        assert_eq!(watch.track(&start), HashSet::from([1, 2]));
        // The launcher has exited: the game runs on, and is the one to close.
        let later = [start[1]];
        assert_eq!(watch.track(&later), HashSet::from([2]));
        assert_eq!(watch.own_pids(&later), HashSet::from([2]));
    }

    #[test]
    fn the_pc_may_sleep_once_the_launch_no_longer_waits_for_the_window() {
        // Cancelled after the game started but before its window got the screen, which may be never: a launcher that
        // stays open.
        let mut screen = Screen { handed: false, awake: true };
        screen.hand();
        assert!(screen.handed && !screen.awake, "the PC and TV would stay awake until the game closes");
        screen.waits_again();
        assert!(!screen.handed && screen.awake);
        screen.stay_awake(false);
    }

    #[test]
    fn the_page_hears_the_game_runs_only_once_its_window_has_the_screen() {
        let told = |handed: bool| {
            let mut told = Vec::new();
            give_screen("pc:1", |play| told.push(serde_json::to_value(play).unwrap()["state"].clone()), || handed);
            told
        };
        assert_eq!(told(true), ["up", "running"]);
        // Its window went while the screen faded: the launch goes on, and the page keeps its starting screen.
        assert_eq!(told(false), ["up"]);
    }

    #[test]
    fn a_game_added_by_hand_stays_its_own_after_its_launcher_exits() {
        let watch = racer(r"D:\Old Games\Racer\Launcher.exe", r"D:\Old Games\Racer");
        // The launcher starts the game.
        let first = [
            proc(1, r"D:\Old Games\Racer\Launcher.exe", 100, Some(900)),
            proc(2, r"D:\Old Games\Racer\bin\Racer.exe", 101, Some(1)),
        ];
        assert_eq!(watch.track(&first), HashSet::from([1, 2]));
        // The launcher has exited, and the game runs on. The dock's copy of the watch knows it too.
        let later = [proc(2, r"D:\Old Games\Racer\bin\Racer.exe", 101, Some(1))];
        assert_eq!(watch.clone().own_pids(&later), HashSet::from([2]));
        assert_eq!(watch.track(&later), HashSet::from([2]));
        // Id 1 goes to another program, which starts one in the game's folder: neither is the game's.
        let reused = [
            later[0],
            proc(1, r"C:\Tools\tool.exe", 300, Some(900)),
            proc(3, r"D:\Old Games\Racer\tool-helper.exe", 301, Some(1)),
        ];
        assert_eq!(watch.own_pids(&reused), HashSet::from([2]));
        // That program exits, and what it started runs on: still not the game's, so closing the game leaves it open.
        let gone = [later[0], reused[2]];
        assert_eq!(watch.own_pids(&gone), HashSet::from([2]));
        assert_eq!(watch.track(&gone), HashSet::from([2]));
    }
}
