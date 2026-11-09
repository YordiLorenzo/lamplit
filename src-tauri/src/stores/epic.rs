// Both Epic launchers: the legacy .item manifests and the Preview's installations.jsonl journal.

use super::names::clean_name;
use super::{Store, read};
use crate::error::Result;
use crate::files::{file_name, local_app_data, on_a_drive, read_text};
use crate::library::{Game, Launch};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use winreg::RegKey;
use winreg::enums::HKEY_CLASSES_ROOT;

const PREVIEW_DATA: &str = "com.epicgames.eglv2";

/// Use the handler Windows will open for a game, including a Preview installed outside its default folder.
pub fn exe() -> Option<PathBuf> {
    let command: Option<String> = RegKey::predef(HKEY_CLASSES_ROOT)
        .open_subkey(r"com.epicgames.launcher\shell\open\command")
        .and_then(|k| k.get_value(""))
        .ok();
    command
        .as_deref()
        .and_then(exe_from_command)
        .filter(|p| p.is_file())
        .or_else(|| {
            let preview = local_app_data().join(r"Epic Games\Launcher\EpicGamesLauncher.exe");
            preview.is_file().then_some(preview)
        })
        .or_else(|| {
            let x86 = std::env::var_os("ProgramFiles(x86)")?;
            Some(Path::new(&x86).join(r"Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe"))
        })
}

/// Only the legacy Win32 bootstrapper needs its Win64 sibling; the Preview runs from the registered exe itself.
fn exe_from_command(command: &str) -> Option<PathBuf> {
    let command = command.trim();
    let registered = if let Some(quoted) = command.strip_prefix('"') {
        quoted.split_once('"')?.0
    } else {
        let end = command.to_ascii_lowercase().find(".exe")? + 4;
        let (exe, args) = command.split_at(end);
        if !args.is_empty() && !args.starts_with(char::is_whitespace) {
            return None;
        }
        exe
    };
    let registered = Path::new(registered);
    if !on_a_drive(registered) || !registered.file_name()?.eq_ignore_ascii_case("EpicGamesLauncher.exe") {
        return None;
    }
    if legacy_exe(registered) {
        Some(registered.parent()?.parent()?.join(r"Win64\EpicGamesLauncher.exe"))
    } else {
        Some(registered.to_path_buf())
    }
}

fn legacy_exe(exe: &Path) -> bool {
    let path = exe.to_string_lossy().replace('/', "\\").to_ascii_lowercase();
    ["win32", "win64"].iter().any(|arch| path.ends_with(&format!(r"\portal\binaries\{arch}\epicgameslauncher.exe")))
}

pub fn games() -> Result<Vec<Game>> {
    let manifests =
        std::env::var_os("ProgramData").map(|dir| Path::new(&dir).join(r"Epic\EpicGamesLauncher\Data\Manifests"));
    games_in(manifests.as_deref(), &local_app_data().join(PREVIEW_DATA), Store::Epic.exe().as_deref())
}

fn games_in(manifests: Option<&Path>, preview: &Path, launcher: Option<&Path>) -> Result<Vec<Game>> {
    // Migration or rollback can leave records behind. Only the active launcher can start the games it knows.
    if launcher.is_some_and(legacy_exe) {
        return manifests.map_or_else(|| Ok(Vec::new()), legacy_games);
    }
    let mut out = preview_games(preview)?;
    if launcher.is_some() {
        return Ok(out);
    }
    // With no launcher installed, still list its games so Play can explain which store app is missing.
    let mut ids: HashSet<String> = out.iter().map(|game| game.id.clone()).collect();
    if let Some(manifests) = manifests {
        // A migrated game keeps its app id, and therefore its favourites and play time in Lamplit.
        out.extend(legacy_games(manifests)?.into_iter().filter(|game| ids.insert(game.id.clone())));
    }
    Ok(out)
}

fn legacy_games(manifests: &Path) -> Result<Vec<Game>> {
    let mut out = Vec::new();
    for entry in read::entries(manifests)? {
        if entry.path().extension().is_none_or(|e| !e.eq_ignore_ascii_case("item")) {
            continue;
        }
        let Some(text) = read::text(&entry.path())? else { continue };
        let v: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("discovery epic: {} skipped: {e}", entry.path().display());
                continue;
            }
        };
        if !is_game(&v) {
            log::info!("discovery epic: {} skipped, it has no launchable game", entry.path().display());
            continue;
        }
        let s = |k: &str| v[k].as_str().unwrap_or_default().to_string();
        let dir = PathBuf::from(s("InstallLocation"));
        if !on_a_drive(&dir) || !read::is_dir(&dir)? {
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
    Ok(out)
}

