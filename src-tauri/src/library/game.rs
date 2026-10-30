// A game as Lamplit shows and launches it.

use crate::stores::Store;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Serialize, PartialEq)]
pub struct Game {
    pub id: String,
    pub name: String,
    /// None for a game outside any store.
    pub store: Option<Store>,
    pub dir: PathBuf,
    /// "Installing" or "Update pending", from the store's own state.
    pub note: Option<&'static str>,
    pub last_played: u64,
    /// The store's count (`store_minutes`) or Lamplit's, whichever is more (user_data.rs).
    pub play_minutes: u64,
    /// Comes first in the row.
    pub favourite: bool,
    /// Left out of the row; Settings lists it.
    pub hidden: bool,
    pub art: Art,
    /// The art the player chose in Change art; None for Lamplit's own match.
    pub art_choice: Option<ArtChoice>,
    /// Added by hand (Settings > Add a game), so the player can remove it again.
    pub manual: bool,
    /// Store apps that must run and be signed in: the game's own, plus any its publisher adds.
    pub requires: Vec<Store>,
    #[serde(skip)]
    pub steam_appid: Option<u32>,
    /// Minutes played as the store counts them, play outside Lamplit included; 0 for a store that keeps no count.
    #[serde(skip)]
    pub store_minutes: u64,
    #[serde(skip)]
    pub launch: Launch,
    /// More folders and exe names that count as "the game is running" (Xbox games run from a mirror folder).
    #[serde(skip)]
    pub extra_dirs: Vec<PathBuf>,
    #[serde(skip)]
    pub exe_names: Vec<String>,
}

#[derive(Clone, Default, Serialize, PartialEq, Debug)]
pub struct Art {
    pub portrait: Option<String>,
    pub hero: Option<String>,
    pub logo: Option<String>,
}

/// The art the player chose for a game, kept in games.json. The page sends it back as it gets it.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtChoice {
    /// The art of this app on Steam's store.
    Steam(u32),
    /// No art: the cover shows the game's name.
    None,
}

/// How a game (or a store app) is opened: a link its store handles, or an exe.
#[derive(Clone, PartialEq, Debug)]
pub enum Launch {
    Uri(String),
    Exe(PathBuf),
    /// An exe with its arguments: a store app told which game to start (Battle.net's `--exec="launch <code>"`).
    ExeArgs(PathBuf, String),
}

impl Game {
    pub fn new(id: String, name: String, store: Option<Store>, dir: PathBuf, launch: Launch) -> Self {
        Game {
            id,
            name,
            store,
            dir,
            note: None,
            last_played: 0,
            play_minutes: 0,
            favourite: false,
            hidden: false,
            art: Art::default(),
            art_choice: None,
            manual: false,
            requires: Vec::new(),
            steam_appid: None,
            store_minutes: 0,
            launch,
            extra_dirs: Vec::new(),
            exe_names: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reaches_the_page_as_in_its_fixture() {
        let mut game = Game::new(
            "steam:70".into(),
            "Example Game".into(),
            Some(Store::Steam),
            PathBuf::from(r"D:\SteamLibrary\steamapps\common\Example Game"),
            Launch::Uri("steam://rungameid/70".into()),
        );
        game.note = Some("Update pending");
        game.last_played = 1_760_000_000;
        game.play_minutes = 754;
        game.favourite = true;
        game.art.portrait = Some(r"C:\Users\player\AppData\Local\lamplit\art\70\portrait.jpg".into());
        game.requires = vec![Store::Steam, Store::Ea];
        // Lamplit's own: the page doesn't get them.
        game.steam_appid = Some(70);
        game.store_minutes = 754;
        assert_eq!(serde_json::to_value([game]).unwrap(), ipc_fixture!("games"));
    }

    #[test]
    fn art_choices_go_both_ways_as_in_their_fixture() {
        let choices = [ArtChoice::Steam(1_091_500), ArtChoice::None];
        assert_eq!(serde_json::to_value(choices).unwrap(), ipc_fixture!("art-choice"));
        let back: Vec<ArtChoice> = serde_json::from_value(ipc_fixture!("art-choice")).unwrap();
        assert_eq!(back, choices);
    }
}
