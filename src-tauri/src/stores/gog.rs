// GOG: games installed by GOG Galaxy or GOG's offline installers (both write the same key), and the info file every
// GOG game carries. GOG games are DRM-free and start from their own exe, so Galaxy itself never has to run.

use super::names::clean_name;
use super::{Store, machine_value};
use crate::files::{file_name, inside, read_text};
use crate::library::{Game, Launch};
use serde_json::Value;
use std::path::{Path, PathBuf};
use winreg::RegKey;
use winreg::enums::HKEY_LOCAL_MACHINE;

pub fn exe() -> Option<PathBuf> {
    machine_value(r"SOFTWARE\WOW6432Node\GOG.com\GalaxyClient\paths", "client")
        .map(|d| Path::new(&d).join("GalaxyClient.exe"))
}

pub fn games() -> Vec<Game> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let Ok(root) = hklm.open_subkey(r"SOFTWARE\WOW6432Node\GOG.com\Games") else { return Vec::new() };
    let mut out = Vec::new();
    for id in root.enum_keys().flatten() {
        let Ok(key) = root.open_subkey(&id) else { continue };
        let value = |name: &str| key.get_value::<String, _>(name).unwrap_or_default();
        // DLC gets a key of its own that names the game it belongs to, and can share that game's folder.
        if !value("dependsOn").is_empty() {
            continue;
        }
        let (name, dir, exe) = (value("gameName"), PathBuf::from(value("path")), PathBuf::from(value("exe")));
        if name.is_empty() || !exe.is_file() || !dir.is_dir() {
            continue;
        }
        out.push(Game::new(format!("gog:{id}"), clean_name(&name), Some(Store::Gog), dir, Launch::Exe(exe)));
    }
    out
}

/// A GOG game's name and main exe, from the `goggame-<id>.info` it carries, also when copied without an installer.
pub fn info(dir: &Path) -> Option<(String, Option<PathBuf>)> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let n = file_name(p).to_lowercase();
            n.starts_with("goggame-") && n.ends_with(".info")
        })
        .collect();
    files.sort();
    let infos: Vec<Value> = files.iter().filter_map(|p| serde_json::from_str(&read_text(p)?).ok()).collect();
    let v = main_info(&infos)?;
    let name = clean_name(v["name"].as_str()?);
    // Only a file inside the game's folder: the info file may have come with a folder copied in from anywhere.
    let exe = primary_task(v).and_then(|p| inside(dir, &p.replace('/', "\\"))).filter(|p| p.is_file());
    Some((name, exe))
}

/// A game with DLC carries an info file per DLC next to its own. The game's is its own root (gameId is rootGameId);
/// in files without a root id it is the one with play tasks. A lone file without either still names the game.
fn main_info(infos: &[Value]) -> Option<&Value> {
    let own_root = |v: &&Value| v["gameId"].as_str().is_some_and(|id| v["rootGameId"].as_str() == Some(id));
    infos.iter().find(own_root).or_else(|| infos.iter().find(|v| primary_task(v).is_some())).or(infos.first())
}

/// The path of the play task marked primary, else of the first one.
fn primary_task(info: &Value) -> Option<&str> {
    let tasks = info["playTasks"].as_array()?;
    let task = tasks.iter().find(|t| t["isPrimary"].as_bool() == Some(true)).or(tasks.first())?;
    task["path"].as_str()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn picks_the_game_over_its_dlc() {
        let dlc = json!({ "gameId": "1100", "rootGameId": "1000", "name": "Fennel: Soundtrack" });
        let game = json!({
            "gameId": "1000", "rootGameId": "1000", "name": "Fennel",
            "playTasks": [{ "path": "tools/editor.exe" }, { "isPrimary": true, "path": "bin/fennel.exe" }],
        });
        let infos = [dlc.clone(), game.clone()];
        assert_eq!(main_info(&infos), Some(&game));
        assert_eq!(primary_task(&game), Some("bin/fennel.exe"));

        // Without root ids, the game's info is the one with something to start.
        let old_dlc = json!({ "gameId": "1100", "name": "Fennel: Soundtrack" });
        let old_game = json!({ "gameId": "1000", "name": "Fennel", "playTasks": [{ "path": "fennel.exe" }] });
        let infos = [old_dlc.clone(), old_game.clone()];
        assert_eq!(main_info(&infos), Some(&old_game));
        assert_eq!(primary_task(&old_game), Some("fennel.exe"));

        // One info file and nothing to start: still the game's name.
        assert_eq!(main_info(std::slice::from_ref(&old_dlc)), Some(&old_dlc));
        assert_eq!(main_info(&[]), None);
    }
}
