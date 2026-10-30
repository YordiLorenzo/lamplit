// Finds every installed game: each store's first, then the games the player added by hand, then games outside any
// store. Games are keyed by install folder, so a game found twice appears once (store entries win).

use super::Game;
use crate::files::folder_key;
use crate::stores::{self, Installed};
use std::path::{Path, PathBuf};
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

/// Brings the games added by hand among `games`, which a scan found, in line with `manual`, those the player has now. A
/// scan reads them before the stores, and the player may add or remove one meanwhile: a game added then would leave
/// the row until the next scan, and one removed would come back. `removed`: the exes of games the player added by
/// hand and removed again. Found outside any store (Windows' game list may have such an exe once it has run), they
/// stay off the row.
pub fn reconcile_manual(games: &mut Vec<Game>, manual: Vec<Game>, removed: &[PathBuf]) {
    games.retain(|g| !g.manual || manual.iter().any(|m| m.id == g.id));
    let holds = |dir: &Path, exe: &Path| folder_key(exe).starts_with(&format!("{}\\", folder_key(dir)));
    games.retain(|g| g.manual || g.store.is_some() || !removed.iter().any(|exe| holds(&g.dir, exe)));
    for mut g in manual {
        let key = folder_key(&g.dir);
        if !games.iter().any(|o| o.id == g.id || folder_key(&o.dir) == key) {
            stores::set_requirements(std::slice::from_mut(&mut g));
            games.push(g);
        }
    }
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

    #[test]
    fn a_scan_keeps_up_with_games_added_or_removed_meanwhile() {
        let manual = |id: &str, dir: &str| {
            let exe = PathBuf::from(dir).join("game.exe");
            let mut g = Game::new(id.into(), id.into(), None, PathBuf::from(dir), Launch::Exe(exe));
            g.manual = true;
            g
        };
        let store_game = Game::new(
            "steam:1".into(),
            "Racer".into(),
            Some(Store::Steam),
            r"D:\Steam\Racer".into(),
            Launch::Uri(String::new()),
        );
        // The scan read Old before the player removed it, and missed New, which they added meanwhile.
        let mut games = vec![store_game, manual("manual:old", r"D:\Old")];
        let now = vec![manual("manual:new", r"D:\New"), manual("manual:racer", r"D:\Steam\Racer")];
        reconcile_manual(&mut games, now, &[]);
        // A game added by hand in a folder a store has since installed into stays the store's.
        let ids: Vec<&str> = games.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, ["steam:1", "manual:new"]);
    }

    #[test]
    fn a_game_removed_by_hand_stays_off_once_windows_knows_its_exe() {
        // The player added Racer by hand, played it, so Windows' game list now has its exe, and removed it again.
        let exe = PathBuf::from(r"D:\Old Games\Racer\bin\Racer.exe");
        let mut games = stores::loose::games(&[], std::slice::from_ref(&exe), &[], &[]);
        let ids: Vec<&str> = games.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, [r"pc:d:\old games\racer"], "found outside any store");
        let store_game = |dir: &str| {
            Game::new("steam:1".into(), "Racer".into(), Some(Store::Steam), dir.into(), Launch::Uri(String::new()))
        };
        games.push(store_game(r"D:\Steam\Racer"));
        reconcile_manual(&mut games, Vec::new(), &[exe]);
        let ids: Vec<&str> = games.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, ["steam:1"]);
    }
}
