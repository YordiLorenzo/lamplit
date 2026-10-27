// What the player keeps per game, in games.json in the data folder: favourites, hidden games, when each game was
// last played, how long Lamplit has seen it run, the art the player chose, and the games they added by hand. Kept by
// game id, so it outlives an uninstall and is there again after a reinstall.

use super::{ArtChoice, Game, manual};
use crate::data;
use crate::error::Result;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

const FILE: &str = "games.json";
/// Lamplit 0.1.0 kept only when each game was last played, in this file. It is read at every start and never
/// written, so a PC that goes back to 0.1.0 and forward again keeps the times it played meanwhile.
const PLAYED: &str = "played.json";

#[derive(Clone, Default, PartialEq, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Entry {
    /// Unix seconds, 0 for never.
    pub last_played: u64,
    /// How long Lamplit has seen the game run.
    pub play_seconds: u64,
    pub favourite: bool,
    pub hidden: bool,
    /// None: Lamplit's own match.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub art: Option<ArtChoice>,
    /// The game's name and exe, for a game the player added by hand.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manual: Option<manual::Manual>,
    /// A game the player added by hand and removed again, which stays off the row when a scan finds its exe outside
    /// any store (see `discover::reconcile_manual`). Its id names the exe.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub removed: bool,
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
            apply(g, entries.get(&g.id).unwrap_or(&Entry::default()));
        }
    }

    /// The games the player added by hand.
    pub fn manual_games(&self) -> Vec<Game> {
        let entries = self.0.lock();
        entries.iter().filter_map(|(id, e)| e.manual.as_ref().map(|m| manual::game(id, m))).collect()
    }

    /// The exes of the games the player added by hand and removed again.
    pub fn removed(&self) -> Vec<PathBuf> {
        let entries = self.0.lock();
        entries.iter().filter(|(_, e)| e.removed).filter_map(|(id, _)| manual::exe_of(id)).collect()
    }

    /// Saves a change to one game's entry, then makes it, and returns the entry.
    pub fn change(&self, id: &str, change: impl FnOnce(&mut Entry)) -> Result<Entry> {
        let mut entries = self.0.lock();
        let mut entry = entries.get(id).cloned().unwrap_or_default();
        change(&mut entry);
        let before = entries.insert(id.to_string(), entry.clone());
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
pub fn apply(g: &mut Game, entry: &Entry) {
    g.last_played = g.last_played.max(entry.last_played);
    g.play_minutes = g.store_minutes.max(entry.play_seconds / 60);
    g.favourite = entry.favourite;
    g.hidden = entry.hidden;
    g.art_choice = entry.art;
    g.manual = entry.manual.is_some();
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
        let favourite = Entry { last_played: 200, play_seconds: 3600, favourite: true, ..Entry::default() };
        assert_eq!(entries["steam:70"], favourite);
    }

    #[test]
    fn the_page_gets_the_larger_count() {
        let mut game = Game::new("steam:70".into(), "Game".into(), None, PathBuf::new(), Launch::Uri(String::new()));
        game.last_played = 500;
        game.store_minutes = 90;
        let entry =
            Entry { last_played: 400, play_seconds: 30 * 60 + 59, favourite: true, hidden: true, ..Entry::default() };
        apply(&mut game, &entry);
        assert_eq!((game.last_played, game.play_minutes, game.favourite, game.hidden), (500, 90, true, true));
        // Played longer in Lamplit than the store has written down yet.
        game.store_minutes = 20;
        apply(&mut game, &Entry { last_played: 600, ..entry });
        assert_eq!((game.last_played, game.play_minutes), (600, 30));
        // No entry: never marked, nothing counted.
        apply(&mut game, &Entry::default());
        assert_eq!((game.last_played, game.play_minutes, game.favourite, game.hidden), (600, 20, false, false));
    }

    #[test]
    fn keeps_chosen_art_and_games_added_by_hand() {
        let manual = manual::Manual { name: "Old Game".into(), exe: PathBuf::from(r"D:\Old\old.exe") };
        let entries = BTreeMap::from([
            ("epic:fn".to_string(), Entry { art: Some(ArtChoice::Steam(1_091_500)), ..Entry::default() }),
            ("gog:1".to_string(), Entry { art: Some(ArtChoice::None), ..Entry::default() }),
            ("manual:d:\\old\\old.exe".to_string(), Entry { manual: Some(manual.clone()), ..Entry::default() }),
            ("steam:70".to_string(), Entry { favourite: true, ..Entry::default() }),
        ]);
        let json = serde_json::to_value(&entries).unwrap();
        // An entry without a choice or a game added by hand stays as short as Lamplit 0.2.0 wrote it.
        assert_eq!(
            json["steam:70"],
            serde_json::json!({ "last_played": 0, "play_seconds": 0, "favourite": true, "hidden": false })
        );
        assert_eq!(json["epic:fn"]["art"], serde_json::json!({ "steam": 1_091_500 }));
        assert_eq!(json["manual:d:\\old\\old.exe"]["manual"]["name"], "Old Game");
        let back: BTreeMap<String, Entry> = serde_json::from_value(json).unwrap();
        assert_eq!(back, entries);

        let mut game = Game::new("gog:1".into(), "G".into(), None, PathBuf::new(), Launch::Uri(String::new()));
        apply(&mut game, &entries["gog:1"]);
        assert_eq!((game.art_choice, game.manual), (Some(ArtChoice::None), false));
        apply(&mut game, &entries["manual:d:\\old\\old.exe"]);
        assert_eq!((game.art_choice, game.manual), (None, true));
    }
}
