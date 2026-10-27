// The games Lamplit shows: found by discover.rs, recently played first, with art from art.rs and what the player
// keeps per game from user_data.rs, including the games they added by hand (manual.rs). A scan runs at start and
// again when Lamplit comes forward, so new installs show up.

mod art;
mod discover;
mod game;
mod manual;
mod name_match;
mod user_data;

pub use art::Candidate;
pub use game::{Art, ArtChoice, Game, Launch};
pub use manual::{Folder, Program, browse};
pub use user_data::UserData;

use crate::error::{Error, Result};
use crate::events::{self, Event};
use crate::{prefs, stores};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
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
    scans: Scans,
    last_scan: Mutex<Option<Instant>>,
    art_asks: ArtAsks,
}

impl Library {
    pub fn games(&self) -> Option<Vec<Game>> {
        self.games.lock().clone()
    }

    pub fn game(&self, id: &str) -> Option<Game> {
        self.games.lock().iter().flatten().find(|g| g.id == id).cloned()
    }

    /// Keeps the list in step with each "art" event, so a page that asks for the games after an event went out
    /// (and so missed it) still gets the art. False, and the list left alone, when the game is gone or the player has
    /// chosen other art since `g` was read: a pass that started before must not put the old art back.
    fn set_art(&self, g: &Game, art: &Art) -> bool {
        let mut list = self.games.lock();
        let Some(listed) = list.iter_mut().flatten().find(|l| l.id == g.id && l.art_choice == g.art_choice) else {
            return false;
        };
        listed.art = art.clone();
        true
    }
}

/// One scan at a time. A scan asked for while one runs runs once more after it, since the one running may have read
/// the games the player added, and the art they chose, before the change.
#[derive(Default)]
struct Scans {
    running: AtomicBool,
    again: AtomicBool,
}

impl Scans {
    /// True when the caller is to scan now.
    fn start(&self) -> bool {
        let busy = self.running.swap(true, Ordering::SeqCst);
        if busy {
            self.again.store(true, Ordering::SeqCst);
        }
        !busy
    }

    /// The scan has ended. True when another one was asked for meanwhile.
    fn end(&self) -> bool {
        self.running.store(false, Ordering::SeqCst);
        self.again.swap(false, Ordering::SeqCst)
    }
}

/// The art choices asked for, numbered per game. A Steam app's art is downloaded before the choice is saved, which
/// can take seconds, and the page lets the player go back and choose again meanwhile: a choice that finishes after a
/// newer one was asked for is dropped, so the older download can't overwrite the newer choice.
#[derive(Default)]
struct ArtAsks(Mutex<HashMap<String, u64>>);

impl ArtAsks {
    /// A new choice for game `id`: its number.
    fn ask(&self, id: &str) -> u64 {
        let mut asks = self.0.lock();
        let n = asks.entry(id.to_string()).or_default();
        *n += 1;
        *n
    }

    /// Runs `save` if choice `n` is still the newest for `id`, under the lock, so a newer one can't be asked for and
    /// saved in between. Ok(false) when it was dropped.
    fn save_if_newest(&self, id: &str, n: u64, save: impl FnOnce() -> Result<()>) -> Result<bool> {
        let asks = self.0.lock();
        if asks.get(id) != Some(&n) {
            return Ok(false);
        }
        save()?;
        drop(asks);
        Ok(true)
    }
}

/// Scans again unless the last scan was less than `RESCAN_EVERY` ago.
pub fn rescan(app: &AppHandle) {
    let due = app.state::<Library>().last_scan.lock().is_none_or(|t| t.elapsed() >= RESCAN_EVERY);
    if due {
        scan(app);
    }
}

/// Runs discovery on its own thread, or once more after the one running now.
pub fn scan(app: &AppHandle) {
    let library = app.state::<Library>();
    if !library.scans.start() {
        return;
    }
    *library.last_scan.lock() = Some(Instant::now());
    let app = app.clone();
    std::thread::spawn(move || {
        find_games(&app);
        if app.state::<Library>().scans.end() {
            scan(&app);
        }
    });
}

