// The Rockstar Games Launcher: its games (one registry key per title), the games bought elsewhere that still run
// through it, and its remembered sign-in.

use super::installed::pick_exe;
use super::names::clean_name;
use super::{Store, machine_value};
use crate::files::{folder_key, local_app_data, nonempty};
use crate::library::{Game, Launch};
use std::path::{Path, PathBuf};
use winreg::RegKey;
use winreg::enums::HKEY_LOCAL_MACHINE;

const TITLES: &str = r"SOFTWARE\WOW6432Node\Rockstar Games";

pub fn exe() -> Option<PathBuf> {
    machine_value(r"SOFTWARE\WOW6432Node\Rockstar Games\Launcher", "InstallFolder")
        .map(|d| Path::new(&d).join("Launcher.exe"))
}

/// `game_exes`: the exes Windows has seen run as games, which tell which exe in a game's folder starts it.
pub fn games(game_exes: &[PathBuf]) -> Vec<Game> {
    let Ok(root) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(TITLES) else { return Vec::new() };
    let mut out = Vec::new();
    for title in root.enum_keys().flatten() {
        if title == "Launcher" || title == "Steam" || title.contains("Social Club") {
            continue;
        }
        let Ok(dir) = root.open_subkey(&title).and_then(|k| k.get_value::<String, _>("InstallFolder")) else {
            continue;
        };
        let dir = PathBuf::from(dir.trim_end_matches('\\'));
        if !dir.is_dir() {
            continue;
        }
        let Some(exe) = pick_exe(&dir, game_exes, None) else { continue };
        out.push(Game::new(
            format!("rockstar:{title}"),
            clean_name(&title),
            Some(Store::Rockstar),
            dir,
            Launch::Exe(exe),
        ));
    }
    out
}

/// Folders of Rockstar games bought on another store (`InstallFolderSteam`, `InstallFolderEpic`): they run through
/// the Rockstar launcher too.
pub fn owned_dirs() -> Vec<String> {
    let Ok(root) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(TITLES) else { return Vec::new() };
    root.enum_keys()
        .flatten()
        .filter_map(|t| root.open_subkey(t).ok())
        .flat_map(|k| ["InstallFolderSteam", "InstallFolderEpic"].map(|v| k.get_value::<String, _>(v).ok()))
        .flatten()
        .map(|d| folder_key(Path::new(&d)))
        .collect()
}

pub fn remembered() -> bool {
    nonempty(&local_app_data().join(r"Rockstar Games\Launcher\settings_user.dat"))
}
