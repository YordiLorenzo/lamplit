// Top-level windows: finding them, reading their title and process, and moving them in front, aside or down.
// A window handle can go stale at any moment (its window closes); these calls then fail or read as empty.
// Nothing here waits for another process's window for more than a moment: it may be a game that stopped responding,
// which is just when the player calls Lamplit up, and Lamplit would then hang with it.

use std::ops::ControlFlow;
use std::time::Duration;
use windows::Win32::Foundation::{LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Input::KeyboardAndMouse::{KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, VK_MENU, keybd_event};
use windows::Win32::UI::Shell::{
    QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN, SHQueryUserNotificationState,
};
use windows::Win32::UI::WindowsAndMessaging::{
    ASFW_ANY, AllowSetForegroundWindow, BringWindowToTop, EnumWindows, GW_OWNER, GWL_EXSTYLE, GetForegroundWindow,
    GetWindow, GetWindowLongPtrW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, HWND_NOTOPMOST,
    HWND_TOPMOST, IsIconic, IsWindowVisible, SHOW_WINDOW_CMD, SMTO_ABORTIFHUNG, SMTO_BLOCK, SW_MINIMIZE, SW_RESTORE,
    SW_SHOWNOACTIVATE, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SendMessageTimeoutW,
    SetForegroundWindow, SetWindowPos, ShowWindow, ShowWindowAsync, WM_NULL, WS_EX_TOPMOST,
};
use windows::core::BOOL;

pub use windows::Win32::Foundation::HWND;

/// Calls `visit` with each top-level window, front to back, until it breaks.
pub fn for_each_window(mut visit: impl FnMut(HWND) -> ControlFlow<()>) {
    // A closure reference is two pointers wide and LPARAM holds one, so `each` gets a pointer to the reference.
    type Visit<'a> = &'a mut dyn FnMut(HWND) -> ControlFlow<()>;
    unsafe extern "system" fn each(window: HWND, visit: LPARAM) -> BOOL {
        // SAFETY: LPARAM is the pointer to `visit` below, which lives until EnumWindows (which calls this) returns.
        let visit = unsafe { &mut *(visit.0 as *mut Visit) };
        BOOL::from(visit(window).is_continue())
    }
    let mut visit: Visit = &mut visit;
    // SAFETY: `each` reads LPARAM only as that pointer. EnumWindows fails when `visit` breaks, which is no error.
    let _ = unsafe { EnumWindows(Some(each), LPARAM(&raw mut visit as isize)) };
}

pub fn process_id(window: HWND) -> u32 {
    let mut pid = 0u32;
    // SAFETY: pid is a valid place for the answer.
    unsafe { GetWindowThreadProcessId(window, Some(&raw mut pid)) };
    pid
}

pub fn title(window: HWND) -> String {
    let mut buf = [0u16; 256];
    // SAFETY: the call writes at most the buffer's length, which it is given with the buffer.
    let len = unsafe { GetWindowTextW(window, &mut buf) } as usize;
    String::from_utf16_lossy(&buf[..len])
}

pub fn is_visible(window: HWND) -> bool {
    // SAFETY: only reads the window's state.
    unsafe { IsWindowVisible(window) }.as_bool()
}

/// Windows counts the window as visible but doesn't draw it: a packaged app's window that is suspended or on another
/// virtual desktop, say.
pub fn is_cloaked(window: HWND) -> bool {
    let mut cloaked = 0u32;
    // SAFETY: the attribute is a u32, which `cloaked` holds, and its size goes with it.
    let read =
        unsafe { DwmGetWindowAttribute(window, DWMWA_CLOAKED, (&raw mut cloaked).cast(), size_of::<u32>() as u32) };
    read.is_ok() && cloaked != 0
}

/// A rectangle on the screen, in pixels, right and bottom outside it.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl From<RECT> for Rect {
    fn from(r: RECT) -> Self {
        Rect { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    }
}

/// Where the window is on the screen.
pub fn rect(window: HWND) -> Option<Rect> {
    let mut r = RECT::default();
    // SAFETY: r is a valid place for the answer; a stale handle makes the call fail.
    unsafe { GetWindowRect(window, &raw mut r) }.ok()?;
    Some(r.into())
}

/// The whole of the monitor the window is on (or nearest to).
pub fn monitor(window: HWND) -> Option<Rect> {
    let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
    // SAFETY: MonitorFromWindow always returns a monitor with this flag, and info carries its own size.
    let read = unsafe { GetMonitorInfoW(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), &raw mut info) };
    read.as_bool().then(|| info.rcMonitor.into())
}