fn find_games(app: &AppHandle) {
    let started = Instant::now();
    let mut games = discover::discover_all(app.state::<UserData>().manual_games());
    if let Err(e) = art::open_folders_to_page(app) {
        log::warn!("art: the page can't load art: {e}");
    }
    log::info!("discovery done: {} games in {} ms", games.len(), started.elapsed().as_millis());
    let library = app.state::<Library>();
    let changed = {
        // What the player keeps per game goes on under the list's lock, as in `change`: a favourite marked, art
        // chosen, or a game added or removed by hand while this scan ran is then on the list either way.
        let mut list = library.games.lock();
        let user = app.state::<UserData>();
        discover::reconcile_manual(&mut games, user.manual_games());
        user.apply(&mut games);
        art::from_disk(&mut games);
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
            let chosen = g.art_choice;
            user_data::apply(g, &entry);
            if g.art_choice != chosen {
                art::from_disk(std::slice::from_mut(g));
            }
        }
        // A game that has just started moves to the front.
        games.sort_by(by_played);
    }
    Ok(())
}

/// Every game, for a command's answer.
fn all(app: &AppHandle) -> Vec<Game> {
    app.state::<Library>().games().unwrap_or_default()
}

/// Puts a game among the favourites, which come first in the row, or takes it out. Returns every game.
pub fn set_favourite(app: &AppHandle, id: &str, on: bool) -> Result<Vec<Game>> {
    change(app, id, |e| e.favourite = on)?;
    log::info!("{id}: {} the favourites", if on { "added to" } else { "removed from" });
    Ok(all(app))
}

/// Hides a game from the row, or shows it again. Returns every game.
pub fn set_hidden(app: &AppHandle, id: &str, on: bool) -> Result<Vec<Game>> {
    change(app, id, |e| e.hidden = on)?;
    log::info!("{id}: {}", if on { "hidden" } else { "shown again" });
    Ok(all(app))
}

/// What Change art finds on Steam's store for `query`.
pub fn art_candidates(app: &AppHandle, query: &str) -> Result<Vec<Candidate>> {
    art::candidates(app, query)
}

/// Gives a game the art the player chose (after fetching what isn't on the PC yet), or back to Lamplit's own match
/// with None. Returns every game.
pub fn set_art(app: &AppHandle, id: &str, choice: Option<ArtChoice>) -> Result<Vec<Game>> {
    let asks = &app.state::<Library>().art_asks;
    let n = asks.ask(id);
    if let Some(ArtChoice::Steam(appid)) = choice {
        art::fetch(app, appid)?;
    }
    if !asks.save_if_newest(id, n, || change(app, id, |e| e.art = choice))? {
        log::info!("{id}: art choice {choice:?} dropped, the player has chosen again since");
        return Ok(all(app));
    }
    log::info!("{id}: art {}", choice.map_or("found by Lamplit".into(), |c| format!("chosen: {c:?}")));
    if choice.is_none() {
        // Lamplit's own match may not be on the PC yet, or not even looked up: a game the player chose art for as
        // soon as it was added.
        scan(app);
    }
    Ok(all(app))
}

/// The installed programs that aren't in the library, for Add a game.
pub fn programs(app: &AppHandle) -> Vec<Program> {
    manual::programs(&all(app))
}

/// A game added by hand, and every game with it.
#[derive(Serialize)]
pub struct Added {
    pub id: String,
    pub games: Vec<Game>,
}

