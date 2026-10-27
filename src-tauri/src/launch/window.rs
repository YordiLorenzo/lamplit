// Lamplit's own window: whether it is in front, bringing it forward, and stepping aside for a game.

use super::Launcher;
use crate::events::{self, Event};
use crate::win::window::{self, HWND};
use std::sync::OnceLock;
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

pub fn lamplit_in_front() -> bool {
    LAMPLIT.get().is_some_and(|&lamplit| window::foreground().0 as isize == lamplit)
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

/// Holding PS, or View and Menu: Lamplit comes forward even over a game.
pub fn summon(app: &AppHandle) {
    log::info!("summoned with a controller");
    bring_lamplit_forward(app);
    events::emit(app, Event::Summoned(app.state::<Launcher>().running_id()));
}
