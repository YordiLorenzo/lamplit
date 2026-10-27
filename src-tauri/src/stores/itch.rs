// itch.io: the games the itch app installed, from its database (butler.db, kept by butler, the app's helper). They
// are DRM-free and start from their own exe, as the itch app can also start them, so the app itself never has to
// run.

use super::installed::skip_exe;
use super::names::{clean_name, prettify};
use super::{Store, sqlite};
use crate::files::{file_name, inside, local_app_data, on_a_drive, read_text};
use crate::library::{Game, Launch};
use serde_json::Value;
use std::path::{Path, PathBuf};
use winreg::RegKey;
use winreg::enums::HKEY_CURRENT_USER;

/// The app's installer, itch-setup, puts it in the folder its uninstall entry names (`%LOCALAPPDATA%\itch` unless the
/// player chose another), with each version in its own folder and the current one named in state.json.
pub fn exe() -> Option<PathBuf> {
    let base = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\itch")
        .and_then(|k| k.get_value::<String, _>("InstallLocation"))
        .map_or_else(|_| local_app_data().join("itch"), PathBuf::from);
    app_exe(&base)
}

fn app_exe(base: &Path) -> Option<PathBuf> {
    let state: Value = serde_json::from_str(&read_text(&base.join("state.json"))?).ok()?;
    inside(base, &format!(r"app-{}\itch.exe", state["current"].as_str()?))
}

pub fn games() -> Vec<Game> {
    let Some(roaming) = std::env::var_os("APPDATA") else { return Vec::new() };
    let Some(db) = sqlite::Db::open(&Path::new(&roaming).join(r"itch\db\butler.db")) else { return Vec::new() };
    let mut out: Vec<Game> = Vec::new();
    for cave in caves(&db) {
        let id = format!("itch:{}", cave.game_id);
        // A game installed twice (two of its downloads) is listed once.
        if out.iter().any(|g| g.id == id) {
            continue;
        }
        let name = cave.title.as_deref().map_or_else(|| prettify(&file_name(&cave.dir)), clean_name);
        if !on_a_drive(&cave.dir) || !cave.dir.is_dir() {
            log::info!("discovery itch: {name} skipped, {} is missing", cave.dir.display());
            continue;
        }
        let Some(exe) = cave.exes.iter().filter_map(|rel| inside(&cave.dir, rel)).find(|p| p.is_file()) else {
            log::info!("discovery itch: {name} skipped, it has no Windows exe (an HTML or Java game, say)");
            continue;
        };
        out.push(Game::new(id, name, Some(Store::Itch), cave.dir, Launch::Exe(exe)));
    }
    out
}

/// An install (butler calls it a cave).
#[derive(Debug, PartialEq)]
struct Cave {
    game_id: i64,
    title: Option<String>,
    dir: PathBuf,
    /// The Windows exes the app found in the folder, relative to it, best first.
    exes: Vec<String>,
}

/// The installs of games, from the tables caves, games and install_locations. itch.io also sells tools, assets,
/// soundtracks and books, and the games table says which each is.
fn caves(db: &sqlite::Db) -> Vec<Cave> {
    let (Some(caves), Some(games), Some(locations)) =
        (db.rows("caves"), db.rows("games"), db.rows("install_locations"))
    else {
        return Vec::new();
    };
    caves
        .iter()
        .filter_map(|c| {
            let game_id = c.int("game_id")?;
            let game = games.iter().find(|g| g.int("id") == Some(game_id));
            if game.and_then(|g| g.text("classification")).is_some_and(|kind| kind != "game") {
                return None;
            }
            // A folder of the player's choosing, or one in an install location the app manages.
            let dir = if let Some(custom) = c.text("custom_install_folder").filter(|f| !f.is_empty()) {
                PathBuf::from(custom)
            } else {
                let location = locations.iter().find(|l| l.text("id") == c.text("install_location_id"))?;
                inside(Path::new(location.text("path")?), c.text("install_folder_name")?)?
            };
            let verdict: Value = serde_json::from_str(c.text("verdict")?).ok()?;
            let title = game.and_then(|g| g.text("title")).map(str::to_string);
            Some(Cave { game_id, title, dir, exes: windows_exes(&verdict) })
        })
        .collect()
}

/// The native Windows exes in an install's verdict, the app's scan of the folder: nearest the top of the folder
/// first, then the largest, with crash reporters, installers and the like at the end.
fn windows_exes(verdict: &Value) -> Vec<String> {
    let mut list: Vec<(bool, u64, i64, String)> = verdict["candidates"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["flavor"] == "windows")
        .filter_map(|c| {
            let path = c["path"].as_str()?.replace('/', "\\");
            Some((skip_exe(Path::new(&path)), c["depth"].as_u64().unwrap_or(0), c["size"].as_i64().unwrap_or(0), path))
        })
        .collect();
    list.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)).then(b.2.cmp(&a.2)));
    list.into_iter().map(|(.., path)| path).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stores::sqlite::fixtures::{BUTLER, BUTLER_WAL};
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lamplit-test-itch-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn installs_from_the_apps_database() {
        let dir = scratch("db");
        fs::write(dir.join("butler.db"), BUTLER).unwrap();
        fs::write(dir.join("butler.db-wal"), BUTLER_WAL).unwrap();
        let db = sqlite::Db::open(&dir.join("butler.db")).unwrap();
        let apps = r"C:\Users\player\AppData\Roaming\itch\apps";
        let cave = |game_id, title: &str, dir: &str, exes: &[&str]| Cave {
            game_id,
            title: Some(title.into()),
            dir: PathBuf::from(dir),
            exes: exes.iter().map(|e| (*e).to_string()).collect(),
        };
        // Not the tool. The HTML game is there, with no exe to start (games() leaves it out), and so is the one on a
        // share (games() never follows it).
        assert_eq!(
            caves(&db),
            vec![
                cave(
                    1001,
                    "Fennel",
                    &format!(r"{apps}\fennel"),
                    &["Fennel.exe", r"tools\editor.exe", "UnityCrashHandler64.exe"]
                ),
                cave(1003, "Web Toy", &format!(r"{apps}\web-toy"), &[]),
                cave(1004, "Clover™", r"D:\Games\Clover", &[r"bin\clover.exe"]),
                cave(1005, "Share Game", r"\\nas\itch\share-game", &["share.exe"]),
            ]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_app_in_its_current_version_folder() {
        let base = scratch("app");
        fs::write(base.join("state.json"), r#"{"current":"26.1.9","ready":""}"#).unwrap();
        assert_eq!(app_exe(&base), Some(base.join(r"app-26.1.9\itch.exe")));
        fs::write(base.join("state.json"), r#"{"current":"..\\..\\elsewhere"}"#).unwrap();
        assert_eq!(app_exe(&base), None);
        fs::remove_dir_all(&base).unwrap();
    }
}