/// Adds the game `exe` starts, named `name`, to the library.
pub fn add_game(app: &AppHandle, exe: &str, name: &str) -> Result<Added> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err(Error::Player("Give the game a name first.".into()));
    }
    let exe = Path::new(exe);
    let id = manual::id(exe);
    let added = manual::Manual { name, exe: exe.to_path_buf() };
    {
        // Under the list's lock, so a scan can't add a game in that folder meanwhile.
        let library = app.state::<Library>();
        let mut list = library.games.lock();
        manual::check(exe, list.as_deref().unwrap_or_default())?;
        let entry = app.state::<UserData>().change(&id, |e| e.manual = Some(added.clone()))?;
        let mut game = manual::game(&id, &added);
        user_data::apply(&mut game, &entry);
        stores::set_requirements(std::slice::from_mut(&mut game));
        let games = list.get_or_insert_default();
        games.push(game);
        games.sort_by(by_played);
    }
    log::info!("{id}: added by hand as {}", added.name);
    // Its art, found by name.
    scan(app);
    Ok(Added { id, games: all(app) })
}

/// Takes a game the player added by hand out of the library again. Returns every game.
pub fn remove_game(app: &AppHandle, id: &str) -> Result<Vec<Game>> {
    let library = app.state::<Library>();
    let mut list = library.games.lock();
    if !list.iter().flatten().any(|g| g.id == id && g.manual) {
        return Err(Error::Player("Only a game added by hand can be removed. Hide this one instead.".into()));
    }
    app.state::<UserData>().remove(id)?;
    list.iter_mut().for_each(|games| games.retain(|g| g.id != id));
    drop(list);
    log::info!("{id}: removed");
    // A scan that read the games before would put it back.
    scan(app);
    Ok(all(app))
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

    #[test]
    fn art_from_a_pass_that_started_before_the_players_choice_is_dropped() {
        let game = Game::new("epic:x".into(), "X".into(), None, PathBuf::new(), Launch::Uri(String::new()));
        let library = Library::default();
        *library.games.lock() = Some(vec![game.clone()]);
        let found = Art { portrait: Some("found.jpg".into()), hero: None, logo: None };
        assert!(library.set_art(&game, &found));
        assert_eq!(library.game("epic:x").unwrap().art, found);
        // The player chose no art while the pass downloaded.
        library.games.lock().as_mut().unwrap()[0] =
            Game { art_choice: Some(ArtChoice::None), art: Art::default(), ..game.clone() };
        assert!(!library.set_art(&game, &found));
        assert_eq!(library.game("epic:x").unwrap().art, Art::default());
        // A game that has left the list.
        assert!(!library.set_art(&Game { id: "gone".into(), ..game }, &found));
    }

    #[test]
    fn an_added_game_reaches_the_page_as_in_its_fixture() {
        let added = Added { id: r"manual:d:\old games\racer\racer.exe".into(), games: Vec::new() };
        assert_eq!(serde_json::to_value(added).unwrap(), ipc_fixture!("added"));
    }

    #[test]
    fn an_art_choice_that_finishes_after_a_newer_one_is_dropped() {
        let asks = ArtAsks::default();
        let saved = &Mutex::new(Vec::new());
        let save = |what: &'static str| {
            move || {
                saved.lock().push(what);
                Ok(())
            }
        };
        // Art from Steam asked for first, still downloading when the player goes back and chooses no art.
        let steam = asks.ask("epic:x");
        let none = asks.ask("epic:x");
        assert!(asks.save_if_newest("epic:x", none, save("none")).unwrap());
        assert!(!asks.save_if_newest("epic:x", steam, save("steam")).unwrap());
        assert_eq!(*saved.lock(), ["none"]);
        // Another game's choice has numbers of its own.
        let other = asks.ask("gog:y");
        assert!(asks.save_if_newest("gog:y", other, save("other")).unwrap());
        assert_eq!(*saved.lock(), ["none", "other"]);
    }

    #[test]
    fn a_scan_asked_for_meanwhile_runs_once_more() {
        let scans = Scans::default();
        assert!(scans.start());
        assert!(!scans.start(), "one at a time");
        assert!(!scans.start());
        assert!(scans.end(), "the two asks during the scan make one more");
        assert!(scans.start());
        assert!(!scans.end(), "nobody asked meanwhile");
        assert!(scans.start(), "free again");
    }
}
