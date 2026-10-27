// Closing the game from the dock: asking its windows to close, as their close buttons do, so the game can save or
// ask the player first; or, when it isn't responding or didn't close when asked, ending its processes as Task
// Manager does.

use crate::error::{Error, Result};
use crate::events::{self, Event};
use crate::launch::{self, Launcher};
use crate::library::Library;
use crate::stores::Processes;
use crate::win;
use parking_lot::Mutex;
use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// The game the dock is over.
#[derive(Clone, Serialize)]
pub struct GameState {
    pub id: String,
    pub name: String,
    /// Its window answers Windows.
    pub responding: bool,
    /// The dock offers to end the game: it isn't responding, has no window to ask, or was asked to close a while ago
    /// and still runs.
    pub force_close: bool,
}

/// The game the player last asked to close or ended, and when.
static ASKED: Mutex<Option<(String, Instant)>> = Mutex::new(None);
/// How long a game gets to close, or to ask the player whether to quit, before the dock offers to end it.
const GRACE: Duration = Duration::from_secs(10);
/// A game window that doesn't answer Windows within this counts as not responding.
const ANSWER_WITHIN: Duration = Duration::from_secs(1);

/// The running game, None when none runs. Reads every process.
pub fn game_state(app: &AppHandle) -> Option<GameState> {
    let (id, watch) = app.state::<Launcher>().running()?;
    let name = name(app, &id);
    let procs = Processes::now();
    let windows = launch::game_windows(&watch.own_pids(procs.iter(), &procs.parents()));
    let responding = windows.iter().all(|&w| win::window::responds(w, ANSWER_WITHIN));
    let force_close = offers_force(responding, !windows.is_empty(), &id, watch.opened);
    Some(GameState { id, name, responding, force_close })
}

/// The dock offers to end the game: it isn't responding, has no window to ask, or the player asked it to close at
/// least GRACE ago in this session (opened at `since`) and it still runs.
fn offers_force(responding: bool, has_window: bool, id: &str, since: Instant) -> bool {
    !responding || !has_window || asked_ago(id, since).is_some_and(|ago| ago >= GRACE)
}

/// How long ago the player asked from the dock to close or end the game `id` in its session opened at `since`. A
/// request in an earlier session of the same game doesn't count.
fn asked_ago(id: &str, since: Instant) -> Option<Duration> {
    ASKED.lock().as_ref().filter(|(asked, at)| asked == id && *at >= since).map(|(_, at)| at.elapsed())
}

/// The player closed or ended the game `id` from the dock after `since` (when Lamplit opened it), so its end is no
/// launcher handing over to the game, which a game that ends within 20 s of starting otherwise is.
pub fn closed_from_dock(id: &str, since: Instant) -> bool {
    asked_ago(id, since).is_some()
}

fn name(app: &AppHandle, id: &str) -> String {
    app.state::<Library>().game(id).map_or_else(|| id.to_string(), |g| g.name)
}

/// Closes the running game: asks its windows to close, or with `force` ends its processes. Returns once Windows has
/// the request. Lamplit comes forward once the game has gone, as after any game.
pub fn close_game(app: &AppHandle, force: bool) -> Result<()> {
    let gone = || Error::Player("The game has already closed.".into());
    let (id, watch) = app.state::<Launcher>().running().ok_or_else(gone)?;
    let name = name(app, &id);
    let procs = Processes::now();
    let pids = watch.own_pids(procs.iter(), &procs.parents());
    if pids.is_empty() {
        // Running by its exe name only, from a folder that isn't the game's: maybe another program.
        return Err(if watch.pids(procs.iter()).is_empty() {
            gone()
        } else {
            Error::Player(format!(
                "Lamplit can't be sure which program is {name}, so it leaves it. Close it in the game."
            ))
        });
    }
    if force {
        let ended = pids
            .iter()
            .filter(|&&pid| {
                win::dock::end_process(pid).inspect_err(|e| log::warn!("dock: can't end process {pid}: {e}")).is_ok()
            })
            .count();
        if ended == 0 {
            return Err(Error::Player(format!("Windows didn't let Lamplit end {name}.")));
        }
        log::info!("dock: ended {name} ({ended} of {} processes)", pids.len());
        *ASKED.lock() = Some((id.clone(), Instant::now()));
        // The watcher notices only after the game has been gone for 5 s; until then the screen would show the desktop.
        launch::window::bring_lamplit_forward(app);
        events::emit(app, Event::Summoned(Some(id)));
        return Ok(());
    }
    let windows = launch::game_windows(&pids);
    if windows.is_empty() {
        return Err(Error::Player(format!("{name} has no window to close.")));
    }
    for w in windows {
        if let Err(e) = win::dock::ask_to_close(w) {
            log::warn!("dock: can't ask {name}'s window to close: {e}");
        }
    }
    log::info!("dock: asked {name} to close");
    *ASKED.lock() = Some((id, Instant::now()));
    // Back to the game, which may ask whether to quit.
    super::fold(app, true);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reaches_the_page_as_in_its_fixture() {
        let game = GameState { id: "steam:70".into(), name: "Half-Life".into(), responding: false, force_close: true };
        assert_eq!(serde_json::to_value(game).unwrap(), ipc_fixture!("dock-game"));
    }

    // One test for everything that reads ASKED, which tests running side by side would share.
    #[test]
    fn a_close_from_the_dock_counts_in_its_session_only() {
        let opened = Instant::now().checked_sub(Duration::from_mins(2)).unwrap();
        let asked = Instant::now().checked_sub(Duration::from_secs(30)).unwrap();
        *ASKED.lock() = Some(("steam:70".into(), asked));
        assert!(closed_from_dock("steam:70", opened));
        assert!(!closed_from_dock("steam:80", opened));
        // Asked 30 s ago in this session, and still running: the dock offers to end it.
        assert!(offers_force(true, true, "steam:70", opened));
        // Opened again since: a launcher handing over is one again, and the new session is offered no forced close.
        let reopened = Instant::now();
        assert!(!closed_from_dock("steam:70", reopened));
        assert!(!offers_force(true, true, "steam:70", reopened));
        // Not responding, or no window to ask, is reason enough in any session.
        assert!(offers_force(false, true, "steam:70", reopened));
        assert!(offers_force(true, false, "steam:70", reopened));
    }
}
