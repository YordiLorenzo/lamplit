// Steam: its games (appmanifest files in each library folder), its signed-in account, a game's pending update, and
// keeping Steam out of Lamplit's way. The PS button must not pull up Steam or Big Picture, Big Picture never stays
// open, and Steam's window doesn't sit over Lamplit once a game is done. devtools.rs changes Steam's settings.

pub mod devtools;
pub mod settings;
mod vdf;

use super::names::clean_name;
use super::{Account, Store};
use crate::files::{folder_key, inside, on_a_drive, read_text};
use crate::library::{Game, Launch};
use crate::win::region;
use crate::win::window::{self, HWND};
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
    let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Software\Valve\Steam").ok()?;
    let path: String = key.get_value("SteamPath").ok()?;
    Some(PathBuf::from(path.replace('/', "\\")))
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

pub fn games() -> Vec<Game> {
    let Some(root) = path() else { return Vec::new() };
    let mut libs = vec![root.clone()];
    if let Some(text) = read_text(&root.join(r"steamapps\libraryfolders.vdf")) {
        let vdf = vdf::parse(&text);
        for (_, lib) in vdf.get("libraryfolders").map(vdf::Vdf::entries).unwrap_or_default() {
            if let Some(p) = lib.str("path").map(PathBuf::from)
                && on_a_drive(&p)
                && !libs.iter().any(|l| folder_key(l) == folder_key(&p))
            {
                libs.push(p);
            }
        }
    }
    let mut out = Vec::new();
    for lib in libs {
        let Ok(rd) = std::fs::read_dir(lib.join("steamapps")) else { continue };
        for entry in rd.flatten() {
            let fname = entry.file_name().to_string_lossy().into_owned();
            if fname.starts_with("appmanifest_")
                && fname.ends_with(".acf")
                && let Some(game) = read_text(&entry.path()).and_then(|text| installed_game(&lib, &text))
            {
                out.push(game);
            }
        }
    }
    out
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
pub fn guard_big_picture() {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(2));
            if !windows_titled("Steam Big Picture Mode").is_empty() {
                log::info!("steam: Big Picture opened; closing it");
                let close = Launch::Uri("steam://close/bigpicture".into());
                if let Err(e) = crate::launch::shell_open(&close, None) {
                    log::warn!("steam: couldn't close Big Picture: {e}");
                }
                std::thread::sleep(Duration::from_secs(3));
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
    fn asks_the_store_of_the_players_country() {
        assert_eq!(country("DE"), "DE");
        assert_eq!(country("nz"), "NZ");
        assert_eq!(country("419"), "US");
        assert_eq!(country(""), "US");
        // Windows always has a region set.
        assert!(!region::code().is_empty());
    }
}
