// Steam: its games (appmanifest files in each library folder) and their play time, its signed-in account, a game's
// pending update, and keeping Steam out of Lamplit's way. The PS button must not pull up Steam or Big Picture, Big Picture never stays
// open, and Steam's window doesn't sit over Lamplit once a game is done. devtools.rs changes Steam's settings.

pub mod devtools;
pub mod settings;
mod vdf;

use super::names::clean_name;
use super::{Account, Store, read};
use crate::error::{Error, Result};
use crate::files::{folder_key, inside, on_a_drive, read_text};
use crate::library::{Game, Launch};
use crate::win::region;
use crate::win::window::{self, HWND};
use std::collections::HashMap;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::time::Duration;
use winreg::RegKey;
use winreg::enums::HKEY_CURRENT_USER;

pub const START_ARGS: &str = "-silent";
/// `-cef-enable-debugging` opens the DevTools port devtools.rs needs.
pub const START_ARGS_DEVTOOLS: &str = "-silent -cef-enable-debugging";
pub const WINDOW: &str = "steam://open/main";

/// Steamworks Common Redistributables: Steam installs it next to the games, but it is none.
const REDISTRIBUTABLES: u32 = 228_980;

// Bits of an appmanifest's StateFlags (Steam's EAppState).
const UPDATE_REQUIRED: u64 = 1 << 1;
const FULLY_INSTALLED: u64 = 1 << 2;
const UPDATE_RUNNING: u64 = 1 << 8;
const UPDATE_STARTED: u64 = 1 << 10;
const VALIDATING: u64 = 1 << 17;
const PREALLOCATING: u64 = 1 << 19;
const DOWNLOADING: u64 = 1 << 20;
const STAGING: u64 = 1 << 21;
const COMMITTING: u64 = 1 << 22;
/// Steam is working on the game's files, and starts it only once that is done.
const BUSY: u64 = UPDATE_RUNNING | UPDATE_STARTED | VALIDATING | PREALLOCATING | DOWNLOADING | STAGING | COMMITTING;

pub fn path() -> Option<PathBuf> {
    read_path().ok().flatten()
}

fn read_path() -> Result<Option<PathBuf>> {
    let Some(key) = read::optional(RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Software\Valve\Steam"))? else {
        return Ok(None);
    };
    let path: Option<String> = read::optional(key.get_value("SteamPath"))?;
    Ok(path.map(|p| PathBuf::from(p.replace('/', "\\"))))
}

pub fn exe() -> Option<PathBuf> {
    path().map(|p| p.join("steam.exe"))
}

pub fn running() -> bool {
    !super::pids_named(&["steam.exe"]).is_empty()
}

/// The country whose Steam store art and name lookups ask: the player's Windows region.
pub fn store_country() -> String {
    country(&region::code())
}

/// Steam takes a two-letter country code; a region wider than a country (Latin America is "419") gets the US store.
fn country(region: &str) -> String {
    if region.len() == 2 && region.bytes().all(|b| b.is_ascii_alphabetic()) {
        region.to_ascii_uppercase()
    } else {
        "US".into()
    }
}

pub fn games() -> Result<Vec<Game>> {
    let Some(root) = read_path()? else { return Ok(Vec::new()) };
    games_in(&root)
}

fn games_in(root: &Path) -> Result<Vec<Game>> {
    let mut libs = vec![root.to_path_buf()];
    if let Some(text) = read::text(&root.join(r"steamapps\libraryfolders.vdf"))? {
        let vdf = vdf::parse(&text);
        if !text.is_empty() && !matches!(vdf.get("libraryfolders"), Some(vdf::Vdf::Map(_))) {
            return Err(Error::Internal("Steam libraryfolders.vdf has no libraryfolders map".into()));
        }
        for (_, lib) in vdf.get("libraryfolders").map(vdf::Vdf::entries).unwrap_or_default() {
            if let Some(p) = lib.str("path").map(PathBuf::from)
                && on_a_drive(&p)
                && !libs.iter().any(|l| folder_key(l) == folder_key(&p))
            {
                libs.push(p);
            }
        }
    }
    let minutes = play_minutes(root);
    let mut out = Vec::new();
    for lib in libs {
        for entry in read::entries(&lib.join("steamapps"))? {
            let fname = entry.file_name().to_string_lossy().into_owned();
            if !fname.starts_with("appmanifest_") || !fname.ends_with(".acf") {
                continue;
            }
            let Some(text) = read::text(&entry.path())? else { continue };
            if let Some(mut game) = installed_game(&lib, &text) {
                game.store_minutes = game.steam_appid.and_then(|a| minutes.get(&a)).copied().unwrap_or(0);
                out.push(game);
            } else {
                log::info!(
                    "discovery steam: {} skipped, it has no installed game Lamplit can read",
                    entry.path().display()
                );
            }
        }
    }
    Ok(out)
}

