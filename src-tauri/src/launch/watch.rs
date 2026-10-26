// Watching a launched game: Lamplit steps aside once the game runs, counts how long it runs, and comes back when it
// closes (session.rs says what the game's processes coming and going mean). `resume` brings a running game back to
// the front.

use super::session::{PlayClock, STUB_RUN, Step, Tracker};
use super::window::{bring_lamplit_forward, minimize_lamplit};
use super::{Launcher, step, update_text};
use crate::events::{self, Event, Play, StepState};
use crate::files::folder_key;
use crate::library::{self, Game};
use crate::stores::{Processes, Store, steam};
use crate::win::process::keep_awake;
use crate::win::window;
use std::collections::HashSet;
use std::ffi::OsStr;
use std::ops::ControlFlow;
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// No game process this long after opening it: point at the store app.
const STILL_WAITING: Duration = Duration::from_secs(45);

/// How to recognise a game's processes: by the folders they run from, or by name.
#[derive(Clone)]
pub struct Watch {
    dirs: Vec<String>,
    names: Vec<String>,
}

impl Watch {
    fn of(g: &Game) -> Self {
        let dirs = std::iter::once(&g.dir).chain(&g.extra_dirs).map(|d| format!("{}\\", folder_key(d))).collect();
        Watch { dirs, names: g.exe_names.clone() }
    }

    /// The game's processes among `procs` (pid, exe name, exe path), as `Processes::iter` lists them.
    fn pids<'a>(&self, procs: impl Iterator<Item = (u32, &'a OsStr, Option<&'a Path>)>) -> HashSet<u32> {
        procs
            .filter(|(_, name, exe)| {
                let name = name.to_string_lossy().to_lowercase();
                // Xbox's GameLaunchHelper sits in the game's folder and stays up while it shows a licence
                // error, so it says nothing about the game running.
                if name == "gamelaunchhelper.exe" {
                    return false;
                }
                self.names.contains(&name)
                    || exe.is_some_and(|exe| {
                        let exe = exe.to_string_lossy().to_lowercase();
                        self.dirs.iter().any(|d| exe.starts_with(d))
                    })
            })
            .map(|(pid, ..)| pid)
            .collect()
    }
}

/// Watches a launched game until it closes. Runs on the launch's own thread, which keeps the PC awake while
/// Lamplit waits for the game (or for Steam to update it), and lets it sleep while the game runs.
pub fn watch_game(app: &AppHandle, generation: u64, game: &Game) {
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
    let opened = Instant::now();
    let mut hinted = false;
    let mut reminded = false;
    loop {
        std::thread::sleep(Duration::from_secs(1));
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
        } else if launcher.running_id().as_deref() != Some(id) {
            log::info!("{name}: another game took over, no longer watching it");
            save_play(false);
            return;
        }
        procs.refresh();
        let pids = watch.pids(procs.iter());
        save_play(!pids.is_empty());
        let Some(next) = tracker.poll(!pids.is_empty(), Instant::now()) else { continue };
        match next {
            Step::Started => {
                log::info!("{name} is running (pids {pids:?})");
                stay_awake(false);
                library::record_start(app, id);
                launcher.set_running(id, watch.clone());
                events::emit(app, Event::Play(Play::Running { id }));
                minimize_lamplit(app);
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
                events::emit(app, Event::Play(Play::Starting { id }));
                bring_lamplit_forward(app);
            }
            Step::Ended => {
                log::info!("{name} closed; Lamplit is back");
                launcher.clear_running(id);
                // With its play time, saved when its processes went.
                library::send(app);
                events::emit(app, Event::Play(Play::Ended { id }));
                // Right after a game's window closes Windows may not hand the foreground over yet. Steam's window,
                // if a Steam launch opened it, shouldn't end up over Lamplit either.
                std::thread::sleep(Duration::from_secs(1));
                if game.store == Some(Store::Steam) {
                    steam::minimize_main_window();
                }
                bring_lamplit_forward(app);
                return;
            }
            Step::TimedOut => {
                log::warn!("{name} hasn't started after {} s; still waiting", opened.elapsed().as_secs());
                // Lamplit keeps waiting until the player cancels, which may be never, so the PC and TV may sleep now.
                // A download can't be running: it holds the timeout off.
                stay_awake(false);
                step(app, id, "timeout", StepState::Warn, &format!("{name} hasn't started yet"), blocker);
                if !std::mem::replace(&mut reminded, true) {
                    bring_lamplit_forward(app);
                }
            }
        }
    }
}

/// Back to the running game, if one runs: Lamplit steps aside and the game's window comes forward. Reads every
/// process, so not on the main thread; only the window change goes there.
pub fn resume(app: &AppHandle) {
    let Some((id, watch)) = app.state::<Launcher>().running() else { return };
    let pids = watch.pids(Processes::now().iter());
    minimize_lamplit(app);
    let _ = app.run_on_main_thread(move || {
        // The game's own window: visible, and not a dialog or tool window of another.
        let mut found = None;
        window::for_each_window(|w| {
            if pids.contains(&window::process_id(w)) && window::is_visible(w) && !window::has_owner(w) {
                found = Some(w);
                return ControlFlow::Break(());
            }
            ControlFlow::Continue(())
        });
        log::info!("resume {id}: game window {:?}", found.map(|w| w.0));
        if let Some(w) = found {
            window::force_foreground(w);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::Launch;
    use std::path::PathBuf;

    #[test]
    fn recognises_the_games_processes() {
        let mut game = Game::new(
            "xbox:example".into(),
            "Example".into(),
            Some(Store::Xbox),
            PathBuf::from(r"D:\Games\Foo"),
            Launch::Uri(String::new()),
        );
        game.exe_names = vec!["runner.exe".into()];
        let watch = Watch::of(&game);
        let exes = [
            (1, r"D:\Games\Foo\bin\Foo.exe"),
            // Spelled in another case than the folder Lamplit found.
            (2, r"d:\GAMES\FOO\Foo-Win64.EXE"),
            // A sibling folder whose name starts with the game's.
            (3, r"D:\Games\Foo Bar\FooBar.exe"),
            // Stays up while it shows a licence error.
            (4, r"D:\Games\Foo\GameLaunchHelper.exe"),
        ];
        let listed = exes.iter().map(|&(pid, exe)| {
            let exe = Path::new(exe);
            (pid, exe.file_name().unwrap(), Some(exe))
        });
        // By name alone, for a process whose path Windows doesn't tell.
        let by_name = std::iter::once((5, OsStr::new("Runner.exe"), None));
        assert_eq!(watch.pids(listed.chain(by_name)), HashSet::from([1, 2, 5]));
    }
}