fn preview_games(data: &Path) -> Result<Vec<Game>> {
    let Some(journal) = read::text(&data.join("installations.jsonl"))? else { return Ok(Vec::new()) };
    let catalog = read_text(&data.join(r"cache\prod\catalog-cache.json"))
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_default();
    Ok(installations(&journal).values().filter_map(|record| preview_game(record, &catalog)).collect())
}

/// Entries are full snapshots, not patches. Replay before filtering, or an unfinished update can revive an old
/// completed install. A partial last line can be seen while Epic appends to the journal.
fn installations(journal: &str) -> BTreeMap<String, Value> {
    let mut records = BTreeMap::new();
    for line in journal.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            log::warn!("discovery epic: skipped an unreadable installations.jsonl record");
            continue;
        };
        let Some(id) = record["installationId"].as_str().filter(|id| !id.is_empty()) else { continue };
        if record["deleted"].as_bool() == Some(true) {
            records.remove(id);
        } else {
            records.insert(id.to_string(), record);
        }
    }
    records
}

fn preview_game(record: &Value, catalog: &Value) -> Option<Game> {
    let s = |key: &str| record[key].as_str().unwrap_or_default();
    let (app, ns, item) = (s("artifactId"), s("namespace"), s("itemId"));
    if record["complete"].as_bool() != Some(true)
        || !s("platform").eq_ignore_ascii_case("Windows")
        || !s("parentInstallationId").is_empty()
        || app.starts_with("UE_")
        || s("launchExecutable").is_empty()
        || [app, ns, item].contains(&"")
    {
        return None;
    }
    let dir = PathBuf::from(s("dir"));
    if !on_a_drive(&dir) || !dir.is_dir() {
        return None;
    }
    // The journal has no display name. Epic's local catalogue supplies it; without that cache, use the folder.
    let name = catalog["items"][item]["item"]["title"]
        .as_str()
        .filter(|title| !title.trim().is_empty())
        .map_or_else(|| file_name(&dir), str::to_string);
    Some(Game::new(
        format!("epic:{app}"),
        clean_name(&name),
        Some(Store::Epic),
        dir,
        Launch::Uri(format!("com.epicgames.launcher://apps/{ns}%3A{item}%3A{app}?action=launch&silent=true")),
    ))
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

pub fn remembered(exe: &Path) -> bool {
    remembered_in(exe, &local_app_data())
}

fn remembered_in(exe: &Path, local: &Path) -> bool {
    if !legacy_exe(exe) {
        // The account cache records past logins too. Check only the encrypted token file's metadata, never its
        // contents, and never let a leftover legacy RememberMe token stand in for the Preview's sign-in.
        return std::fs::metadata(local.join(PREVIEW_DATA).join(r"auth\access-token-prod.dpapi"))
            .is_ok_and(|meta| meta.is_file() && meta.len() > 0);
    }
    ["Windows", "WindowsEditor"].iter().any(|flavour| {
        let ini = local.join(format!(r"EpicGamesLauncher\Saved\Config\{flavour}\GameUserSettings.ini"));
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
    use std::fs;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lamplit-test-epic-{name}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    // The Preview's installation shape, with invented ids and a test-owned install folder. Sources and the
    // Windows checks still needed are in docs/epic-launcher.md.
    fn preview_record(dir: &Path) -> Value {
        json!({
            "installationId": "0123456789ABCDEF0123456789ABCDEF",
            "complete": true,
            "dir": dir,
            "platform": "Windows",
            "namespace": "sample-namespace",
            "itemId": "sample-item",
            "artifactId": "Fennel",
            "version": "1.0",
            "launchCommand": "",
            "launchExecutable": "Game.exe"
        })
    }

    #[test]
    fn unreadable_manifests_are_not_an_empty_library() {
        let dir = std::env::temp_dir().join(format!("lamplit-test-epic-read-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(legacy_games(&dir).unwrap().is_empty());
        let manifest = dir.join("game.item");
        std::fs::write(&manifest, "{").unwrap();
        assert!(legacy_games(&dir).unwrap().is_empty());
        std::fs::write(&manifest, "{}").unwrap();
        assert!(legacy_games(&dir).unwrap().is_empty());
        std::fs::remove_file(&manifest).unwrap();
        std::fs::create_dir(&manifest).unwrap();
        assert!(legacy_games(&dir).is_err());
        assert!(legacy_games(&dir.join("missing")).unwrap().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_damaged_manifest_does_not_hide_other_epic_games() {
        let dir = std::env::temp_dir().join(format!("lamplit-test-epic-partial-{}", std::process::id()));
        let manifests = dir.join("Manifests");
        let game = dir.join("Fennel");
        std::fs::create_dir_all(&manifests).unwrap();
        std::fs::create_dir_all(&game).unwrap();
        let good = json!({"AppName": "Fennel", "DisplayName": "Fennel", "InstallLocation": game,
            "LaunchExecutable": "Game.exe"});
        std::fs::write(manifests.join("good.item"), serde_json::to_vec(&good).unwrap()).unwrap();
        let baseline = legacy_games(&manifests).unwrap();
        assert_eq!(baseline.len(), 1);
        std::fs::write(manifests.join("damaged.item"), "{").unwrap();
        std::fs::write(manifests.join("incomplete.item"), "{}").unwrap();
        let with_damage = legacy_games(&manifests).unwrap();
        assert!(with_damage == baseline, "a bad sibling leaves the one readable game unchanged");
        std::fs::create_dir(manifests.join("unreadable.item")).unwrap();
        assert!(legacy_games(&manifests).is_err(), "an I/O error still fails the store");
        std::fs::remove_dir_all(dir).unwrap();
    }

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
    fn keeps_the_previews_registered_exe_including_custom_folders() {
        for command in [
            r#""C:\Users\Player\AppData\Local\Epic Games\Launcher\EpicGamesLauncher.exe" "%1""#,
            r#"  "D:\My launchers\EpicGamesLauncher.exe" "%1"  "#,
            r"D:\My launchers\EpicGamesLauncher.exe %1",
            r"D:\My launchers\EpicGamesLauncher.exe",
        ] {
            let exe = exe_from_command(command).unwrap();
            assert!(!legacy_exe(&exe));
            assert!(!exe.to_string_lossy().contains("Win64"));
        }
        assert_eq!(
            exe_from_command(r#""D:\My launchers\EpicGamesLauncher.exe" "%1""#),
            Some(PathBuf::from(r"D:\My launchers\EpicGamesLauncher.exe"))
        );
        for command in [
            "",
            r"EpicGamesLauncher.exe %1",
            r#""D:\EpicGamesLauncher.exe"#,
            r"D:\other.exe %1",
            r"D:\EpicGamesLauncher.exe.bad %1",
            r#""\\server\share\EpicGamesLauncher.exe" "%1""#,
        ] {
            assert!(exe_from_command(command).is_none(), "{command}");
        }
    }

    #[test]
    fn replays_updates_deletions_and_reinstalls_before_filtering() {
        let journal = [
            json!({ "version": 1, "entries": 3 }),
            json!({ "installationId": "update", "complete": true, "dir": "old" }),
            json!({ "installationId": "update", "complete": false, "dir": "new" }),
            json!({ "installationId": "removed", "complete": true }),
            json!({ "installationId": "removed", "deleted": true }),
            json!({ "installationId": "reinstalled", "deleted": true }),
            json!({ "installationId": "reinstalled", "complete": true }),
            json!({ "installationId": "", "complete": true }),
        ]
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
        let records = installations(&format!("{journal}\n\n{{\"installationId\":\"torn"));
        assert_eq!(records.len(), 2);
        assert_eq!(records["update"]["complete"], false);
        assert_eq!(records["update"]["dir"], "new");
        assert_eq!(records["reinstalled"]["complete"], true);
        assert!(!records.contains_key("removed"));
    }

    #[test]
    fn reads_both_launchers_without_duplicating_a_migrated_game() {
        let root = test_dir("discovery");
        let (preview, manifests, game_dir, legacy_dir) =
            (root.join("preview"), root.join("manifests"), root.join("Fennel"), root.join("Legacy"));
        for dir in [&preview.join(r"cache\prod"), &manifests, &game_dir, &legacy_dir] {
            fs::create_dir_all(dir).unwrap();
        }
        let mut record = preview_record(&game_dir);
        record["complete"] = json!(false);
        let incomplete = record.to_string();
        record["complete"] = json!(true);
        fs::write(preview.join("installations.jsonl"), format!("{{\"version\":1}}\n{incomplete}\n{record}\n")).unwrap();
        fs::write(
            preview.join(r"cache\prod\catalog-cache.json"),
            json!({ "items": { "sample-item": { "item": { "title": "Fennel Game" } } } }).to_string(),
        )
        .unwrap();
        let legacy = |app: &str, dir: &Path| {
            json!({
                "AppName": app, "DisplayName": app, "InstallLocation": dir, "LaunchExecutable": "Game.exe",
                "CatalogNamespace": "sample-namespace", "CatalogItemId": "sample-item"
            })
        };
        fs::write(manifests.join("migrated.item"), legacy("Fennel", &game_dir).to_string()).unwrap();
        fs::write(manifests.join("legacy.item"), legacy("Legacy", &legacy_dir).to_string()).unwrap();
        fs::write(manifests.join("broken.item"), "{").unwrap();

        let games = games_in(Some(&manifests), &preview, None).unwrap();
        assert_eq!(games.len(), 2);
        let game = games.iter().find(|game| game.id == "epic:Fennel").unwrap();
        assert_eq!(game.name, "Fennel Game");
        assert_eq!(game.dir, game_dir);
        assert_eq!(game.store, Some(Store::Epic));
        assert!(matches!(
            &game.launch, Launch::Uri(uri)
                if uri == "com.epicgames.launcher://apps/sample-namespace%3Asample-item%3AFennel?action=launch&silent=true"
        ));
        assert!(games.iter().any(|game| game.id == "epic:Legacy"));
        assert_eq!(games_in(None, &preview, None).unwrap().len(), 1);
        assert_eq!(games_in(Some(&root.join("absent")), &preview, None).unwrap().len(), 1);
        assert_eq!(games_in(Some(&manifests), &root.join("absent"), None).unwrap().len(), 2);

        let preview_exe = Path::new(r"D:\Epic Preview\EpicGamesLauncher.exe");
        let legacy_exe = Path::new(r"D:\Epic\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe");
        assert_eq!(games_in(Some(&manifests), &preview, Some(preview_exe)).unwrap().len(), 1);
        let legacy_games = games_in(Some(&manifests), &preview, Some(legacy_exe)).unwrap();
        assert_eq!(legacy_games.len(), 2);
        assert_eq!(legacy_games.iter().find(|game| game.id == "epic:Fennel").unwrap().name, "Fennel");
        fs::write(
            preview.join("installations.jsonl"),
            format!("{record}\n{{\"installationId\":\"0123456789ABCDEF0123456789ABCDEF\",\"deleted\":true}}\n"),
        )
        .unwrap();
        assert!(games_in(Some(&manifests), &preview, Some(preview_exe)).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preview_skips_dlc_engines_unfinished_installs_and_missing_or_remote_folders() {
        let dir = test_dir("filters");
        let record = preview_record(&dir);
        let game = preview_game(&record, &Value::Null).unwrap();
        assert_eq!(game.name, clean_name(&file_name(&dir)));
        let invalid = [
            ("complete", json!(false)),
            ("complete", Value::Null),
            ("platform", json!("Linux")),
            ("parentInstallationId", json!("base-game")),
            ("artifactId", json!("UE_5.6")),
            ("launchExecutable", json!("")),
            ("artifactId", json!("")),
            ("namespace", json!("")),
            ("itemId", Value::Null),
            ("dir", json!(r"\\server\share\game")),
            ("dir", json!(r"relative\game")),
            ("dir", json!(dir.join("absent"))),
        ];
        for (key, value) in invalid {
            let mut bad = record.clone();
            bad[key] = value;
            assert!(preview_game(&bad, &Value::Null).is_none(), "{bad}");
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn saved_sign_in_belongs_to_the_selected_launcher() {
        let root = test_dir("accounts");
        let legacy = Path::new(r"D:\Epic\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe");
        let preview = Path::new(r"D:\Epic Preview\EpicGamesLauncher.exe");
        assert!(!remembered_in(legacy, &root));
        assert!(!remembered_in(preview, &root));
        let ini = root.join(r"EpicGamesLauncher\Saved\Config\Windows\GameUserSettings.ini");
        fs::create_dir_all(ini.parent().unwrap()).unwrap();
        fs::write(&ini, "[RememberMe]\nEnable=True\nData=test-fixture\n").unwrap();
        assert!(remembered_in(legacy, &root));
        assert!(!remembered_in(preview, &root));
        let data = root.join(PREVIEW_DATA);
        let accounts = data.join(r"cache\prod\account");
        fs::create_dir_all(&accounts).unwrap();
        fs::write(accounts.join("0123456789abcdef0123456789abcdef.dat"), "past account").unwrap();
        assert!(!remembered_in(preview, &root), "a past account is not a saved sign-in");
        let token = data.join(r"auth\access-token-prod.dpapi");
        fs::create_dir_all(token.parent().unwrap()).unwrap();
        fs::write(&token, "").unwrap();
        assert!(!remembered_in(preview, &root));
        fs::write(&token, "test-fixture").unwrap();
        assert!(remembered_in(preview, &root));
        fs::write(&ini, "[RememberMe]\nEnable=False\nData=test-fixture\n").unwrap();
        assert!(!remembered_in(legacy, &root), "a Preview token is not a legacy saved sign-in");
        fs::remove_file(&token).unwrap();
        fs::create_dir_all(&token).unwrap();
        assert!(!remembered_in(preview, &root));
        fs::remove_dir_all(root).unwrap();
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