/// Minutes played per app, as Steam counts them for the account that signed in last: `Playtime` in that account's
/// localconfig.vdf. Steam's count includes play that Lamplit didn't see, from Steam's own library or before
/// Lamplit was installed.
fn play_minutes(root: &Path) -> HashMap<u32, u64> {
    let Some(text) = read::detail_text(&root.join(r"config\loginusers.vdf")) else { return HashMap::new() };
    let Some(account) = last_account(&text) else {
        log::info!("discovery steam: loginusers.vdf has no recent account; play minutes unavailable");
        return HashMap::new();
    };
    read::detail_text(&root.join(format!(r"userdata\{account}\config\localconfig.vdf")))
        .map(|text| playtimes(&text))
        .unwrap_or_default()
}

/// The account that signed in last, as its folder in userdata is named: the account id, which is the low 32 bits of
/// the SteamID64 that loginusers.vdf lists it by. Older Steam marks that account `MostRecent`; newer Steam (as on
/// 2026-10-26) only gives each account the `timestamp` of its last sign-in.
fn last_account(loginusers: &str) -> Option<u32> {
    let users = vdf::parse(loginusers);
    let last = |u: &vdf::Vdf| Some((u.str("MostRecent") == Some("1"), u.str("Timestamp")?.parse::<u64>().ok()?));
    let (_, steam_id) = users.get("users")?.entries().iter().filter_map(|(id, u)| Some((last(u)?, id))).max()?;
    steam_id.parse::<u64>().ok().map(|id| id as u32)
}

/// `Playtime` (minutes) of each app in a localconfig.vdf.
fn playtimes(localconfig: &str) -> HashMap<u32, u64> {
    let vdf = vdf::parse(localconfig);
    let path = ["UserLocalConfigStore", "Software", "Valve", "Steam", "apps"];
    let Some(apps) = path.iter().try_fold(&vdf, |v, key| v.get(key)) else {
        log::info!("discovery steam: localconfig.vdf has no apps; play minutes unavailable");
        return HashMap::new();
    };
    apps.entries()
        .iter()
        .filter_map(|(appid, app)| Some((appid.parse().ok()?, app.str("Playtime")?.parse().ok()?)))
        .collect()
}

/// The game an appmanifest in the library `lib` describes, when its folder is there.
fn installed_game(lib: &Path, appmanifest: &str) -> Option<Game> {
    let vdf = vdf::parse(appmanifest);
    let app = vdf.get("AppState")?;
    let appid = app.str("appid")?.parse::<u32>().ok()?;
    let (name, installdir) = (app.str("name")?, app.str("installdir")?);
    if appid == REDISTRIBUTABLES || name.contains("Redistributable") {
        return None;
    }
    // Every account on the PC can write Steam's files, and an installdir that is a full path or a network share
    // would lead Lamplit there.
    let Some(dir) = inside(&lib.join(r"steamapps\common"), installdir) else {
        log::info!("discovery steam: {name} skipped, its folder {installdir} isn't inside {}", lib.display());
        return None;
    };
    if !dir.is_dir() {
        log::info!("discovery steam: {name} skipped, {} is missing", dir.display());
        return None;
    }
    let mut g = Game::new(
        format!("steam:{appid}"),
        clean_name(name),
        Some(Store::Steam),
        dir,
        Launch::Uri(format!("steam://rungameid/{appid}")),
    );
    g.steam_appid = Some(appid);
    g.last_played = app.str("LastPlayed").and_then(|s| s.parse().ok()).unwrap_or(0);
    g.note = Update::of(app).note();
    Some(g)
}

