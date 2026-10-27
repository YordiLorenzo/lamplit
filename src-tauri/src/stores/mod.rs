// The store apps games come from. Each store's file knows where it keeps its games, whether it is installed, running
// and signed in, and what it needs to start; `Store` hands each question to the right file. loose.rs finds the games
// outside any store.

mod amazon;
mod battlenet;
mod ea;
mod epic;
mod gog;
mod installed;
mod itch;
pub mod loose;
mod names;
mod proto;
mod rockstar;
mod sqlite;
pub mod steam;
pub mod ubisoft;
mod xbox;
mod xml;

pub use installed::Installed;

use crate::files::{folder_key, subdirs};
use crate::library::{Game, Launch};
use crate::win;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use winreg::RegKey;
use winreg::enums::HKEY_LOCAL_MACHINE;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Store {
    Steam,
    Epic,
    Ea,
    Ubisoft,
    Rockstar,
    Battlenet,
    Gog,
    Amazon,
    Itch,
    Xbox,
}

/// Every store, in the order discovery reads them: a game two stores claim goes to the first.
pub const ALL: [Store; 10] = [
    Store::Steam,
    Store::Epic,
    Store::Ea,
    Store::Ubisoft,
    Store::Rockstar,
    Store::Battlenet,
    Store::Gog,
    Store::Amazon,
    Store::Itch,
    Store::Xbox,
];

impl Store {
    /// The id the UI uses (the serde name).
    pub fn key(self) -> &'static str {
        match self {
            Store::Steam => "steam",
            Store::Epic => "epic",
            Store::Ea => "ea",
            Store::Ubisoft => "ubisoft",
            Store::Rockstar => "rockstar",
            Store::Battlenet => "battlenet",
            Store::Gog => "gog",
            Store::Amazon => "amazon",
            Store::Itch => "itch",
            Store::Xbox => "xbox",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Store::Steam => "Steam",
            Store::Epic => "Epic Games Launcher",
            Store::Ea => "EA app",
            Store::Ubisoft => "Ubisoft Connect",
            Store::Rockstar => "Rockstar Games Launcher",
            Store::Battlenet => "Battle.net",
            Store::Gog => "GOG Galaxy",
            Store::Amazon => "Amazon Games",
            Store::Itch => "itch.io",
            Store::Xbox => "Xbox app",
        }
    }

    /// The games this store has installed.
    pub fn games(self, installed: &Installed) -> Vec<Game> {
        match self {
            Store::Steam => steam::games(),
            Store::Epic => epic::games(),
            Store::Ea => ea::games(&installed.drives, &installed.programs),
            Store::Ubisoft => ubisoft::games(),
            Store::Rockstar => rockstar::games(&installed.game_exes),
            Store::Battlenet => battlenet::games(),
            Store::Gog => gog::games(),
            Store::Amazon => amazon::games(),
            Store::Itch => itch::games(),
            Store::Xbox => xbox::games(&installed.drives),
        }
    }

    /// The launcher's own exe. Xbox games start without a launcher window, so it has none.
    pub fn exe(self) -> Option<PathBuf> {
        let path = match self {
            Store::Steam => steam::exe(),
            Store::Epic => epic::exe(),
            Store::Ea => ea::exe(),
            Store::Ubisoft => ubisoft::exe(),
            Store::Rockstar => rockstar::exe(),
            Store::Battlenet => battlenet::exe(),
            Store::Gog => gog::exe(),
            Store::Amazon => Some(amazon::exe()),
            Store::Itch => itch::exe(),
            Store::Xbox => None,
        };
        path.filter(|p| p.is_file())
    }

    /// The processes that mean the store app is up.
    fn processes(self, exe: &Path) -> Vec<PathBuf> {
        match self {
            Store::Ubisoft => ubisoft::processes(exe),
            _ => vec![exe.to_path_buf()],
        }
    }

    /// The arguments Lamplit starts the store app with; `steam_devtools`: Steam opens its DevTools port.
    pub fn start_args(self, steam_devtools: bool) -> Option<&'static str> {
        match self {
            Store::Steam if steam_devtools => Some(steam::START_ARGS_DEVTOOLS),
            Store::Steam => Some(steam::START_ARGS),
            _ => None,
        }
    }

    /// What brings the store app's window forward, for the player to sign in or deal with an update.
    pub fn window(self) -> Option<Launch> {
        match self {
            Store::Steam => Some(Launch::Uri(steam::WINDOW.into())),
            Store::Xbox => Some(Launch::Uri(xbox::WINDOW.into())),
            _ => self.exe().map(Launch::Exe),
        }
    }
}

