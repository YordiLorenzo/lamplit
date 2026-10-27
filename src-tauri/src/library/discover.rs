// Finds every installed game: each store's first, then the games the player added by hand, then games outside any
// store. Games are keyed by install folder, so a game found twice appears once (store entries win).

use super::Game;
use crate::files::folder_key;
use crate::stores::{self, Installed};
use std::path::PathBuf;
use std::time::Instant;

/// Every game, with the `manual` ones the player added by hand.
pub fn discover_all(manual: Vec<Game>) -> Vec<Game> {
    let installed = &Installed::read();
    log::info!(
        "discovery: {} installed programs, {} exes in Windows' game list",
        installed.programs.len(),
        installed.game_exes.len()
    );

    // The stores don't depend on each other, so they are read side by side.
    let found: Vec<Vec<Game>> = std::thread::scope(|s| {
        let handles = stores::ALL.map(|store| {
            s.spawn(move || {
                let started = Instant::now();
                let games = store.games(installed);
                log::info!("discovery {} ({} ms): {}", store.key(), started.elapsed().as_millis(), names(&games));
                games
            })
        });
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    });
    let mut games = Vec::new();
    // A game added by hand that a store has installed since is the store's; one in a folder Lamplit also finds
    // outside any store keeps the name and exe the player gave it.
    for g in found.into_iter().flatten().chain(manual) {
        add(&mut games, g);
    }
    let roots: Vec<PathBuf> = installed.drives.iter().map(|d| d.join("Games")).collect();
    let loose = stores::loose::games(&games, &installed.game_exes, &roots, &installed.programs);
    log::info!("discovery outside stores: {}", names(&loose));
    for g in loose {
        add(&mut games, g);
    }
    stores::set_requirements(&mut games);
    games
}

fn names(games: &[Game]) -> String {
    let list: Vec<String> = games.iter().map(|g| format!("{} [{}]", g.name, g.dir.display())).collect();
    if list.is_empty() { "none".into() } else { list.join(", ") }
}

fn add(games: &mut Vec<Game>, g: Game) {
    let key = folder_key(&g.dir);
    if let Some(other) = games.iter().find(|o| folder_key(&o.dir) == key) {
        log::info!("discovery: {} ({}) skipped, its folder belongs to {}", g.name, g.id, other.name);
        return;
    }
    games.push(g);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::Launch;
    use crate::stores::Store;

    #[test]
    fn a_folder_found_twice_keeps_its_first_store() {
        // A game sold on Steam that runs through the EA app is found by both; Steam reads first.
        let game = |id: &str, store, dir: &str| {
            Game::new(id.into(), "Racer".into(), Some(store), PathBuf::from(dir), Launch::Uri(String::new()))
        };
        let mut games = Vec::new();
        add(&mut games, game("steam:1", Store::Steam, r"D:\SteamLibrary\steamapps\common\Racer"));
        add(&mut games, game("ea:racer", Store::Ea, r"d:\steamlibrary\steamapps\common\racer\"));
        add(&mut games, game("ea:other", Store::Ea, r"D:\EA Games\Other"));
        let ids: Vec<&str> = games.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, ["steam:1", "ea:other"]);
    }
}
