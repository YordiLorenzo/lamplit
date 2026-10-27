// What happens between pressing Play and the game: every store app the game needs is started and signed in
// (or the player is asked to sign in, and Lamplit carries on once they have), a pending update is announced, then
// the game opens and watch.rs watches it. Each step is a line on Lamplit's starting screen.

mod handover;
mod session;
mod watch;
pub mod window;

pub use watch::{game_windows, resume};

use crate::error::{Error, Result};
use crate::events::{self, Event, LaunchStep, Play, StepState};
use crate::library::{Game, Launch};
use crate::prefs;
use crate::stores::{self, Account, Processes, Store, steam};
use crate::win::{self, process::keep_awake};
use parking_lot::Mutex;
use std::ffi::OsStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use watch::Watch;

/// Which launch is the current one, and the game being played. Tauri state.
#[derive(Default)]
pub struct Launcher {
    /// Bumped by every launch and cancel; the checks and the watcher of a launch stop once it has moved on.
    generation: AtomicU64,
    /// The launch the player told to go ahead although Lamplit couldn't confirm a sign-in (only Steam's is certain).
    go_anyway_for: AtomicU64,
    /// The game that runs now, and how to recognise its processes.
    running: Mutex<Option<(String, Watch)>>,
    /// The launch whose game hasn't got the screen yet, 0 for none: summoning Lamplit holds the screen again for it.
    starting: AtomicU64,
    /// A window that opened during the launch and may need the player, which the starting screen offers to show.
    waiting: Mutex<Option<isize>>,
}