/// Puts `window` behind `front` without activating it, among the windows that aren't topmost: right behind `front`, or,
/// when `front` is topmost itself, at the top of those windows, since Windows keeps a window put behind a topmost one
/// topmost too, above every ordinary window the player switches to. False, and `window` left where it was, when
/// `front` has closed, as a game may close its window to open another while it sets its screen mode.
pub fn place_behind(window: HWND, front: HWND) -> bool {
    let after = if is_topmost(front) { HWND_NOTOPMOST } else { front };
    let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
    // SAFETY: changes only the window's place among the others; a stale handle makes the call fail.
    unsafe { SetWindowPos(window, Some(after), 0, 0, 0, 0, flags) }.is_ok()
}

/// The window is above every window that isn't topmost.
pub fn is_topmost(window: HWND) -> bool {
    // SAFETY: only reads the window's extended style; a stale handle reads as 0.
    let style = unsafe { GetWindowLongPtrW(window, GWL_EXSTYLE) } as u32;
    style & WS_EX_TOPMOST.0 != 0
}

/// Puts the window above every window that isn't topmost (`on`), or back among them, without activating it. For
/// another thread's window the change is posted to that thread, so a thread that is busy can't hold the caller up.
pub fn set_topmost(window: HWND, on: bool) {
    let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS;
    let after = if on { HWND_TOPMOST } else { HWND_NOTOPMOST };
    // SAFETY: changes only the window's place among the others; a stale handle makes the call fail.
    let _ = unsafe { SetWindowPos(window, Some(after), 0, 0, 0, 0, flags) };
}

/// A window with an owner belongs to another one (a dialog or a tool window), rather than being an app's own.
pub fn has_owner(window: HWND) -> bool {
    // SAFETY: only reads the window's state; it fails for a window without an owner.
    unsafe { GetWindow(window, GW_OWNER) }.is_ok()
}

/// The window's thread reads its messages: it answers a message that asks nothing (WM_NULL) within `wait`, or at once
/// when Windows already counts it as not responding. IsHungAppWindow alone misses a thread that stopped while it
/// waited for input: Windows counts it as hung only once a message has waited 5 seconds for it.
pub fn responds(window: HWND, wait: Duration) -> bool {
    let (flags, wait) = (SMTO_ABORTIFHUNG | SMTO_BLOCK, wait.as_millis() as u32);
    // SAFETY: sends a message without parameters and waits at most `wait`; a stale handle makes it fail.
    let answered = unsafe { SendMessageTimeoutW(window, WM_NULL, WPARAM(0), LPARAM(0), flags, wait, None) };
    answered.0 != 0
}

pub fn is_minimized(window: HWND) -> bool {
    // SAFETY: only reads the window's state.
    unsafe { IsIconic(window) }.as_bool()
}

/// ShowWindow for a window of this thread. For another thread's window it only posts the change (ShowWindowAsync):
/// ShowWindow would wait for that thread.
fn show(window: HWND, cmd: SHOW_WINDOW_CMD) {
    // SAFETY: both change only the window's own state; the result is its earlier visibility, not an error.
    unsafe {
        if GetWindowThreadProcessId(window, None) == GetCurrentThreadId() {
            let _ = ShowWindow(window, cmd);
        } else {
            let _ = ShowWindowAsync(window, cmd);
        }
    }
}

pub fn minimize(window: HWND) {
    show(window, SW_MINIMIZE);
}

/// Restores a minimised window without activating it.
pub fn unminimize(window: HWND) {
    if is_minimized(window) {
        show(window, SW_SHOWNOACTIVATE);
    }
}

/// Restores the window and asks Windows to put it in front.
pub fn restore(window: HWND) {
    show(window, SW_RESTORE);
    // SAFETY: changes only which window is in front; the result says whether Windows allowed it.
    let _ = unsafe { SetForegroundWindow(window) };
}

pub fn foreground() -> HWND {
    // SAFETY: takes nothing; returns a null handle when no window is in front.
    unsafe { GetForegroundWindow() }
}

