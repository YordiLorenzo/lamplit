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
    let windows = launch::game_windows(&watch.pids(Processes::now().iter()));
    let responding = windows.iter().all(|&w| win::window::responds(w, ANSWER_WITHIN));
    let asked = ASKED.lock().as_ref().is_some_and(|(asked, at)| *asked == id && at.elapsed() >= GRACE);
    Some(GameState { id, name, responding, force_close: !responding || windows.is_empty() || asked })
}

/// The player closed or ended the game `id` from the dock after `since` (when Lamplit opened it), so its end is no
/// launcher handing over to the game, which a game that ends within 20 s of starting otherwise is.
pub fn closed_from_dock(id: &str, since: Instant) -> bool {
    ASKED.lock().as_ref().is_some_and(|(asked, at)| asked == id && *at >= since)
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
    let pids = watch.pids(Processes::now().iter());
    if pids.is_empty() {
        return Err(gone());
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

    #[test]
    fn a_close_from_the_dock_counts_for_that_session_only() {
        let opened = Instant::now();
        *ASKED.lock() = Some(("steam:70".into(), Instant::now()));
        assert!(closed_from_dock("steam:70", opened));
        assert!(!closed_from_dock("steam:80", opened));
        // Opened again after that close: a launcher handing over to it is one again.
        assert!(!closed_from_dock("steam:70", Instant::now() + Duration::from_secs(1)));
    }
}
