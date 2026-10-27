// Watching a launched game: Lamplit hands the screen over once the game's window is up (handover.rs says when), counts
// how long the game runs, and comes forward again when it closes (session.rs says what the game's processes coming and
// going mean). `resume` brings a running game back to the front.

use super::handover::{self, Handover, Next, Seen};
use super::session::{PlayClock, STUB_RUN, Step, Tracker};
use super::window::{bring_lamplit_forward, hand_over, hold, is_lamplits, lamplit_screen, minimize_lamplit, release};
use super::{Launcher, step, update_text};
use crate::events::{self, Event, Play, StepState};
use crate::files::folder_key;
use crate::library::{self, Game, Launch};
use crate::stores::{Proc, Processes, Store, steam};
use crate::win::process::keep_awake;
use crate::win::window;
use parking_lot::Mutex;
use std::collections::HashSet;
use std::ops::ControlFlow;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// No game process this long after opening it: point at the store app.
const STILL_WAITING: Duration = Duration::from_secs(45);
/// How often the watcher looks until the game's window has the screen: soon after it is up, the screen goes to it.
const LOOK_EVERY: Duration = Duration::from_millis(250);
/// How long the starting screen has to fade to black before the game's window gets the screen: the page's 300 ms
/// (ui/launch.js FADE_MS), and the moment the event takes to reach it.
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
    /// A game the player added by hand: the exe Lamplit starts, and the processes seen coming from it. Its folder can
    /// hold other programs too (Downloads, say), so the game is that exe and what it started, not everything in the
    /// folder. Shared by the copies of a watch: the watcher's polls and the dock's close requests add to it.
    launched: Option<(String, Arc<Mutex<Lineage>>)>,
    /// When this launch opened the game. What the player asked of the game before then was about an earlier session.
    pub opened: Instant,
}

impl Watch {
    fn of(g: &Game) -> Self {
        let dirs = std::iter::once(&g.dir).chain(&g.extra_dirs).map(|d| format!("{}\\", folder_key(d))).collect();
        let launched = match &g.launch {
            Launch::Exe(exe) if g.manual => Some((folder_key(exe), Arc::default())),
            _ => None,
        };
        Watch { dirs, names: g.exe_names.clone(), launched, opened: Instant::now() }
    }

    /// The game's processes among `procs`.
    pub fn pids(&self, procs: &[Proc]) -> HashSet<u32> {
        match &self.launched {
            Some(launched) => Self::lineage(launched, procs).intersection(&self.select(procs, true)).copied().collect(),
            None => self.select(procs, false),
        }
    }

    /// The processes among `procs` that are certainly the game's, for closing it: one whose path Windows tells counts
    /// only when it runs from the game's folders. By its exe name alone, another program could be closed in its place.
    pub fn own_pids(&self, procs: &[Proc]) -> HashSet<u32> {
        let own = self.select(procs, true);
        match &self.launched {
            Some(launched) => Self::lineage(launched, procs).intersection(&own).copied().collect(),
            None => own,
        }
    }

