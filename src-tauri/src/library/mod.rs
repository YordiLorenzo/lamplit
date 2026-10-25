// The games Lamplit shows: found by discover.rs, recently played first, with art from art.rs. A scan runs at start
// and again when Lamplit comes forward, so new installs show up.

mod art;
mod discover;
mod game;
mod name_match;

pub use game::{Art, Game, Launch};

use crate::error::Result;
use crate::events::{self, Event};
use crate::{launch, prefs, stores};
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
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
    let played = launch::load_played();
    for g in &mut games {
        g.last_played = g.last_played.max(played.get(&g.id).copied().unwrap_or(0));
    }
    games.sort_by(by_played);
    if let Err(e) = art::open_folders_to_page(app) {
        log::warn!("art: the page can't load art: {e}");
    }
    art::from_disk(&mut games);
    log::info!("discovery done: {} games in {} ms", games.len(), started.elapsed().as_millis());
    let library = app.state::<Library>();
    let changed = library.games.lock().replace(games.clone()).is_none_or(|old| old != games);
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
/// name in lower case.
fn by_played(a: &Game, b: &Game) -> std::cmp::Ordering {
    b.last_played.cmp(&a.last_played).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
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
