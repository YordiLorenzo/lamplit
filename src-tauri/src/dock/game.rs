// Closing the game from the dock: asking its windows to close, as their close buttons do, so the game can save or
// ask the player first; or, when it isn't responding or didn't close when asked, ending its processes as Task
// Manager does.

use crate::error::{Error, Result};
use crate::events::{self, Event};
use crate::launch::{self, Launcher};
use crate::library::{Art, Library};
use crate::stores::Processes;
use crate::win;
use parking_lot::Mutex;
use serde::Serialize;
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// The game the dock is over.
#[derive(Clone, Serialize)]
pub struct GameState {
    pub id: String,
    pub name: String,
    /// Its cover, background and logo, which the dock shows it with.
    pub art: Art,
    /// When this session started, Unix seconds (Lamplit records it as the game's last play); 0 when unknown.
    pub started: u64,
    /// This launch of the game, which a close from the dock names, so it can't reach another game or session.
    pub session: u64,
    /// Its window answers Windows.
    pub responding: bool,
    /// Lamplit knows which processes are the game's (`Watch::own_pids`), so the dock can close it. Not for a game
    /// known only by its exe name, or by its folder alone: closing it could reach another program.
    pub closable: bool,
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

/// Where session numbers count from: Lamplit's start (dock::start reads it first).
pub static SESSIONS_FROM: LazyLock<Instant> = LazyLock::new(Instant::now);

/// The number of the launch that opened a game at `opened`: microseconds since SESSIONS_FROM, the same on every
/// reading, and another for each launch.
fn session(opened: Instant) -> u64 {
    opened.saturating_duration_since(*SESSIONS_FROM).as_micros() as u64
}

/// The game the player saw in the dock, `id` in `session`, is the one running now, in the session opened at
/// `opened`. The dock opens on what it knew of the game, so a close it asks for may name a game that has gone since.
fn shown_runs(id: &str, session: u64, running: &str, opened: Instant) -> bool {
    id == running && session == self::session(opened)
}

/// The running game, None when none runs. Reads every process.
pub fn game_state(app: &AppHandle) -> Option<GameState> {
    let (id, watch) = app.state::<Launcher>().running()?;
    let game = app.state::<Library>().game(&id);
    let (name, art, started) = game.map_or_else(|| (id.clone(), Art::default(), 0), |g| (g.name, g.art, g.last_played));
    let procs = Processes::now();
    let pids = watch.own_pids(&procs.list());
    let windows = launch::game_windows(&pids);
    let responding = windows.iter().all(|&w| win::window::responds(w, ANSWER_WITHIN));
    let closable = !pids.is_empty();
    let force_close = closable && offers_force(responding, !windows.is_empty(), &id, watch.opened);
    Some(GameState { id, name, art, started, session: session(watch.opened), responding, closable, force_close })
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

/// Remembers that the player asked the game `id` to close or ended it, in its session opened at `since`. An earlier
/// request in this session stands: asking again mustn't restart the wait before the dock offers Force close.
fn remember_ask(id: String, since: Instant) {
    let mut asked = ASKED.lock();
    if !asked.as_ref().is_some_and(|(a, at)| *a == id && *at >= since) {
        *asked = Some((id, Instant::now()));
    }
}

/// The player closed or ended the game `id` from the dock after `since` (when Lamplit opened it), so its end is no
/// launcher handing over to the game, which a game that ends within 20 s of starting otherwise is.
pub fn closed_from_dock(id: &str, since: Instant) -> bool {
    asked_ago(id, since).is_some()
}

fn name(app: &AppHandle, id: &str) -> String {
    app.state::<Library>().game(id).map_or_else(|| id.to_string(), |g| g.name)
}

/// Closes the game the dock showed, `shown` in `session`, if it still runs: asks its windows to close, or with
/// `force` ends its processes, when the game still gives cause for that. Returns once Windows has the request.
/// Lamplit comes forward once the game has gone, as after any game.
pub fn close_game(app: &AppHandle, force: bool, shown: &str, session: u64) -> Result<()> {
    let gone = || Error::Player("The game has already closed.".into());
    let (id, watch) = app.state::<Launcher>().running().ok_or_else(gone)?;
    if !shown_runs(shown, session, &id, watch.opened) {
        log::info!("dock: {shown} isn't running any more, so it isn't closed ({id} runs)");
        return Err(gone());
    }
    let name = name(app, &id);
    let procs = Processes::now();
    let list = procs.list();
    let pids = watch.own_pids(&list);
    if pids.is_empty() {
        // Running by its exe name only, from a folder that isn't the game's: maybe another program.
        return Err(if watch.pids(&list).is_empty() {
            gone()
        } else {
            Error::Player(format!(
                "Lamplit can't be sure which program is {name}, so it leaves it. Close it in the game."
            ))
        });
    }
    if force {
        // The dock may have offered it on an older reading: a game that answers again, with nobody having asked it to
        // close, is asked rather than ended.
        let windows = launch::game_windows(&pids);
        let responding = windows.iter().all(|&w| win::window::responds(w, ANSWER_WITHIN));
        if !offers_force(responding, !windows.is_empty(), &id, watch.opened) {
            return Err(Error::Player(format!("{name} is responding again. Hold Close game to ask it to close.")));
        }
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
        remember_ask(id.clone(), watch.opened);
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
    remember_ask(id, watch.opened);
    // Back to the game, which may ask whether to quit.
    super::fold(app, true);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reaches_the_page_as_in_its_fixture() {
        let art = Art {
            portrait: Some(r"C:\Users\player\AppData\Local\lamplit\art\70\portrait.jpg".into()),
            hero: Some(r"C:\Users\player\AppData\Local\lamplit\art\70\hero.jpg".into()),
            logo: None,
        };
        let game = GameState {
            id: "steam:70".into(),
            name: "Half-Life".into(),
            art,
            started: 1_761_560_000,
            session: 4_200_000,
            responding: false,
            closable: true,
            force_close: true,
        };
        assert_eq!(serde_json::to_value(game).unwrap(), ipc_fixture!("dock-game"));
    }

    #[test]
    fn a_close_reaches_only_the_game_and_session_the_dock_showed() {
        let opened = Instant::now();
        let shown = session(opened);
        assert!(shown_runs("steam:70", shown, "steam:70", opened));
        // Another game took its place while the dock showed the first.
        assert!(!shown_runs("steam:70", shown, "steam:80", opened));
        // The same game, started again since.
        let reopened = opened + Duration::from_millis(1);
        assert!(!shown_runs("steam:70", shown, "steam:70", reopened));
        // Every reading of one session gives the same number.
        assert_eq!(session(opened), shown);
    }

    // One test for everything that reads ASKED, which tests running side by side would share.
    #[test]
    fn a_close_from_the_dock_counts_in_its_session_only() {
        let opened = Instant::now().checked_sub(Duration::from_mins(2)).unwrap();
        let asked = Instant::now().checked_sub(Duration::from_secs(30)).unwrap();
        *ASKED.lock() = Some(("steam:70".into(), asked));
        assert!(closed_from_dock("steam:70", opened));
        assert!(!closed_from_dock("steam:80", opened));
        // Asked 30 s ago in this session, and still running: the dock offers to end it, also after asking again.
        assert!(offers_force(true, true, "steam:70", opened));
        remember_ask("steam:70".into(), opened);
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