    /// For a game added by hand: its exe, and what that started, running now.
    fn lineage((exe, lineage): &(String, Arc<Mutex<Lineage>>), procs: &[Proc]) -> HashSet<u32> {
        lineage.lock().update(exe, procs)
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

/// The processes that came from a game's exe, by id and start time, kept from poll to poll: a launcher that starts the
/// game and exits leaves the game its own. The start time tells a process from a later one that got the same id.
#[derive(Default)]
pub struct Lineage(HashSet<(u32, u64)>);

impl Lineage {
    /// Adds the processes running `exe` (a `folder_key`) and every process one of the game's started, and returns
    /// those that run now.
    fn update(&mut self, exe: &str, procs: &[Proc]) -> HashSet<u32> {
        self.0.extend(procs.iter().filter(|p| p.exe.is_some_and(|e| folder_key(e) == exe)).map(|p| (p.pid, p.started)));
        loop {
            let found: Vec<(u32, u64)> = procs
                .iter()
                .filter(|p| !self.0.contains(&(p.pid, p.started)))
                .filter(|p| p.parent.is_some_and(|parent| self.started_by_game(parent, p.started, procs)))
                .map(|p| (p.pid, p.started))
                .collect();
            if found.is_empty() {
                break;
            }
            self.0.extend(found);
        }
        procs.iter().filter(|p| self.0.contains(&(p.pid, p.started))).map(|p| p.pid).collect()
    }

    /// Whether the process with id `parent` that started a process at `at` is one of the game's: of the processes
    /// that had that id by then, running now or ended, the latest.
    fn started_by_game(&self, parent: u32, at: u64, procs: &[Proc]) -> bool {
        let running = procs.iter().find(|q| q.pid == parent).map(|q| q.started).filter(|&s| s <= at);
        let game = self.0.iter().filter(|&&(pid, s)| pid == parent && s <= at).map(|&(_, s)| s).max();
        game.is_some_and(|g| running.is_none_or(|r| g >= r))
    }
}

/// Watches a launched game until it closes. Runs on the launch's own thread, which keeps the PC awake while
/// Lamplit waits for the game (or for Steam to update it), and lets it sleep while the game runs. `before`: the windows
/// open when the player pressed Play, which aren't the game's.
pub fn watch_game(app: &AppHandle, generation: u64, game: &Game, before: &HashSet<isize>) {
    let (id, name, watch) = (game.id.as_str(), game.name.as_str(), Watch::of(game));
    let launcher = app.state::<Launcher>();
    // `start` took the wake lock for the launch.
    let mut awake = true;
    let mut stay_awake = |on: bool| {
        if awake != on {
            keep_awake(on);
            awake = on;
        }
    };
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
    // The game has the screen: its window got it, or the player stopped the launch once the game ran.
    let mut handed = false;
    loop {
        std::thread::sleep(if handed { Duration::from_secs(1) } else { LOOK_EVERY });
        if tracker.waiting() {
            if !launcher.is_current(generation) {
                return; // cancelled, or another launch replaced this one
            }
            // Steam updates a game before starting it: show how far it is, and don't time out meanwhile.
            let update = game.steam_appid.and_then(|a| steam::update(&game.dir, a)).filter(|u| u.downloading);
            if let Some(update) = &update {
                // The player may be watching the progress, so the screen stays on even after a timeout.
                stay_awake(true);
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
        } else if !handed && !launcher.is_current(generation) {
            // Cancelled, or another game started, while this one loads: it takes the screen when its window is up.
            log::info!("{name}: no longer waiting for its window");
            handed = true;
            events::emit(app, Event::Play(Play::Running { id }));
        } else if handed && launcher.running_id().as_deref() != Some(id) {
            log::info!("{name}: another game took over, no longer watching it");
            save_play(false);
            return;
        }
        procs.refresh();
        let list = procs.list();
        let pids = watch.pids(&list);
        save_play(!pids.is_empty());
        if !handed && launcher.is_current(generation) && looking.look(&list, &watch, !pids.is_empty()) {
            stay_awake(false);
            handed = true;
        }
        let Some(next) = tracker.poll(!pids.is_empty(), Instant::now()) else { continue };
        // Closed from the dock soon after it started: the game has ended, it isn't a launcher handing over.
        let next =
            if next == Step::Restarting && crate::dock::closed_from_dock(id, opened) { Step::Ended } else { next };
        match next {
            Step::Started => {
                log::info!("{name} is running (pids {pids:?})");
                library::record_start(app, id);
                launcher.set_running(id, watch.clone());
            }
            // Another game was started meanwhile: this one just closed, don't wait for it over that launch.
            Step::Restarting if !launcher.is_current(generation) => {
                log::info!("{name} closed; another game is being started");
                launcher.clear_running(id);
                events::emit(app, Event::Play(Play::Ended { id }));
                return;
            }
            Step::Restarting => {
                log::info!("{name} closed within {} s; waiting for it to come back", STUB_RUN.as_secs());
                stay_awake(true);
                launcher.clear_running(id);
                launcher.waiting_again(generation);
                events::emit(app, Event::Play(Play::Starting { id }));
                hold(app, generation);
                looking.handover = Handover::default();
                handed = false;
            }
            Step::Ended => return ended(app, generation, game),
            Step::TimedOut => {
                log::warn!("{name} hasn't started after {} s; still waiting", opened.elapsed().as_secs());
                // Lamplit keeps waiting until the player cancels, which may be never, so the PC and TV may sleep now.
                // A download can't be running: it holds the timeout off.
                stay_awake(false);
                step(app, id, "timeout", StepState::Warn, &format!("{name} hasn't started yet"), blocker);
                if !handed && !std::mem::replace(&mut reminded, true) {
                    bring_lamplit_forward(app);
                }
            }
        }
    }
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
    fn look(&mut self, procs: &[Proc], watch: &Watch, game_runs: bool) -> bool {
        let (app, id, name) = (self.app, self.id, self.name);
        match self.handover.poll(&new_windows(self.before, procs, watch), game_runs, Instant::now()) {
            Next::HandOver(to) => {
                log::info!("{name}: its window is up; it gets the screen");
                // The starting screen fades to black first, so nothing shows between it and the game.
                events::emit(app, Event::Play(Play::Running { id }));
                std::thread::sleep(FADE);
                hand_over(app, self.generation, to);
                app.state::<Launcher>().started(self.generation);
                true
            }
            Next::Hint { id: window, game: own } => {
                let whose = if own { "the game's" } else { "another program's" };
                log::info!("{name}: a window opened that may need the player ({whose})");
                *app.state::<Launcher>().waiting.lock() = Some(window);
                let label =
                    if own { format!("{name} may need you") } else { "A window opened that may need you".into() };
                step(app, id, "window", StepState::Warn, &label, None);
                false
            }
            Next::Wait => false,
        }
    }
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

/// The windows that opened since Play (not in `before`), front first, as the handover judges them: visible and drawn
/// by Windows, big enough to see, and not Lamplit's own.
fn new_windows(before: &HashSet<isize>, procs: &[Proc], watch: &Watch) -> Vec<Seen> {
    let (screen, front) = (lamplit_screen(), window::foreground());
    let mut seen = Vec::new();
    window::for_each_window(|w| {
        let id = w.0 as isize;
        let rect = window::rect(w).filter(|r| r.right - r.left >= SMALLEST && r.bottom - r.top >= SMALLEST);
        if let Some(rect) =
            rect.filter(|_| !before.contains(&id) && window::is_visible(w) && !window::is_cloaked(w) && !is_lamplits(w))
        {
            let pid = window::process_id(w);
            let covers = screen.is_some_and(|screen| handover::covers(rect, screen));
            seen.push(Seen {
                id,
                game: procs.iter().any(|p| p.pid == pid && watch.runs_from(p)),
                covers,
                answers: covers && window::responds(w, ANSWER_WITHIN),
                front: w == front,
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
        assert_eq!(watch.pids(&procs), HashSet::from([1, 5, 6]));
        assert_eq!(watch.own_pids(&procs), HashSet::from([1, 5]));
    }

    fn racer(exe: &str, dir: &str) -> Watch {
        let exe = PathBuf::from(exe);
        let mut game = Game::new("manual:racer".into(), "Racer".into(), None, PathBuf::from(dir), Launch::Exe(exe));
        game.manual = true;
        Watch::of(&game)
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
        assert_eq!(watch.pids(&procs), HashSet::from([1, 2, 4]));
        assert_eq!(watch.own_pids(&procs), HashSet::from([1, 2, 4]));
    }

    #[test]
    fn a_game_added_by_hand_stays_its_own_after_its_launcher_exits() {
        let watch = racer(r"D:\Old Games\Racer\Launcher.exe", r"D:\Old Games\Racer");
        // The launcher starts the game.
        let first = [
            proc(1, r"D:\Old Games\Racer\Launcher.exe", 100, Some(900)),
            proc(2, r"D:\Old Games\Racer\bin\Racer.exe", 101, Some(1)),
        ];
        assert_eq!(watch.pids(&first), HashSet::from([1, 2]));
        // The launcher has exited, and the game runs on. The dock's copy of the watch knows it too.
        let later = [proc(2, r"D:\Old Games\Racer\bin\Racer.exe", 101, Some(1))];
        assert_eq!(watch.clone().own_pids(&later), HashSet::from([2]));
        assert_eq!(watch.pids(&later), HashSet::from([2]));
        // Id 1 goes to another program, which starts one in the game's folder: neither is the game's.
        let reused = [
            later[0],
            proc(1, r"C:\Tools\tool.exe", 300, Some(900)),
            proc(3, r"D:\Old Games\Racer\tool-helper.exe", 301, Some(1)),
        ];
        assert_eq!(watch.own_pids(&reused), HashSet::from([2]));
    }
}
