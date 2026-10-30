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
    keep_on_top(generation, || app.state::<Launcher>().is_current(generation));
}

/// Keeps Lamplit's window on top for launch `generation`, without bringing it forward (see `hold`), unless that launch
/// has stopped (`current` says): cancelled, or another game started. It looks under the hold's lock, which a cancel
/// takes after it has stopped the launch, so a cancel can't come between the look and the hold and leave Lamplit on
/// top for good.
fn keep_on_top(generation: u64, current: impl FnOnce() -> bool) {
    let mut held = HOLD.lock();
    if !current() {
        return;
    }
    *held = generation;
    let Some(&lamplit) = LAMPLIT.get() else { return };
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

/// Takes the keyboard back for the starting screen of launch `generation` while it holds the screen. A store app
/// Lamplit started may take Windows' foreground meanwhile (a sign-in window), and with it the keys the starting screen
/// offers (Enter, Escape), while the player sees only Lamplit. Not once Lamplit has let go for the player to use that
/// app (Open store, Show it), nor for another launch.
pub fn take_keys(app: &AppHandle, generation: u64) {
    let Some(&lamplit) = LAMPLIT.get() else { return };
    if keys_back(generation, window::foreground().0 as isize, lamplit) {
        log::info!("taking the keyboard back for the starting screen");
        bring_lamplit_forward(app);
    }
}

/// Whether the starting screen of launch `generation` takes the keyboard back from the window `front`.
fn keys_back(generation: u64, front: isize, lamplit: isize) -> bool {
    front != lamplit && *HOLD.lock() == generation
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

/// Hands the screen over to the window `to`: Lamplit lets go and goes behind that window rather than minimising, so
/// the desktop shows neither now nor when the game closes. The window may have Windows' foreground already (a game
/// takes it as its window opens) while Lamplit still covers it. On the main thread, so the keeper's last raise comes
/// first. False when the window has gone meanwhile (a game replacing its window while the screen faded): Lamplit then
/// keeps holding the screen. False too when the launch has stopped meanwhile (see `give_way`).
pub fn hand_over(app: &AppHandle, generation: u64, to: isize) -> bool {
    let Some(&lamplit) = LAMPLIT.get() else { return false };
    let held = let_go(Some(generation));
    let (placed, answer) = std::sync::mpsc::channel();
    let main = app.clone();
    let _ = app.run_on_main_thread(move || {
        let current = main.state::<Launcher>().is_current(generation);
        let _ = placed.send(give_way(current, held, generation, lamplit, to));
    });
    answer.recv_timeout(Duration::from_secs(5)).unwrap_or(false)
}

/// The main thread's part of `hand_over`: Lamplit goes behind `to`, which gets the foreground, or, when `to` has
/// gone, holds the screen again if it did (`held`). Behind `to`, Lamplit is restored if Open store minimised it, so
/// the desktop doesn't show when the game closes. Nothing moves for a launch that has stopped meanwhile (not
/// `current`): the player cancelled it during the fade, and may have started another game, whose starting screen now
/// holds the screen. Cancelling and starting run on the main thread too, so it can't stop between this look and the
/// moves.
fn give_way(current: bool, held: bool, generation: u64, lamplit: isize, to: isize) -> bool {
    if !current {
        return false;
    }
    let (lamplit, to) = (HWND(lamplit as *mut _), HWND(to as *mut _));
    let behind = window::place_behind(lamplit, to);
    if behind {
        window::unminimize(lamplit);
        window::force_foreground(to);
    } else if held {
        keep_on_top(generation, || current);
    }
    behind
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::win::window::tests::{ONE_AT_A_TIME, destroy, next, window as hidden};

    #[test]
    fn a_launch_that_has_stopped_doesnt_hold_the_screen() {
        let _turn = ONE_AT_A_TIME.lock();
        // Cancelled while its store app's sign-in was checked, which then asks for the screen again.
        keep_on_top(7, || false);
        assert_eq!(*HOLD.lock(), 0, "Lamplit would stay above every other window for good");
        keep_on_top(7, || true);
        assert!(let_go(Some(7)));
    }

    #[test]
    fn the_starting_screen_takes_the_keyboard_back_while_it_holds_the_screen() {
        let _turn = ONE_AT_A_TIME.lock();
        let (lamplit, store) = (1, 2);
        keep_on_top(9, || true);
        assert!(keys_back(9, store, lamplit), "Enter and Escape would reach the store app's window unseen");
        assert!(!keys_back(9, lamplit, lamplit));
        assert!(!keys_back(8, store, lamplit), "an earlier launch's");
        // Open store: Lamplit lets go, and the player uses the store app.
        assert!(let_go(Some(9)));
        assert!(!keys_back(9, store, lamplit));
    }

    #[test]
    fn a_home_screen_minimised_for_the_store_app_waits_behind_the_game_unminimised() {
        let _turn = ONE_AT_A_TIME.lock();
        // Open store minimised Lamplit; then the game's window came up.
        let (lamplit, game) = (hidden(false), hidden(false));
        window::minimize(lamplit);
        assert!(window::is_minimized(lamplit));
        assert!(give_way(true, false, 1, lamplit.0 as isize, game.0 as isize));
        assert!(!window::is_minimized(lamplit), "the desktop would show when the game closes");
        assert_eq!(next(game).0, Some(lamplit), "{:?}", next(game));
        destroy(lamplit);
        destroy(game);
    }

    #[test]
    fn a_launch_that_stopped_while_the_screen_faded_moves_no_window() {
        let _turn = ONE_AT_A_TIME.lock();
        // Lamplit holds the screen for the game started next, and the window of the one cancelled during its fade
        // is up.
        let (lamplit, game) = (hidden(true), hidden(false));
        let id = |w: HWND| w.0 as isize;
        assert!(!give_way(false, true, 1, id(lamplit), id(game)));
        assert!(window::is_topmost(lamplit), "the next game's starting screen would go behind the cancelled game");
        // The launch goes on: Lamplit goes right behind its game's window.
        assert!(give_way(true, true, 1, id(lamplit), id(game)));
        let (behind, passed) = next(game);
        assert!(
            !window::is_topmost(lamplit) && behind == Some(lamplit),
            "{behind:?} behind it, after {passed:?}; Lamplit is {lamplit:?}"
        );
        destroy(lamplit);
        destroy(game);
    }
}
