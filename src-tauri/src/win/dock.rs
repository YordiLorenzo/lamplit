// What the in-game dock needs from Windows: a window that floats above a game, with or without taking the game's
// focus; the screen the game is on; whether the game holds the screen in exclusive full screen, where no other
// window shows; and closing a game, by asking its window or by ending its processes. Like window.rs, nothing here
// waits for another process's window: the game may have stopped responding.

use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTOPRIMARY, MONITORINFO, MonitorFromWindow};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE, TerminateProcess};
use windows::Win32::UI::Shell::{QUNS_RUNNING_D3D_FULL_SCREEN, SHQueryUserNotificationState};
use windows::Win32::UI::WindowsAndMessaging::{
    GWL_EXSTYLE, GetWindowLongPtrW, HWND_TOPMOST, PostMessageW, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SWP_NOZORDER, SWP_SHOWWINDOW, SetWindowLongPtrW, SetWindowPos, WM_CLOSE, WS_EX_LAYERED, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
};

/// A rectangle on the desktop, in physical pixels.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// The whole screen `window` is on (the main screen when it is on none).
pub fn screen_of(window: HWND) -> Option<Rect> {
    let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
    // SAFETY: MonitorFromWindow only reads the window's position and never fails with this flag; `info` is a
    // MONITORINFO whose size field is set as GetMonitorInfoW requires.
    let ok = unsafe { GetMonitorInfoW(MonitorFromWindow(window, MONITOR_DEFAULTTOPRIMARY), &raw mut info) };
    let RECT { left, top, right, bottom } = info.rcMonitor;
    ok.as_bool().then_some(Rect { x: left, y: top, width: right - left, height: bottom - top })
}

/// How the floating window takes input.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Input {
    /// It can be the window in front, and takes the mouse.
    Active,
    /// It never becomes the window in front, and the mouse goes through it to the window below: the game keeps its
    /// focus and its clicks.
    Passive,
}

/// Shows `window` at `rect`, above every window that isn't topmost itself, without taking the foreground. Only for
/// a window of this thread.
pub fn float(window: HWND, rect: Rect, input: Input) {
    set_input(window, input);
    let flags = SWP_NOACTIVATE | SWP_SHOWWINDOW;
    // SAFETY: changes only the window's own place and visibility; a stale handle makes it fail harmlessly.
    let _ = unsafe { SetWindowPos(window, Some(HWND_TOPMOST), rect.x, rect.y, rect.width, rect.height, flags) };
}

/// How a window of this thread takes input. The styles are set each time, so whatever reset them in between doesn't
/// matter: WS_EX_TOOLWINDOW keeps it out of Alt+Tab, and a passive window gets WS_EX_NOACTIVATE, and
/// WS_EX_TRANSPARENT with WS_EX_LAYERED, which together let the mouse through.
pub fn set_input(window: HWND, input: Input) {
    let passive = WS_EX_NOACTIVATE.0 | WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0;
    // SAFETY: reads and writes the extended style of a window of this thread; a stale handle makes both calls fail
    // harmlessly.
    unsafe {
        let style = GetWindowLongPtrW(window, GWL_EXSTYLE) as u32 | WS_EX_TOOLWINDOW.0 | WS_EX_TOPMOST.0;
        let style = if input == Input::Passive { style | passive } else { style & !passive };
        SetWindowLongPtrW(window, GWL_EXSTYLE, style as isize);
    }
}

/// Hides a window of this thread without activating another one in its place.
pub fn hide(window: HWND) {
    let flags = SWP_HIDEWINDOW | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER;
    // SAFETY: changes only the window's visibility; a stale handle makes it fail harmlessly.
    let _ = unsafe { SetWindowPos(window, None, 0, 0, 0, 0, flags) };
}

/// A Direct3D app holds the screen in exclusive full screen: Windows shows no other window over it, and one that
/// takes the foreground makes it leave full screen (most such games minimise).
pub fn exclusive_full_screen() -> bool {
    // SAFETY: takes nothing and returns a value.
    unsafe { SHQueryUserNotificationState() }.is_ok_and(|s| s == QUNS_RUNNING_D3D_FULL_SCREEN)
}

/// Asks a window to close, as its close button does; the app may ask the player first. Doesn't wait for it.
pub fn ask_to_close(window: HWND) -> windows::core::Result<()> {
    // SAFETY: posts a message without parameters to the window's queue; a stale handle makes it fail.
    unsafe { PostMessageW(Some(window), WM_CLOSE, WPARAM(0), LPARAM(0)) }
}

/// Ends a process at once, as Task Manager's End task does when an app doesn't respond. Windows refuses for a
/// process with more rights than Lamplit's (a game run as administrator).
pub fn end_process(pid: u32) -> windows::core::Result<()> {
    // SAFETY: takes plain values; the handle it returns is owned below.
    let handle = unsafe { OpenProcess(PROCESS_TERMINATE, false, pid) }?;
    // SAFETY: the handle was just opened for this function, and nothing else owns or closes it.
    let handle = unsafe { OwnedHandle::from_raw_handle(handle.0) };
    // SAFETY: the handle is open, with the right to end the process.
    unsafe { TerminateProcess(HANDLE(handle.as_raw_handle()), 1) }
}

/// Calls `pressed`, on a thread of its own, each time Ctrl+Alt+Shift and `key` (a letter) are pressed anywhere. Debug
/// builds use it to try the dock without a controller.
#[cfg(debug_assertions)]
pub fn on_hotkey(key: u8, mut pressed: impl FnMut() + Send + 'static) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, RegisterHotKey};
    use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};
    std::thread::spawn(move || {
        let keys = MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT;
        // SAFETY: registers the key for this thread's message queue, with no window; it fails when another app has
        // the same key.
        if let Err(e) = unsafe { RegisterHotKey(None, 1, keys, u32::from(key)) } {
            log::warn!("dock: Ctrl+Alt+Shift+{} is taken: {e}", char::from(key));
            return;
        }
        let mut msg = MSG::default();
        // SAFETY: `msg` is a MSG for the call to fill; it returns 0 at WM_QUIT and -1 on failure, which end the loop.
        while unsafe { GetMessageW(&raw mut msg, None, 0, 0) }.0 > 0 {
            if msg.message == WM_HOTKEY {
                pressed();
            }
        }
    });
}
