// What the player keeps per game, in games.json in the data folder: favourites, hidden games, when each game was
// last played, and how long Lamplit has seen it run. Kept by game id, so it outlives an uninstall and is there again
// after a reinstall.

use super::Game;
use crate::data;
use crate::error::Result;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

const FILE: &str = "games.json";
/// Lamplit 0.1.0 kept only when each game was last played, in this file. It is read at every start and never
/// written, so a PC that goes back to 0.1.0 and forward again keeps the times it played meanwhile.
const PLAYED: &str = "played.json";

#[derive(Clone, Copy, Default, PartialEq, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Entry {
    /// Unix seconds, 0 for never.
    pub last_played: u64,
    /// How long Lamplit has seen the game run.
    pub play_seconds: u64,
    pub favourite: bool,
    pub hidden: bool,
}

/// Every game's entry. Tauri state.
pub struct UserData(Mutex<BTreeMap<String, Entry>>);

impl UserData {
    /// Not on the Builder: a file that can't be read is logged, and the log starts in setup.
    pub fn load() -> Self {
        UserData(Mutex::new(merged(data::load_or_default(FILE), data::load_or_default(PLAYED))))
    }

    pub fn apply(&self, games: &mut [Game]) {
        let entries = self.0.lock();
        for g in games {
            apply(g, entries.get(&g.id).copied().unwrap_or_default());
        }
    }

    /// Saves a change to one game's entry, then makes it, and returns the entry.
    pub fn change(&self, id: &str, change: impl FnOnce(&mut Entry)) -> Result<Entry> {
        let mut entries = self.0.lock();
        let mut entry = entries.get(id).copied().unwrap_or_default();
        change(&mut entry);
        let before = entries.insert(id.to_string(), entry);
        if let Err(e) = data::save(FILE, &*entries) {
            match before {
                Some(before) => entries.insert(id.to_string(), before),
                None => entries.remove(id),
            };
            return Err(e);
        }
        Ok(entry)
    }
}

/// games.json's entries, with 0.1.0's last-played times where they are later.
fn merged(mut entries: BTreeMap<String, Entry>, played: HashMap<String, u64>) -> BTreeMap<String, Entry> {
    for (id, at) in played {
        let entry = entries.entry(id).or_default();
        entry.last_played = entry.last_played.max(at);
    }
    entries
}

/// Puts a game's entry on the game the page gets. The store's own counts (Steam's last-played time and play time)
/// win when they are more: they include play outside Lamplit.
pub fn apply(g: &mut Game, entry: Entry) {
    g.last_played = g.last_played.max(entry.last_played);
    g.play_minutes = g.store_minutes.max(entry.play_seconds / 60);
    g.favourite = entry.favourite;
    g.hidden = entry.hidden;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::Launch;
    use std::path::PathBuf;

    #[test]
    fn keeps_the_times_lamplit_0_1_kept() {
        let saved: BTreeMap<String, Entry> = serde_json::from_str(
            r#"{ "steam:70": { "last_played": 200, "play_seconds": 3600, "favourite": true },
                 "epic:fn": { "last_played": 100 } }"#,
        )
        .unwrap();
        // A field games.json doesn't have yet is its default.
        assert!(!saved["steam:70"].hidden);
        let played = HashMap::from([("steam:70".into(), 150), ("epic:fn".into(), 300), ("gog:1".into(), 50)]);
        let entries = merged(saved, played);
        let times: Vec<(&str, u64)> = entries.iter().map(|(id, e)| (id.as_str(), e.last_played)).collect();
        assert_eq!(times, [("epic:fn", 300), ("gog:1", 50), ("steam:70", 200)]);
        assert_eq!(entries["steam:70"], Entry { last_played: 200, play_seconds: 3600, favourite: true, hidden: false });
    }

    #[test]
    fn the_page_gets_the_larger_count() {
        let mut game = Game::new("steam:70".into(), "Game".into(), None, PathBuf::new(), Launch::Uri(String::new()));
        game.last_played = 500;
        game.store_minutes = 90;
        let entry = Entry { last_played: 400, play_seconds: 30 * 60 + 59, favourite: true, hidden: true };
        apply(&mut game, entry);
        assert_eq!((game.last_played, game.play_minutes, game.favourite, game.hidden), (500, 90, true, true));
        // Played longer in Lamplit than the store has written down yet.
        game.store_minutes = 20;
        apply(&mut game, Entry { last_played: 600, ..entry });
        assert_eq!((game.last_played, game.play_minutes), (600, 30));
        // No entry: never marked, nothing counted.
        apply(&mut game, Entry::default());
        assert_eq!((game.last_played, game.play_minutes, game.favourite, game.hidden), (600, 20, false, false));
    }
}