/// Running: `ActiveProcess\ActiveUser` is the signed-in account (0 while the sign-in window shows); it only counts
/// when `ActiveProcess\pid` is the Steam that runs now, since Steam leaves both behind when it exits. Not running:
/// a remembered account (`AutoLoginUser` plus `RememberPassword` in loginusers.vdf) signs in by itself.
pub fn account(pid: Option<u32>) -> Account {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Some(pid) = pid {
        let active = hkcu.open_subkey(r"Software\Valve\Steam\ActiveProcess");
        let value = |name: &str| active.as_ref().ok().and_then(|k| k.get_value::<u32, _>(name).ok()).unwrap_or(0);
        return if value("pid") == pid && value("ActiveUser") != 0 { Account::SignedIn } else { Account::SignedOut };
    }
    let auto_user: String =
        hkcu.open_subkey(r"Software\Valve\Steam").and_then(|k| k.get_value("AutoLoginUser")).unwrap_or_default();
    let loginusers = path().and_then(|p| read_text(&p.join(r"config\loginusers.vdf")));
    if loginusers.is_some_and(|text| remembers(&text, &auto_user)) { Account::Remembered } else { Account::SignedOut }
}

/// Whether loginusers.vdf keeps `user`'s password, so Steam signs them in when it starts.
fn remembers(loginusers: &str, user: &str) -> bool {
    !user.is_empty()
        && vdf::parse(loginusers).get("users").is_some_and(|users| {
            users.entries().iter().any(|(_, u)| {
                u.str("AccountName").is_some_and(|n| n.eq_ignore_ascii_case(user))
                    && u.str("RememberPassword") == Some("1")
            })
        })
}

/// A Steam game's install and update state, from its appmanifest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Update {
    /// Steam has to download the game, or an update to it, before it can start.
    pub pending: bool,
    /// Steam is doing that now.
    pub downloading: bool,
    pub to_download: u64,
    pub downloaded: u64,
    /// The first install isn't finished.
    pub installing: bool,
}

impl Update {
    fn of(app: &vdf::Vdf) -> Self {
        let num = |k: &str| app.str(k).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        let flags = num("StateFlags");
        let installing = flags & FULLY_INSTALLED == 0;
        Update {
            pending: installing || flags & UPDATE_REQUIRED != 0,
            downloading: flags & BUSY != 0,
            to_download: num("BytesToDownload"),
            downloaded: num("BytesDownloaded"),
            installing,
        }
    }

    /// What the game's tile says meanwhile.
    fn note(self) -> Option<&'static str> {
        if self.installing {
            Some("Installing")
        } else if self.pending {
            Some("Update pending")
        } else {
            None
        }
    }
}

pub fn update(game_dir: &Path, appid: u32) -> Option<Update> {
    // <library>\steamapps\common\<game> → <library>\steamapps\appmanifest_<appid>.acf
    let steamapps = game_dir.parent()?.parent()?;
    let text = read_text(&steamapps.join(format!("appmanifest_{appid}.acf")))?;
    Some(Update::of(vdf::parse(&text).get("AppState")?))
}

/// Visible top-level windows of Steam's processes with this exact title. Titles first: the process list (a handle to
/// every process) is only read when a window has the title, which keeps the Big Picture watch cheap.
fn windows_titled(title: &str) -> Vec<HWND> {
    let mut found = Vec::new();
    window::for_each_window(|w| {
        if window::is_visible(w) && window::title(w) == title {
            found.push(w);
        }
        ControlFlow::Continue(())
    });
    if found.is_empty() {
        return found;
    }
    // Steam's own processes: the client and its browser.
    let pids = super::pids_named(&["steam.exe", "steamwebhelper.exe"]);
    found.retain(|&w| pids.contains(&window::process_id(w)));
    found
}

/// Minimises Steam's main window when Lamplit takes the screen back after a Steam game.
pub fn minimize_main_window() {
    for w in windows_titled("Steam") {
        if !window::is_minimized(w) {
            window::minimize(w);
            log::info!("steam: minimised its main window");
        }
    }
}

