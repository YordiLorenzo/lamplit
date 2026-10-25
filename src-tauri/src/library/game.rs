// A game as Lamplit shows and launches it.

use crate::stores::Store;
use serde::Serialize;
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
    pub art: Art,
    /// Store apps that must run and be signed in: the game's own, plus any its publisher adds.
    pub requires: Vec<Store>,
    #[serde(skip)]
    pub steam_appid: Option<u32>,
    #[serde(skip)]
    pub launch: Launch,
    /// More folders and exe names that count as "the game is running" (Xbox games run from a mirror folder).
    #[serde(skip)]
    pub extra_dirs: Vec<PathBuf>,
    #[serde(skip)]
    pub exe_names: Vec<String>,
}

#[derive(Clone, Default, Serialize, PartialEq)]
pub struct Art {
    pub portrait: Option<String>,
    pub hero: Option<String>,
    pub logo: Option<String>,
}

/// How a game (or a store app) is opened: a link its store handles, or an exe.
#[derive(Clone, PartialEq, Debug)]
pub enum Launch {
    Uri(String),
    Exe(PathBuf),
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
            art: Art::default(),
            requires: Vec::new(),
            steam_appid: None,
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
        game.art.portrait = Some(r"C:\Users\player\AppData\Local\lamplit\art\70\portrait.jpg".into());
        game.requires = vec![Store::Steam, Store::Ea];
        // Lamplit's own: the page doesn't get it.
        game.steam_appid = Some(70);
        assert_eq!(serde_json::to_value([game]).unwrap(), ipc_fixture!("games"));
    }
}