/// What the store knows about its account. For every store but Steam this rests on what the store leaves on disk (a
/// saved sign-in, or Battle.net's log; see `status`), so Lamplit lets the player go ahead anyway.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[cfg_attr(test, derive(strum::VariantArray))]
#[serde(rename_all = "kebab-case")]
pub enum Account {
    SignedIn,
    /// Not running, but a saved sign-in will be used when it starts.
    Remembered,
    SignedOut,
    /// The store keeps nothing Lamplit can read; the launch itself will tell.
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub store: Store,
    pub name: &'static str,
    pub installed: bool,
    pub running: bool,
    pub account: Account,
}

/// One running process, as `Processes::list` gives it.
#[derive(Clone, Copy)]
pub struct Proc<'a> {
    pub pid: u32,
    pub name: &'a OsStr,
    /// None when Windows doesn't tell.
    pub exe: Option<&'a Path>,
    /// Seconds since 1970. With the id, it tells a process from a later one that got the same id.
    pub started: u64,
    /// The process that started it. It may have ended since and handed its id on to a later process.
    pub parent: Option<u32>,
}

/// The running processes and the exe each one runs from. To poll, keep one and `refresh` it: each process's exe is
/// then looked up once. `default()` is empty until the first `refresh`.
#[derive(Default)]
pub struct Processes {
    sys: System,
    /// The exes sysinfo leaves empty, by process id and start time (see `refresh`).
    exes: HashMap<(u32, u64), Option<PathBuf>>,
}

impl Processes {
    pub fn now() -> Self {
        let mut procs = Processes::default();
        procs.refresh();
        procs
    }

    pub fn refresh(&mut self) {
        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
        );
        // sysinfo reads an exe through a handle that may also read the process's memory. Windows refuses that for a
        // process with more rights than Lamplit (a store app or game run as administrator, or guarded by
        // anti-cheat), and sysinfo then gives an empty path. Windows still tells the path to a plainer handle.
        let mut exes = HashMap::new();
        for (pid, p) in self.sys.processes() {
            if p.exe().is_some_and(|e| e.as_os_str().is_empty()) {
                let key = (pid.as_u32(), p.start_time());
                let exe = self.exes.remove(&key).unwrap_or_else(|| win::process::exe_path(key.0));
                exes.insert(key, exe);
            }
        }
        self.exes = exes;
    }

    /// Each process: its id, its exe's file name, the exe's full path when Windows tells it, when it started and the
    /// process that started it.
    fn iter(&self) -> impl Iterator<Item = Proc<'_>> {
        self.sys.processes().iter().map(|(pid, p)| {
            let exe = p
                .exe()
                .filter(|e| !e.as_os_str().is_empty())
                .or_else(|| self.exes.get(&(pid.as_u32(), p.start_time())).and_then(Option::as_deref));
            Proc {
                pid: pid.as_u32(),
                name: p.name(),
                exe,
                started: p.start_time(),
                parent: p.parent().map(sysinfo::Pid::as_u32),
            }
        })
    }

    pub fn list(&self) -> Vec<Proc<'_>> {
        self.iter().collect()
    }

    /// The processes running `exe`.
    fn running(&self, exe: &Path) -> impl Iterator<Item = Proc<'_>> {
        let want = exe.to_string_lossy().to_lowercase();
        self.iter().filter(move |p| p.exe.is_some_and(|e| e.to_string_lossy().to_lowercase() == want))
    }

    fn pid_of(&self, exe: &Path) -> Option<u32> {
        self.running(exe).next().map(|p| p.pid)
    }

    /// When the first of the processes running `exe` started, in seconds since 1970.
    fn started(&self, exe: &Path) -> Option<u64> {
        self.running(exe).map(|p| p.started).min()
    }
}