impl Launcher {
    /// A new launch: every check or watcher of an earlier one that is still waiting stops. Returns its generation.
    fn begin(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn is_current(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    pub fn cancel(&self, app: &AppHandle) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.starting.store(0, Ordering::SeqCst);
        window::release(app, None);
        log::info!("launch cancelled from Lamplit");
    }

    /// The launch whose game hasn't got the screen yet.
    pub fn starting(&self) -> Option<u64> {
        Some(self.starting.load(Ordering::SeqCst)).filter(|&g| g != 0 && self.is_current(g))
    }

    /// The game of launch `generation` closed right after starting (a launcher handing over), and Lamplit waits for it
    /// again.
    fn waiting_again(&self, generation: u64) {
        self.starting.store(generation, Ordering::SeqCst);
    }

    /// The launch `generation` has given the screen to its game, or stopped.
    fn started(&self, generation: u64) {
        let _ = self.starting.compare_exchange(generation, 0, Ordering::SeqCst, Ordering::SeqCst);
        *self.waiting.lock() = None;
    }

    pub fn go_anyway(&self) {
        self.go_anyway_for.store(self.generation.load(Ordering::SeqCst), Ordering::SeqCst);
        log::info!("going ahead without a confirmed sign-in");
    }

    fn may_go_anyway(&self, generation: u64) -> bool {
        self.go_anyway_for.load(Ordering::SeqCst) == generation
    }

    pub fn running(&self) -> Option<(String, Watch)> {
        self.running.lock().clone()
    }

    pub fn running_id(&self) -> Option<String> {
        self.running.lock().as_ref().map(|(id, _)| id.clone())
    }

    pub fn set_running(&self, id: &str, watch: Watch) {
        *self.running.lock() = Some((id.to_string(), watch));
    }

    /// Forgets the running game if it is still `id`.
    pub fn clear_running(&self, id: &str) {
        self.running.lock().take_if(|(running, _)| running == id);
    }
}

/// How long a store app gets to start.
const STORE_START: Duration = Duration::from_secs(90);
/// A store app that has just started takes a while to sign in with its saved account.
const SIGN_IN_SETTLE: Duration = Duration::from_secs(45);
/// How long Lamplit waits for the player to sign in.
const SIGN_IN_WAIT: Duration = Duration::from_mins(15);

/// One line of the starting screen.
fn step(app: &AppHandle, id: &str, key: &str, state: StepState, label: &str, store: Option<Store>) {
    events::emit(app, Event::LaunchStep(LaunchStep { id, key, state, label, store }));
}

enum Stop {
    Cancelled,
    Failed(String),
}

impl From<Error> for Stop {
    fn from(e: Error) -> Self {
        Stop::Failed(e.to_string())
    }
}

/// Runs the whole launch on its own thread; the UI follows it through `launch-step` and `play` events. Lamplit holds
/// the screen meanwhile, and hands it over once the game's window is up (watch.rs).
pub fn start(app: &AppHandle, game: Game) {
    let launcher = app.state::<Launcher>();
    let generation = launcher.begin();
    launcher.starting.store(generation, Ordering::SeqCst);
    *launcher.waiting.lock() = None;
    window::hold(app, generation);
    let app = app.clone();
    std::thread::spawn(move || {
        // The windows already open: the game's are among those that open from now on.
        let before = watch::open_windows();
        // Store apps can take minutes to start, sign in or update; keep the PC and TV awake meanwhile.
        keep_awake(true);
        match prepare(&app, &game, generation) {
            Ok(started) => watch::watch_game(&app, generation, &game, &before, started),
            Err(Stop::Cancelled) => log::info!("launch of {} cancelled", game.name),
            Err(Stop::Failed(message)) => {
                log::warn!("launch of {} stopped: {message}", game.name);
                app.state::<Launcher>().started(generation);
                window::release(&app, Some(generation));
                events::emit(&app, Event::Play(Play::Failed { id: &game.id, message: &message }));
            }
        }
        keep_awake(false);
    });
}

/// Starts the store apps the game needs and opens the game: the process its exe started, if Windows says.
fn prepare(app: &AppHandle, game: &Game, generation: u64) -> Result<Option<(u32, u64)>, Stop> {
    for &store in &game.requires {
        ensure_store(app, game, store, generation)?;
    }
    if let Some(update) = game.steam_appid.and_then(|a| steam::update(&game.dir, a)) {
        if update.pending {
            step(app, &game.id, "update", StepState::Warn, &update_text(&update), Some(Store::Steam));
        } else {
            step(app, &game.id, "update", StepState::Ok, "Up to date", None);
        }
    }
    if !app.state::<Launcher>().is_current(generation) {
        return Err(Stop::Cancelled);
    }
    step(app, &game.id, "game", StepState::Busy, &format!("Starting {}", game.name), None);
    Ok(open_game(game)?)
}

fn update_text(u: &steam::Update) -> String {
    let gb = |b: u64| b as f64 / 1e9;
    match (u.downloading, u.to_download) {
        (true, total) if total > 0 => {
            format!("Updating: {}% of {:.1} GB", u.downloaded * 100 / total, gb(total))
        }
        (true, _) => "Updating".into(),
        (false, total) if total > 0 => format!("Update needed ({:.1} GB): Steam downloads it first", gb(total)),
        (false, _) => "Update needed: Steam downloads it first".into(),
    }
}

/// The store app runs and is signed in, or the player is asked to sign in.
fn ensure_store(app: &AppHandle, game: &Game, store: Store, generation: u64) -> Result<(), Stop> {
    let name = store.name();
    let key = format!("store:{}", store.key());
    let line = |state, label: &str| step(app, &game.id, &key, state, label, Some(store));
    let launcher = app.state::<Launcher>();
    // One process list for every check, refreshed each time: the waits below check about once a second.
    let mut procs = Processes::default();
    let mut status = || {
        procs.refresh();
        stores::status(store, &procs)
    };
    line(StepState::Busy, &format!("Checking {name}"));
    let mut st = status();
    if !st.installed {
        line(StepState::Error, &format!("{name} isn't installed"));
        return Err(Stop::Failed(format!("{name} isn't installed, and {} needs it.", game.name)));
    }
    if store == Store::Xbox {
        // Xbox games start without a store window; their licence shows when the game opens.
        line(StepState::Ok, name);
        return Ok(());
    }
    if !st.running {
        // Read before the app starts: once it runs, the account reads only as signed in or not (yet).
        let remembered = st.account == Account::Remembered;
        line(StepState::Busy, &format!("Starting {name}…"));
        start_store(app, store)?;
        st = wait(&launcher, generation, STORE_START, || Some(status()).filter(|s| s.running))?
            .ok_or_else(|| Stop::Failed(format!("{name} didn't start.")))?;
        // A saved sign-in takes a moment once the app is up. Without one, the player has to sign in.
        if remembered && st.account == Account::SignedOut {
            line(StepState::Busy, &format!("{name} is signing in…"));
            let signed_in = || Some(status()).filter(|s| s.account == Account::SignedIn);
            if let Some(s) = wait(&launcher, generation, SIGN_IN_SETTLE, signed_in)? {
                st = s;
            }
        }
    }
    match st.account {
        Account::SignedIn => line(StepState::Ok, &format!("{name}: signed in")),
        Account::Unknown => line(StepState::Ok, &format!("{name} is running")),
        Account::Remembered | Account::SignedOut => {
            log::info!("{}: {name} isn't signed in", game.name);
            line(StepState::Block, &format!("Sign in to {name}"));
            let anyway = || launcher.may_go_anyway(generation);
            let go = || (anyway() || status().account == Account::SignedIn).then_some(());
            wait(&launcher, generation, SIGN_IN_WAIT, go)?
                .ok_or_else(|| Stop::Failed(format!("Still not signed in to {name}.")))?;
            if anyway() {
                line(StepState::Warn, &format!("{name}: going ahead without a confirmed sign-in"));
            } else {
                line(StepState::Ok, &format!("{name}: signed in"));
            }
            // The player may have opened the store app to sign in.
            window::hold(app, generation);
        }
    }
    Ok(())
}

/// Polls `check` about once a second until it gives a value; None when `limit` runs out. A cancel or a newer launch
/// stops the wait.
fn wait<T>(
    launcher: &Launcher,
    generation: u64,
    limit: Duration,
    mut check: impl FnMut() -> Option<T>,
) -> Result<Option<T>, Stop> {
    let until = Instant::now() + limit;
    loop {
        if !launcher.is_current(generation) {
            return Err(Stop::Cancelled);
        }
        if let Some(v) = check() {
            return Ok(Some(v));
        }
        if Instant::now() >= until {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// Starts a store app, quietly where the app allows it.
fn start_store(app: &AppHandle, store: Store) -> Result<()> {
    let exe = store.exe().ok_or_else(|| not_installed(store))?;
    log::info!("starting {}", store.name());
    shell_open(&Launch::Exe(exe), store.start_args(prefs::get(app).steam_devtools))
}

/// Brings a store app's window forward so the player can sign in or deal with an update, and steps Lamplit aside.
pub fn show_store(app: &AppHandle, store: Store) -> Result<()> {
    let target = store.window().ok_or_else(|| not_installed(store))?;
    window::release(app, None);
    shell_open(&target, None)?;
    log::info!("showing {} for the player", store.name());
    window::minimize_lamplit(app);
    Ok(())
}

/// Shows the player what a launch may be waiting for: the window the starting screen pointed at, which Lamplit stays
/// behind, else the window of `store`, the store app the line is about.
pub fn show_waiting(app: &AppHandle, store: Option<Store>) -> Result<()> {
    let launcher = app.state::<Launcher>();
    let waiting = launcher.waiting.lock().filter(|&w| win::window::is_visible(win::window::HWND(w as *mut _)));
    if let (Some(w), Some(generation)) = (waiting, launcher.starting()) {
        log::info!("showing the window that may need the player");
        if !window::hand_over(app, generation, w) {
            return Err(Error::Player("That window has closed.".into()));
        }
        return Ok(());
    }
    match store {
        Some(store) => show_store(app, store),
        None => Err(Error::Player("That window has closed.".into())),
    }
}

fn not_installed(store: Store) -> Error {
    Error::Player(format!("{} isn't installed.", store.name()))
}

/// Opens a link or exe the way Explorer would, and waits until Windows has opened it (or the player has answered
/// the admin prompt of an exe that asks for one). Whatever opens may take the foreground from Lamplit.
pub fn shell_open(launch: &Launch, args: Option<&str>) -> Result<()> {
    win::window::allow_any_foreground();
    let (file, dir, args) = match launch {
        Launch::Uri(u) => (OsStr::new(u), None, args),
        Launch::Exe(p) => (p.as_os_str(), p.parent(), args),
        Launch::ExeArgs(p, own) => (p.as_os_str(), p.parent(), Some(own.as_str())),
    };
    win::shell::open(file, args, dir).map_err(|code| not_opened(file, code))
}

/// What the player reads when Windows couldn't open `file`, from ShellExecute's error code.
fn not_opened(file: &OsStr, code: isize) -> Error {
    let file = file.display();
    Error::Player(match code {
        2 | 3 => format!("{file} isn't there any more."),
        31 => format!("No app is set up to open {file}. Is its store app installed?"),
        _ => format!("Windows couldn't open {file} (error {code})."),
    })
}

/// Opens the game. For a game started from its exe, returns the process that started (id and start time), which may
/// start the game proper and end before the watcher first looks.
fn open_game(game: &Game) -> Result<Option<(u32, u64)>> {
    let started = match &game.launch {
        Launch::Uri(_) => shell_open(&game.launch, None).map(|()| None),
        Launch::Exe(exe) | Launch::ExeArgs(exe, _) => {
            let args = if let Launch::ExeArgs(_, args) = &game.launch { Some(args.as_str()) } else { None };
            win::window::allow_any_foreground();
            win::shell::start(exe.as_os_str(), args, exe.parent()).map_err(|code| not_opened(exe.as_os_str(), code))
        }
    };
    let started = started.map_err(|e| match &game.launch {
        // Moved, or uninstalled outside its store.
        Launch::Exe(exe) if !exe.exists() => Error::Player(format!("{e} Reinstall {} or move it back.", game.name)),
        _ => e,
    })?;
    let target = match &game.launch {
        Launch::Uri(u) => u.clone(),
        Launch::Exe(p) => p.display().to_string(),
        Launch::ExeArgs(p, args) => format!("{} {args}", p.display()),
    };
    let process = started.map_or(String::new(), |(pid, _)| format!(", process {pid}"));
    log::info!("launch {} ({}) via {target}{process}", game.name, game.id);
    Ok(started)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_lines() {
        let update = |downloading, to_download, downloaded| steam::Update {
            pending: true,
            downloading,
            to_download,
            downloaded,
            installing: false,
        };
        assert_eq!(update_text(&update(true, 12_000_000_000, 4_440_000_000)), "Updating: 37% of 12.0 GB");
        assert_eq!(update_text(&update(true, 0, 0)), "Updating");
        assert_eq!(update_text(&update(false, 2_500_000_000, 0)), "Update needed (2.5 GB): Steam downloads it first");
        assert_eq!(update_text(&update(false, 0, 0)), "Update needed: Steam downloads it first");
    }
}