/// Puts the window in front, also when another process had the last input. Windows only lets that process take the
/// foreground; sharing the foreground thread's input state gets around that, and a synthetic Alt press is the
/// fallback. Call it on the thread that owns Lamplit's window. The window may be Lamplit's own or another process's
/// (a game that Lamplit steps aside for).
pub fn force_foreground(window: HWND) {
    if is_minimized(window) {
        show(window, SW_RESTORE);
    }
    let front = foreground();
    if front == window {
        return;
    }
    // SAFETY: the thread ids come from Windows just before; attaching to a thread that has gone fails harmlessly,
    // and the input state is detached again before this returns. The window calls only change window state.
    unsafe {
        let me = GetCurrentThreadId();
        let other = GetWindowThreadProcessId(front, None);
        // Attached threads share one input queue, so while a thread that has stopped responding (a frozen game) is
        // attached, this one waits on it too: on 2026-10-27 a suspended stand-in game held Lamplit's main thread here
        // until it ran again. Such a thread gets the Alt press below instead.
        let attached = other != 0
            && other != me
            && responds(front, Duration::from_millis(200))
            && AttachThreadInput(me, other, true).as_bool();
        // BringWindowToTop waits for the thread that owns the window. SetForegroundWindow raises another thread's
        // window without waiting, so a game that isn't responding can't hold Lamplit up here.
        if GetWindowThreadProcessId(window, None) == me {
            let _ = BringWindowToTop(window);
        }
        let _ = SetForegroundWindow(window);
        if attached {
            let _ = AttachThreadInput(me, other, false);
        }
        if GetForegroundWindow() != window {
            keybd_event(VK_MENU.0 as u8, 0, KEYEVENTF_EXTENDEDKEY, 0);
            keybd_event(VK_MENU.0 as u8, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, 0);
            let _ = SetForegroundWindow(window);
        }
    }
}

/// Lets whatever opens next take the foreground from Lamplit (a game or store app it starts).
pub fn allow_any_foreground() {
    // SAFETY: takes a constant; it fails only when this process may not pass the foreground on, which is no error.
    let _ = unsafe { AllowSetForegroundWindow(ASFW_ANY) };
}

/// A full-screen app is in front: a game (Direct3D full screen or borderless), a video or a presentation.
pub fn full_screen_app_in_front() -> bool {
    // SAFETY: takes nothing and returns a value.
    let state = unsafe { SHQueryUserNotificationState() };
    matches!(state, Ok(s) if s == QUNS_BUSY || s == QUNS_RUNNING_D3D_FULL_SCREEN || s == QUNS_PRESENTATION_MODE)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, GW_HWNDNEXT, WINDOW_EX_STYLE, WS_POPUP,
    };
    use windows::core::w;

    /// The tests that order windows take turns: one test's windows would come between another's.
    pub static ONE_AT_A_TIME: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

    /// A hidden top-level window of this thread, topmost or not: the system's STATIC class needs no registering.
    pub fn window(topmost: bool) -> HWND {
        let style = if topmost { WS_EX_TOPMOST } else { WINDOW_EX_STYLE(0) };
        // SAFETY: the class and title are constant strings; the window has no parent, menu or data.
        unsafe {
            CreateWindowExW(style, w!("STATIC"), w!("lamplit test"), WS_POPUP, 0, 0, 64, 64, None, None, None, None)
        }
        .unwrap()
    }

    /// The window right behind `window` in the z-order.
    pub fn next(window: HWND) -> Option<HWND> {
        // SAFETY: only reads the z-order.
        unsafe { GetWindow(window, GW_HWNDNEXT) }.ok()
    }

    /// Closes a window `window(..)` made on this thread.
    pub fn destroy(window: HWND) {
        // SAFETY: the caller made the window on this thread.
        unsafe { DestroyWindow(window) }.unwrap();
    }

    #[test]
    fn lamplit_behind_a_topmost_game_leaves_the_topmost_windows() {
        let _turn = ONE_AT_A_TIME.lock();
        let (lamplit, game, other) = (window(true), window(true), window(false));
        assert!(place_behind(lamplit, game));
        assert!(!is_topmost(lamplit), "it would stay above every ordinary window the player switches to");
        // Behind a game that isn't topmost: right behind it.
        set_topmost(lamplit, true);
        assert!(is_topmost(lamplit));
        assert!(place_behind(lamplit, other));
        // SAFETY: reads the window after `other` in the z-order.
        let next = unsafe { GetWindow(other, GW_HWNDNEXT) };
        assert!(!is_topmost(lamplit) && next == Ok(lamplit), "{next:?}");
        for w in [lamplit, game, other] {
            // SAFETY: each window is this thread's, made above.
            unsafe { DestroyWindow(w) }.unwrap();
        }
    }

    #[test]
    fn lamplit_stays_on_top_when_the_window_it_was_to_go_behind_has_gone() {
        let _turn = ONE_AT_A_TIME.lock();
        // The game replaced its window while the screen faded to black.
        let (lamplit, game) = (window(true), window(false));
        // SAFETY: the window is this thread's, made above.
        unsafe { DestroyWindow(game) }.unwrap();
        assert!(!place_behind(lamplit, game), "the handover would count as done, and Lamplit stay on top");
        assert!(is_topmost(lamplit), "it keeps holding the screen");
        // SAFETY: the window is this thread's, made above.
        unsafe { DestroyWindow(lamplit) }.unwrap();
    }
}