/// The processes running an exe with one of these names (in any case). Reads only the names, so it is cheap to ask
/// every few seconds, unlike `Processes`, which also reads each process's exe path.
pub fn pids_named(names: &[&str]) -> Vec<u32> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    sys.processes()
        .iter()
        .filter(|(_, p)| names.iter().any(|n| p.name().eq_ignore_ascii_case(n)))
        .map(|(pid, _)| pid.as_u32())
        .collect()
}

pub fn status(store: Store, procs: &Processes) -> Status {
    let exe = store.exe();
    // Xbox games start without a store app, so the Xbox store is always there to launch through (the page leaves it
    // out of its list of store apps).
    let installed = exe.is_some() || store == Store::Xbox;
    let pid = exe.as_deref().and_then(|e| store.processes(e).iter().find_map(|r| procs.pid_of(r)));
    let running = pid.is_some();
    // Steam says live who is signed in, and Battle.net's log says how its session went. The others keep an encrypted
    // saved login; whether it exists is the best local sign: with it the app signs in by itself, without it the
    // player has to.
    let saved = |present: bool| match (present, running) {
        (true, true) => Account::SignedIn,
        (true, false) => Account::Remembered,
        (false, _) => Account::SignedOut,
    };
    let account = match store {
        Store::Steam => steam::account(pid),
        Store::Epic => saved(epic::remembered()),
        Store::Ea => saved(ea::remembered()),
        Store::Ubisoft => saved(ubisoft::remembered()),
        Store::Rockstar => saved(rockstar::remembered()),
        Store::Battlenet => {
            battlenet::account(exe.as_deref().filter(|_| running).map(|e| procs.started(e).unwrap_or(0)))
        }
        // GOG and itch.io games run without the client; Xbox games use the Windows account. The Amazon Games app
        // keeps nothing Lamplit can read: the launch shows whether it is signed in.
        Store::Gog | Store::Itch | Store::Xbox | Store::Amazon => Account::Unknown,
    };
    Status { store, name: store.name(), installed, running, account }
}

/// Every store, installed or not: the page names a game's store from this list, and warns when a store app the game
/// needs isn't installed.
pub fn status_all() -> Vec<Status> {
    let procs = Processes::now();
    ALL.iter().map(|&s| status(s, &procs)).collect()
}

/// Fills in the store apps each game needs: its own store, plus the publisher's launcher some games bring along
/// (Battlefield on Steam needs the EA app, GTA V on Steam the Rockstar launcher, Far Cry on Steam Ubisoft Connect).
pub fn set_requirements(games: &mut [Game]) {
    let rockstar_dirs = rockstar::owned_dirs();
    for g in games {
        g.requires = requirements(g, &rockstar_dirs);
    }
}

fn requirements(g: &Game, rockstar_dirs: &[String]) -> Vec<Store> {
    // GOG and itch.io games are DRM-free and start from their own exe, so neither app is needed.
    let mut out: Vec<Store> = g.store.into_iter().filter(|s| !matches!(s, Store::Gog | Store::Itch)).collect();
    let names: Vec<String> = std::iter::once(g.dir.clone())
        .chain(subdirs(&g.dir))
        .flat_map(|d| std::fs::read_dir(d).into_iter().flatten().flatten())
        .map(|e| e.file_name().to_string_lossy().to_lowercase())
        .collect();
    let has = |wanted: &[&str]| names.iter().any(|n| wanted.contains(&n.as_str()));
    let mut add = |s: Store| {
        if !out.contains(&s) {
            out.push(s);
        }
    };
    if g.dir.join(r"__Installer\installerdata.xml").is_file() || has(&["eaanticheat.gameservicelauncher.exe"]) {
        add(Store::Ea);
    }
    if has(&[
        "uplay_r1_loader64.dll", "uplay_r1_loader.dll", "uplay_r2_loader64.dll", "uplay_r2_loader.dll",
        "upc_r1_loader64.dll", "upc_r2_loader64.dll",
    ]) {
        add(Store::Ubisoft);
    }
    if has(&["playgtav.exe", "playrdr2.exe"]) || rockstar_dirs.contains(&folder_key(&g.dir)) {
        add(Store::Rockstar);
    }
    out
}