/// Watches for Big Picture and closes it: Lamplit is the big-screen interface.
pub fn guard_big_picture(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let _changes = crate::system::restore::CHANGES.lock();
            if !crate::prefs::get(&app).steam_guide {
                continue;
            }
            if !windows_titled("Steam Big Picture Mode").is_empty() {
                log::info!("steam: Big Picture opened; closing it");
                let close = Launch::Uri("steam://close/bigpicture".into());
                if let Err(e) = crate::launch::shell_open(&close, None) {
                    log::warn!("steam: couldn't close Big Picture: {e}");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(flags: u64) -> Update {
        let text = format!(
            r#""AppState" {{ "appid" "70" "StateFlags" "{flags}" "BytesToDownload" "2000" "BytesDownloaded" "500" }}"#
        );
        Update::of(vdf::parse(&text).get("AppState").unwrap())
    }

    #[test]
    fn reads_the_state_of_a_game() {
        let ready = manifest(FULLY_INSTALLED);
        assert!(!ready.pending && !ready.downloading);
        assert_eq!(ready.note(), None);

        let queued = manifest(FULLY_INSTALLED | UPDATE_REQUIRED);
        assert!(queued.pending && !queued.downloading);
        assert_eq!(queued.note(), Some("Update pending"));
        assert_eq!((queued.to_download, queued.downloaded), (2000, 500));

        // 512 is UpdatePaused: the update waits, so Steam isn't busy with the game.
        let paused = manifest(FULLY_INSTALLED | UPDATE_REQUIRED | 512);
        assert!(paused.pending && !paused.downloading);

        for busy in [UPDATE_RUNNING | DOWNLOADING, VALIDATING, PREALLOCATING, STAGING, COMMITTING] {
            assert!(manifest(FULLY_INSTALLED | UPDATE_REQUIRED | busy).downloading, "{busy}");
        }

        let first_install = manifest(UPDATE_REQUIRED | UPDATE_STARTED);
        assert!(first_install.pending && first_install.downloading);
        assert_eq!(first_install.note(), Some("Installing"));
    }

    #[test]
    fn keeps_a_games_folder_inside_its_library() {
        let lib = std::env::temp_dir().join(format!("lamplit-test-steam-{}", std::process::id()));
        std::fs::create_dir_all(lib.join(r"steamapps\common\Game")).unwrap();
        let manifest =
            |installdir: &str| format!(r#""AppState" {{ "appid" "70" "name" "Game" "installdir" "{installdir}" }}"#);
        let found = installed_game(&lib, &manifest("Game")).map(|g| g.dir);
        assert_eq!(found, Some(lib.join(r"steamapps\common\Game")));
        // Written as Steam's files hold them, with each backslash doubled.
        for elsewhere in [r"\\\\nas\\games", r"C:\\Windows", r"..\\..\\Game"] {
            assert!(installed_game(&lib, &manifest(elsewhere)).is_none(), "{elsewhere}");
        }
        std::fs::remove_dir_all(&lib).unwrap();
    }

    #[test]
    fn bad_manifests_and_optional_details_do_not_hide_steam_games() {
        use std::fs;
        let lib = std::env::temp_dir().join(format!("lamplit-test-steam-partial-{}", std::process::id()));
        fs::create_dir_all(lib.join(r"steamapps\common\Game")).unwrap();
        fs::write(
            lib.join(r"steamapps\appmanifest_70.acf"),
            r#""AppState" { "appid" "70" "name" "Game" "installdir" "Game" }"#,
        )
        .unwrap();
        let baseline = games_in(&lib).unwrap();
        assert_eq!(baseline.len(), 1);
        fs::write(lib.join(r"steamapps\appmanifest_71.acf"), r#""AppState""#).unwrap();
        fs::write(lib.join(r"steamapps\appmanifest_72.acf"), r#""AppState" { "appid" "72" }"#).unwrap();
        assert!(games_in(&lib).unwrap() == baseline);

        let loginusers = lib.join(r"config\loginusers.vdf");
        fs::create_dir_all(&loginusers).unwrap();
        assert!(games_in(&lib).unwrap() == baseline, "an unreadable account file only omits play time");
        fs::remove_dir(&loginusers).unwrap();
        fs::write(&loginusers, r#""users" { "76561197960265729" { "Timestamp" "1" } }"#).unwrap();
        let localconfig = lib.join(r"userdata\1\config\localconfig.vdf");
        fs::create_dir_all(&localconfig).unwrap();
        assert!(games_in(&lib).unwrap() == baseline, "an unreadable play-time file only omits play time");
        fs::remove_dir(&localconfig).unwrap();
        fs::write(&localconfig, r#""nested" { "#.repeat(32)).unwrap();
        assert!(games_in(&lib).unwrap() == baseline, "deep or cut-off optional VDF cannot hide a game");
        fs::write(
            &localconfig,
            r#""UserLocalConfigStore" { "Software" { "Valve" { "Steam" { "apps" { "70" { "Playtime" "12" } } } } } }"#,
        )
        .unwrap();
        assert_eq!(games_in(&lib).unwrap()[0].store_minutes, 12);

        fs::create_dir(lib.join(r"steamapps\appmanifest_73.acf")).unwrap();
        assert!(games_in(&lib).is_err(), "an I/O error on a per-game manifest fails the store");
        fs::remove_dir_all(lib).unwrap();
    }

    #[test]
    fn library_lists_need_a_map_but_no_new_fields() {
        use std::fs;
        let root = std::env::temp_dir().join(format!("lamplit-test-steam-libraries-{}", std::process::id()));
        fs::create_dir_all(root.join("steamapps")).unwrap();
        let list = root.join(r"steamapps\libraryfolders.vdf");
        assert!(games_in(&root).unwrap().is_empty());
        for text in ["", r#""libraryfolders" { "0" { "label" "No path" } }"#] {
            fs::write(&list, text).unwrap();
            assert!(games_in(&root).unwrap().is_empty());
        }
        let extra = root.join("Extra");
        fs::create_dir_all(extra.join(r"steamapps\common\Game")).unwrap();
        fs::write(
            extra.join(r"steamapps\appmanifest_70.acf"),
            r#""AppState" { "appid" "70" "name" "Game" "installdir" "Game" }"#,
        )
        .unwrap();
        let escaped = extra.to_string_lossy().replace('\\', "\\\\");
        fs::write(&list, format!(r#""libraryfolders" {{ "named" {{ "path" "{escaped}" }} }}"#)).unwrap();
        let games = games_in(&root).unwrap();
        assert_eq!(games.len(), 1, "library keys need not be numeric");
        assert_eq!(games[0].dir, extra.join(r"steamapps\common\Game"));
        for text in [r#""libraryfolders""#, r#""libraryfolders" "not a map""#] {
            fs::write(&list, text).unwrap();
            assert!(games_in(&root).is_err());
        }
        fs::remove_file(&list).unwrap();
        fs::create_dir(&list).unwrap();
        assert!(games_in(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finds_a_remembered_account() {
        let loginusers = r#"
"users"
{
	"76561190000000001"
	{
		"AccountName"		"player_one"
		"PersonaName"		"Player One"
		"RememberPassword"		"1"
	}
	"76561190000000002"
	{
		"AccountName"		"guest"
		"RememberPassword"		"0"
	}
}
"#;
        assert!(remembers(loginusers, "Player_One"));
        assert!(!remembers(loginusers, "guest"));
        assert!(!remembers(loginusers, "nobody"));
        // No account set to sign in by itself.
        assert!(!remembers(loginusers, ""));
    }

    #[test]
    fn reads_the_play_time_of_the_last_account() {
        let older_steam = r#"
"users"
{
	"76561197960265729"
	{
		"AccountName"		"older"
		"MostRecent"		"0"
		"Timestamp"		"1792900000"
	}
	"76561198000000005"
	{
		"AccountName"		"player_one"
		"MostRecent"		"1"
		"Timestamp"		"1700000000"
	}
}
"#;
        // 76561198000000005 - 76561197960265728, the base of every individual account's SteamID64.
        assert_eq!(last_account(older_steam), Some(39_734_277));
        let newer_steam = r#"
"users"
{
	"76561197960265729"
	{
		"AccountName"		"older"
		"timestamp"		"1700000000"
	}
	"76561198000000005"
	{
		"AccountName"		"player_one"
		"AutoLogin"		"1"
		"timestamp"		"1792920366"
	}
}
"#;
        assert_eq!(last_account(newer_steam), Some(39_734_277));
        // Nothing says when it signed in.
        assert_eq!(last_account(r#""users" { "76561198000000005" { "AccountName" "x" } }"#), None);
        let localconfig = r#"
"UserLocalConfigStore"
{
	"Software"
	{
		"Valve"
		{
			"Steam"
			{
				"apps"
				{
					"70"
					{
						"LastPlayed"		"1760000000"
						"Playtime2wks"		"95"
						"Playtime"		"754"
					}
					"220"
					{
						"cloud"
						{
							"last_sync_state"		"synchronized"
						}
					}
					"not-an-app"
					{
						"Playtime"		"3"
					}
				}
			}
		}
	}
}
"#;
        assert_eq!(playtimes(localconfig), HashMap::from([(70, 754)]));
        assert!(playtimes(r#""UserLocalConfigStore" { "friends" { } }"#).is_empty());
    }

    #[test]
    fn asks_the_store_of_the_players_country() {
        assert_eq!(country("DE"), "DE");
        assert_eq!(country("nz"), "NZ");
        assert_eq!(country("419"), "US");
        assert_eq!(country(""), "US");
        // Windows always has a region set.
        assert!(!region::code().is_empty());
    }
}
