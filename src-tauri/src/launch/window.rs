// Lamplit's own window: whether it is in front, bringing it forward, holding the screen while a game starts, and
// handing it over to the game.

use super::Launcher;
use crate::events::{self, Event};
use crate::win::window::{self, HWND};
use parking_lot::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Lamplit's window handle, read once on the main thread. From any other thread Tauri answers that question through
/// the main thread, which may be busy; the controller threads ask on every press, and would wait with it. Kept as a
/// number: a window handle can't cross threads.
static LAMPLIT: OnceLock<isize> = OnceLock::new();

/// Reads Lamplit's window handle. Runs in Tauri's setup, on the main thread, after the window is made.
pub fn remember_lamplit(app: &AppHandle) -> tauri::Result<()> {
    let main = app.get_webview_window("main").ok_or(tauri::Error::WindowNotFound)?;
    let _ = LAMPLIT.set(main.hwnd()?.0 as isize);
    Ok(())
}

/// The launch whose starting screen holds the screen, 0 for none (see `hold`).
static HOLD: Mutex<u64> = Mutex::new(0);
/// The thread that keeps Lamplit on top while it holds the screen runs.
static KEEPER: AtomicBool = AtomicBool::new(false);
/// How often the keeper puts Lamplit back on top.
const KEEP_EVERY: Duration = Duration::from_millis(250);

/// Lamplit's window is in front, or holds the screen for a game that starts: a store app or the game may have taken
/// Windows' foreground meanwhile, but the player sees Lamplit and its controller presses are for it.
pub fn lamplit_in_front() -> bool {
    *HOLD.lock() != 0 || LAMPLIT.get().is_some_and(|&lamplit| window::foreground().0 as isize == lamplit)
}

/// Lamplit's starting screen stays full screen above every other window until it lets go: store apps, a game's splash
/// and Windows' taskbar would otherwise show over it, and the desktop between them. Lamplit comes forward too, but a
/// window that opens later isn't kept from Windows' foreground: a game may need it to set its screen mode.
pub fn hold(app: &AppHandle, generation: u64) {
    bring_lamplit_forward(app);
    let Some(&lamplit) = LAMPLIT.get() else { return };
    let mut held = HOLD.lock();
    *held = generation;
    if KEEPER.swap(true, Ordering::SeqCst) {
        return;
    }
    log::info!("holding the screen while the game starts");
    std::thread::spawn(move || {
        loop {
            {
                let held = HOLD.lock();
                if *held == 0 {
                    // Under the lock, so a `hold` meanwhile finds no keeper and starts one.
                    KEEPER.store(false, Ordering::SeqCst);
                    return;
                }
                // Again and again: Windows puts the taskbar back on top whenever another window takes the foreground.
                window::set_topmost(HWND(lamplit as *mut _), true);
            }
            std::thread::sleep(KEEP_EVERY);
        }
    });
}

/// Stops holding the screen for launch `generation`, or for any launch with None. False when it wasn't held for it.
fn let_go(generation: Option<u64>) -> bool {
    let mut held = HOLD.lock();
    if *held == 0 || generation.is_some_and(|g| g != *held) {
        return false;
    }
    *held = 0;
    true
}

/// Lamplit stops holding the screen for launch `generation` (any launch with None): it was cancelled or failed, or
/// the player asked to see a window that may need them. Its window stays where it is, among the others.
pub fn release(app: &AppHandle, generation: Option<u64>) {
    let Some(&lamplit) = LAMPLIT.get().filter(|_| let_go(generation)) else { return };
    log::info!("no longer holding the screen");
    let _ = app.run_on_main_thread(move || window::set_topmost(HWND(lamplit as *mut _), false));
}

/// Hands the screen over to the window `to`: Lamplit lets go and goes right behind that window rather than minimising,
/// so the desktop shows neither now nor when the game closes. The window may have Windows' foreground already (a game
/// takes it as its window opens) while Lamplit still covers it; on the main thread, so the keeper's last raise comes
/// first.
pub fn hand_over(app: &AppHandle, generation: u64, to: isize) {
    let_go(Some(generation));
    let Some(&lamplit) = LAMPLIT.get() else { return };
    let _ = app.run_on_main_thread(move || {
        let to = HWND(to as *mut _);
        window::place_behind(HWND(lamplit as *mut _), to);
        window::force_foreground(to);
    });
}

/// The whole of the screen Lamplit is on.
pub fn lamplit_screen() -> Option<window::Rect> {
    LAMPLIT.get().and_then(|&lamplit| window::monitor(HWND(lamplit as *mut _)))
}

/// Lamplit's own windows are those of this process.
pub fn is_lamplits(w: HWND) -> bool {
    window::process_id(w) == std::process::id()
}

/// Brings Lamplit in front of whatever has the screen, a game included. The dock, which is above every window, goes.
pub fn bring_lamplit_forward(app: &AppHandle) {
    crate::dock::hide(app);
    let Some(&lamplit) = LAMPLIT.get() else { return };
    // Windows lets only the thread that owns the window take the foreground for it.
    let _ = app.run_on_main_thread(move || window::force_foreground(HWND(lamplit as *mut _)));
}

pub fn minimize_lamplit(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.minimize();
    }
}

/// Holding PS, or View and Menu: Lamplit comes forward even over a game, and holds the screen again for a game that
/// is still starting.
pub fn summon(app: &AppHandle) {
    log::info!("summoned with a controller");
    let launcher = app.state::<Launcher>();
    match launcher.starting() {
        Some(generation) => hold(app, generation),
        None => bring_lamplit_forward(app),
    }
    events::emit(app, Event::Summoned(launcher.running_id()));
}