/// A string value from HKEY_LOCAL_MACHINE, where store installers record their folders.
fn machine_value(path: &str, name: &str) -> Option<String> {
    RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(path).ok()?.get_value(name).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn statuses_reach_the_page_as_in_their_fixture() {
        let status =
            |store: Store, running, account| Status { store, name: store.name(), installed: true, running, account };
        let list = [status(Store::Steam, true, Account::SignedIn), status(Store::Ea, false, Account::SignedOut)];
        assert_eq!(serde_json::to_value(list).unwrap(), ipc_fixture!("stores"));
        let accounts = <Account as strum::VariantArray>::VARIANTS;
        assert_eq!(serde_json::to_value(accounts).unwrap(), ipc_fixture!("values")["account"]);
    }

    #[test]
    fn keys_are_the_names_the_page_gets() {
        for store in ALL {
            assert_eq!(serde_json::to_value(store).unwrap(), store.key());
        }
    }

    #[test]
    fn finds_this_test_by_its_exe() {
        let (me, exe) = (std::process::id(), std::env::current_exe().unwrap());
        assert_eq!(win::process::exe_path(me), Some(exe.clone()));
        let mut procs = Processes::now();
        procs.refresh();
        assert_eq!(procs.pid_of(&exe), Some(me));
        let name = exe.file_name().unwrap().to_string_lossy().to_uppercase();
        assert!(pids_named(&["nothing.exe", name.as_str()]).contains(&me));
    }

    #[test]
    fn knows_which_process_started_another() {
        // Started by this test, and still running while it looks.
        let mut child = std::process::Command::new("cmd.exe").args(["/c", "ping -n 3 127.0.0.1 >nul"]).spawn().unwrap();
        let procs = Processes::now();
        let listed = procs.list().iter().find(|p| p.pid == child.id()).map(|p| (p.parent, p.started));
        child.kill().unwrap();
        child.wait().unwrap();
        let (parent, started) = listed.expect("the child is listed");
        assert_eq!(parent, Some(std::process::id()));
        assert!(started > 1_700_000_000, "{started}");
    }

    #[test]
    fn publishers_launchers_come_after_the_store() {
        let dir = std::env::temp_dir().join(format!("lamplit-test-requires-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("bin")).unwrap();
        fs::create_dir_all(dir.join("__Installer")).unwrap();
        fs::write(dir.join(r"__Installer\installerdata.xml"), "<game/>").unwrap();
        fs::write(dir.join(r"bin\uplay_r1_loader64.dll"), "").unwrap();
        let game = |store| Game::new("x".into(), "X".into(), store, dir.clone(), Launch::Uri("x".into()));
        assert_eq!(requirements(&game(Some(Store::Steam)), &[]), vec![Store::Steam, Store::Ea, Store::Ubisoft]);
        assert_eq!(requirements(&game(None), &[folder_key(&dir)]), vec![Store::Ea, Store::Ubisoft, Store::Rockstar]);
        // GOG games start without GOG Galaxy.
        let plain = std::env::temp_dir().join(format!("lamplit-test-requires-gog-{}", std::process::id()));
        fs::create_dir_all(&plain).unwrap();
        let gog = Game::new("g".into(), "G".into(), Some(Store::Gog), plain.clone(), Launch::Uri("x".into()));
        assert!(requirements(&gog, &[]).is_empty());
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&plain).unwrap();
    }
}
