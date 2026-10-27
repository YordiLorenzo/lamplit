// The dock's window: transparent, undecorated, above everything, out of the taskbar and Alt+Tab. It is made once,
// hidden, while the dock is switched on (a second WebView2 page takes a moment to load, too long to wait for while
// the player holds PS), and shown at the bottom of the screen the game is on. Lamplit shows and hides it through
// win::dock rather than Tauri, which can only show a window by giving it the focus.

use crate::win::dock::{self as float, Input, Rect};
use crate::win::window::HWND;
use std::sync::atomic::{AtomicIsize, Ordering};
use tauri::{AppHandle, Manager, RunEvent, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub const LABEL: &str = "dock";

/// The dock window's handle, 0 while there is none. Kept as a number: a window handle can't cross threads.
static DOCK: AtomicIsize = AtomicIsize::new(0);

pub fn handle() -> Option<HWND> {
    match DOCK.load(Ordering::SeqCst) {
        0 => None,
        dock => Some(HWND(dock as *mut _)),
    }
}

/// Makes the dock's window, hidden, unless it is there already.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }
    // WebView2 pages that share a data folder must all start with the same browser arguments: the main window's.
    let main = app.config().app.windows.iter().find(|w| w.label == "main");
    let args = main.and_then(|w| w.additional_browser_args.clone());
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("dock.html".into()))
        .title("Lamplit dock")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .visible(false);
    if let Some(args) = &args {
        builder = builder.additional_browser_args(args);
    }
    let window = builder.build()?;
    DOCK.store(window.hwnd()?.0 as isize, Ordering::SeqCst);
    let app = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            super::lost_focus(&app);
        }
    });
    Ok(())
}

/// A window asked to close (Alt+F4), as the app's run loop hears of it. Returns true when it was the dock's: the
/// dock folds away as for Circle, and its window stays, since Lamplit keeps its handle for the next hold of PS.
///
/// Closing the home window closes the dock with it. Tauri ends the app only once its last window has gone, so the
/// hidden dock would keep Lamplit running with no window, holding the single-instance lock: starting Lamplit again
/// would only look for that window and stop. Lamplit never keeps its home window open on a close request.
pub fn on_close_request<R: Runtime>(app: &tauri::AppHandle<R>, event: &RunEvent) -> bool {
    let RunEvent::WindowEvent { label, event: WindowEvent::CloseRequested { api, .. }, .. } = event else {
        return false;
    };
    if label == LABEL {
        api.prevent_close();
        return true;
    }
    if label == "main"
        && let Some(dock) = app.get_webview_window(LABEL)
    {
        DOCK.store(0, Ordering::SeqCst);
        let _ = dock.destroy();
    }
    false
}

pub fn destroy(app: &AppHandle) {
    DOCK.store(0, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Size {
    Open,
    News,
    /// The whole screen, for the veil that hands over to the home screen (Home).
    Screen,
}

/// Shows the dock's window at the bottom of the screen `over` is on: open, or around the folded pill for news,
/// which leaves the game its focus and its mouse, or over all of it.
pub fn place(dock: HWND, over: HWND, size: Size) {
    let Some(screen) = float::screen_of(over) else { return };
    let input = if size == Size::News { Input::Passive } else { Input::Active };
    float::float(dock, rect(screen, size), input);
}

/// The window's rectangle on `screen`. Open, it spans the bottom 60% of the screen: room for the dock to grow, and a
/// click beside the dock lands on its page, which folds it. For news only a strip around the pill, so as little of
/// the game as possible sits under another window. The page lays the dock out from the bottom centre either way, in
/// hundredths of the screen's height.
fn rect(screen: Rect, size: Size) -> Rect {
    let u = |n: i32| screen.height * n / 100;
    let (width, height) = match size {
        Size::Open => (screen.width, u(60)),
        Size::News => (u(72).min(screen.width), u(16)),
        Size::Screen => (screen.width, screen.height),
    };
    Rect { x: screen.x + (screen.width - width) / 2, y: screen.y + screen.height - height, width, height }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sits_at_the_bottom_centre_of_the_games_screen() {
        // A 4K TV to the right of a 1080p monitor.
        let tv = Rect { x: 1920, y: 0, width: 3840, height: 2160 };
        assert_eq!(rect(tv, Size::Open), Rect { x: 1920, y: 864, width: 3840, height: 1296 });
        assert_eq!(rect(tv, Size::News), Rect { x: 1920 + 1142, y: 1815, width: 1555, height: 345 });
        assert_eq!(rect(tv, Size::Screen), tv);
        // A portrait screen is narrower than the strip for news.
        let tall = Rect { x: 0, y: 0, width: 1080, height: 1920 };
        assert_eq!(rect(tall, Size::News), Rect { x: 0, y: 1613, width: 1080, height: 307 });
    }
}
