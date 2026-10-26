// The games Lamplit shows: found by discover.rs, recently played first, with art from art.rs and what the player
// keeps per game from user_data.rs. A scan runs at start and again when Lamplit comes forward, so new installs show
// up.

mod art;
mod discover;
mod game;
mod name_match;
mod user_data;

pub use game::{Art, Game, Launch};
pub use user_data::UserData;

use crate::error::Result;
use crate::events::{self, Event};
use crate::{prefs, stores};
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// Scans asked for by the page run at most this often.
const RESCAN_EVERY: Duration = Duration::from_secs(30);

/// The games found, and the scan that finds them. Tauri state.
#[derive(Default)]
pub struct Library {
    /// None until the first scan has finished.
    games: Mutex<Option<Vec<Game>>>,
    scanning: AtomicBool,
    last_scan: Mutex<Option<Instant>>,
}

impl Library {
    pub fn games(&self) -> Option<Vec<Game>> {
        self.games.lock().clone()
    }

    pub fn game(&self, id: &str) -> Option<Game> {
        self.games.lock().iter().flatten().find(|g| g.id == id).cloned()
    }

    /// Keeps the list in step with each "art" event, so a page that asks for the games after an event went out
    /// (and so missed it) still gets the art.
    fn set_art(&self, id: &str, art: &Art) {
        if let Some(g) = self.games.lock().iter_mut().flatten().find(|g| g.id == id) {
            g.art = art.clone();
        }
    }
}

/// Scans again unless the last scan was less than `RESCAN_EVERY` ago.
pub fn rescan(app: &AppHandle) {
    let due = app.state::<Library>().last_scan.lock().is_none_or(|t| t.elapsed() >= RESCAN_EVERY);
    if due {
        scan(app);
    }
}

/// Runs discovery on its own thread, unless one is already running.
pub fn scan(app: &AppHandle) {
    let library = app.state::<Library>();
    if library.scanning.swap(true, Ordering::SeqCst) {
        return;
    }
    *library.last_scan.lock() = Some(Instant::now());
    let app = app.clone();
    std::thread::spawn(move || {
        find_games(&app);
        app.state::<Library>().scanning.store(false, Ordering::SeqCst);
    });
}

fn find_games(app: &AppHandle) {
    let started = Instant::now();
    let mut games = discover::discover_all();
    if let Err(e) = art::open_folders_to_page(app) {
        log::warn!("art: the page can't load art: {e}");
    }
    art::from_disk(&mut games);
    log::info!("discovery done: {} games in {} ms", games.len(), started.elapsed().as_millis());
    let library = app.state::<Library>();
    let changed = {
        // What the player keeps per game goes on under the list's lock, as in `change`: a favourite marked while
        // this scan ran is then on the list either way.
        let mut list = library.games.lock();
        app.state::<UserData>().apply(&mut games);
        games.sort_by(by_played);
        list.replace(games.clone()).is_none_or(|old| old != games)
    };
    if changed {
        events::emit(app, Event::Games(&games));
    }
    events::emit(app, Event::Stores(stores::status_all()));

    if prefs::get(app).online_art {
        art::fetch_missing(app, &games);
        log::info!("art done in {} ms", started.elapsed().as_millis());
    }
}

/// The cover row's order, which the page keeps when it reorders (ui/logic.js byPlayed): last played first, then by
/// name in lower case. The page puts the favourites in front (rowGames).
fn by_played(a: &Game, b: &Game) -> std::cmp::Ordering {
    b.last_played.cmp(&a.last_played).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
}

/// Changes what Lamplit keeps for one game, and the game on the list to match.
fn change(app: &AppHandle, id: &str, change: impl FnOnce(&mut user_data::Entry)) -> Result<()> {
    // The list's lock first, as in a scan, so a scan that ends meanwhile can't put back the game as it was.
    let library = app.state::<Library>();
    let mut list = library.games.lock();
    let entry = app.state::<UserData>().change(id, change)?;
    if let Some(games) = list.as_mut() {
        if let Some(g) = games.iter_mut().find(|g| g.id == id) {
            user_data::apply(g, entry);
        }
        // A game that has just started moves to the front.
        games.sort_by(by_played);
    }
    Ok(())
}

/// Puts a game among the favourites, which come first in the row, or takes it out. Returns every game.
pub fn set_favourite(app: &AppHandle, id: &str, on: bool) -> Result<Vec<Game>> {
    change(app, id, |e| e.favourite = on)?;
    log::info!("{id}: {} the favourites", if on { "added to" } else { "removed from" });
    Ok(app.state::<Library>().games().unwrap_or_default())
}

/// Hides a game from the row, or shows it again. Returns every game.
pub fn set_hidden(app: &AppHandle, id: &str, on: bool) -> Result<Vec<Game>> {
    change(app, id, |e| e.hidden = on)?;
    log::info!("{id}: {}", if on { "hidden" } else { "shown again" });
    Ok(app.state::<Library>().games().unwrap_or_default())
}

/// The game runs: it is the last one played. Called once it runs, as a launch the player cancels, or one that never
/// gets going, isn't a play.
pub fn record_start(app: &AppHandle, id: &str) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    if let Err(e) = change(app, id, |e| e.last_played = now) {
        log::warn!("{id}: can't save when it was played: {e}");
    }
}

pub fn add_play_time(app: &AppHandle, id: &str, seconds: u64) {
    if let Err(e) = change(app, id, |e| e.play_seconds += seconds) {
        log::warn!("{id}: can't save {seconds} s of play time: {e}");
    }
}

/// Sends the page every game as Lamplit has them now, after a game's play time changed.
pub fn send(app: &AppHandle) {
    if let Some(games) = app.state::<Library>().games() {
        events::emit(app, Event::Games(&games));
    }
}

/// Lets Lamplit find art online, or not. Switched on, a scan fetches what is missing now; switched off, a pass that
/// is going online stops at its next request.
pub fn set_online_art(app: &AppHandle, on: bool) -> Result<()> {
    prefs::change(app, |p| p.online_art = on)?;
    log::info!("art online {}", if on { "on" } else { "off" });
    if on {
        scan(app);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn sorts_as_the_page_does() {
        let order = ipc_fixture!("order");
        let mut games: Vec<Game> = order["games"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| {
                let name = g["name"].as_str().unwrap().to_string();
                let mut game = Game::new(name.clone(), name, None, PathBuf::new(), Launch::Uri(String::new()));
                game.last_played = g["last_played"].as_u64().unwrap();
                game
            })
            .collect();
        games.sort_by(by_played);
        let names: Vec<&str> = games.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(serde_json::json!(names), order["sorted"]);
    }
}
