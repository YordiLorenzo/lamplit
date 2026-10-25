// The Epic Games Launcher: where it is, its games (the .item manifests in ProgramData) and its remembered sign-in.

use super::Store;
use super::names::clean_name;
use crate::files::{local_app_data, on_a_drive, read_text};
use crate::library::{Game, Launch};
use serde_json::Value;
use std::path::{Path, PathBuf};
use winreg::RegKey;
use winreg::enums::HKEY_CLASSES_ROOT;

/// The launcher's 64-bit exe. It opens the `com.epicgames.launcher://` links games start with, so wherever it was
/// installed, that link's registration points at it; the default folder is the fallback.
pub fn exe() -> Option<PathBuf> {
    let command: Option<String> = RegKey::predef(HKEY_CLASSES_ROOT)
        .open_subkey(r"com.epicgames.launcher\shell\open\command")
        .and_then(|k| k.get_value(""))
        .ok();
    command.as_deref().and_then(exe_from_command).filter(|p| p.is_file()).or_else(|| {
        let x86 = std::env::var_os("ProgramFiles(x86)")?;
        Some(Path::new(&x86).join(r"Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe"))
    })
}

/// `"C:\…\Portal\Binaries\Win32\EpicGamesLauncher.exe" %1` gives the Win64 exe in the same Binaries folder.
fn exe_from_command(command: &str) -> Option<PathBuf> {
    let registered = command.trim_start_matches('"').split('"').next()?;
    let binaries = Path::new(registered).parent()?.parent()?;
    Some(binaries.join(r"Win64\EpicGamesLauncher.exe"))
}

pub fn games() -> Vec<Game> {
    let Some(program_data) = std::env::var_os("ProgramData") else { return Vec::new() };
    let Ok(rd) = std::fs::read_dir(Path::new(&program_data).join(r"Epic\EpicGamesLauncher\Data\Manifests")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        if entry.path().extension().is_none_or(|e| !e.eq_ignore_ascii_case("item")) {
            continue;
        }
        let Some(v) = read_text(&entry.path()).and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
            continue;
        };
        if !is_game(&v) {
            continue;
        }
        let s = |k: &str| v[k].as_str().unwrap_or_default().to_string();
        let dir = PathBuf::from(s("InstallLocation"));
        if !on_a_drive(&dir) || !dir.is_dir() {
            log::info!("discovery epic: {} skipped, {} is missing", s("DisplayName"), dir.display());
            continue;
        }
        let (app, ns, item) = (s("AppName"), s("CatalogNamespace"), s("CatalogItemId"));
        out.push(Game::new(
            format!("epic:{app}"),
            clean_name(&s("DisplayName")),
            Some(Store::Epic),
            dir,
            Launch::Uri(format!("com.epicgames.launcher://apps/{ns}%3A{item}%3A{app}?action=launch&silent=true")),
        ));
    }
    out
}

/// Epic also writes manifests for add-ons, for DLC (which shares the game's folder, and would name the game after
/// itself) and for Unreal Engine versions. None of them is a game to start, and neither is an unfinished install.
fn is_game(manifest: &Value) -> bool {
    let s = |k: &str| manifest[k].as_str().unwrap_or_default();
    let addon = manifest["AppCategories"].as_array().is_some_and(|c| c.iter().any(|x| x.as_str() == Some("addons")));
    // Older manifests don't name the main game.
    let dlc = manifest["MainGameAppName"].as_str().is_some_and(|main| main != s("AppName"));
    let engine = s("AppName").starts_with("UE_");
    let incomplete = manifest["bIsIncompleteInstall"].as_bool() == Some(true);
    !(addon || dlc || engine || incomplete || s("LaunchExecutable").is_empty())
}

pub fn remembered() -> bool {
    ["Windows", "WindowsEditor"].iter().any(|flavour| {
        let ini = local_app_data().join(format!(r"EpicGamesLauncher\Saved\Config\{flavour}\GameUserSettings.ini"));
        read_text(&ini).is_some_and(|text| remember_me(&text))
    })
}

/// Epic keeps "remember me" as `[RememberMe] Enable=True` plus an encrypted `Data=` token.
fn remember_me(ini: &str) -> bool {
    let section: Vec<&str> =
        ini.lines().skip_while(|l| l.trim() != "[RememberMe]").skip(1).take_while(|l| !l.starts_with('[')).collect();
    let value = |key: &str| section.iter().find_map(|l| l.trim().strip_prefix(key)).map(str::trim);
    value("Enable=").is_some_and(|v| v.eq_ignore_ascii_case("true")) && value("Data=").is_some_and(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn finds_the_launcher_from_its_link_registration() {
        let quoted = r#""C:\Program Files (x86)\Epic Games\Launcher\Portal\Binaries\Win32\EpicGamesLauncher.exe" %1"#;
        assert_eq!(
            exe_from_command(quoted),
            Some(PathBuf::from(
                r"C:\Program Files (x86)\Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe"
            ))
        );
        let bare = r"E:\Epic\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe %1";
        assert_eq!(
            exe_from_command(bare),
            Some(PathBuf::from(r"E:\Epic\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe"))
        );
    }

    #[test]
    fn keeps_only_games() {
        let game = json!({ "AppName": "Fennel", "MainGameAppName": "Fennel", "LaunchExecutable": "Game.exe" });
        assert!(is_game(&game));
        let older = json!({ "AppName": "Fennel", "LaunchExecutable": "Game.exe" });
        assert!(is_game(&older));
        let dlc = json!({ "AppName": "FennelSoundtrack", "MainGameAppName": "Fennel", "LaunchExecutable": "Game.exe" });
        assert!(!is_game(&dlc));
        let addon = json!({ "AppName": "Pack", "AppCategories": ["addons"], "LaunchExecutable": "Game.exe" });
        assert!(!is_game(&addon));
        let engine =
            json!({ "AppName": "UE_5.4", "MainGameAppName": "UE_5.4", "LaunchExecutable": "UnrealEditor.exe" });
        assert!(!is_game(&engine));
        let unfinished = json!({ "AppName": "Fennel", "LaunchExecutable": "Game.exe", "bIsIncompleteInstall": true });
        assert!(!is_game(&unfinished));
        assert!(!is_game(&json!({ "AppName": "Tool", "LaunchExecutable": "" })));
    }

    #[test]
    fn reads_remember_me() {
        let ini = "[Launcher]\nEnable=False\n[RememberMe]\nEnable=True\nData=c2VjcmV0\n[Portal]\nData=\n";
        assert!(remember_me(ini));
        assert!(!remember_me("[RememberMe]\nEnable=False\nData=c2VjcmV0\n"));
        assert!(!remember_me("[RememberMe]\nEnable=True\nData=\n"));
        // The token in another section isn't the remembered sign-in.
        assert!(!remember_me("[RememberMe]\nEnable=True\n[Other]\nData=c2VjcmV0\n"));
    }
}
