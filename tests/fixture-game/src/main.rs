// A stand-in game for testing Lamplit. What it does depends on its exe's name:
// - a name ending in "Full" (LamplitFull.exe) starts as many games do: a small splash window for 2.5 s, a second
//   with no window at all, then a borderless window that covers the screen, which closes itself after 25 s;
// - any other name shows one dialog titled after the exe, open until closed, as a launcher or a game in a window
//   does.
// With an argument N it closes itself after N seconds.
#![windows_subsystem = "windows"]

use std::sync::atomic::{AtomicIsize, Ordering};
use std::time::Duration;

#[repr(C)]
struct WndClass {
    style: u32,
    proc_: extern "system" fn(isize, u32, usize, isize) -> isize,
    cls_extra: i32,
    wnd_extra: i32,
    instance: isize,
    icon: isize,
    cursor: isize,
    background: isize,
    menu: *const u16,
    class: *const u16,
}

#[repr(C)]
#[derive(Default)]
struct Msg {
    hwnd: isize,
    message: u32,
    wparam: usize,
    lparam: isize,
    time: u32,
    pt: [i32; 2],
    private: u32,
}

#[link(name = "user32")]
unsafe extern "system" {
    fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
    fn RegisterClassW(class: *const WndClass) -> u16;
    #[allow(clippy::too_many_arguments)]
    fn CreateWindowExW(
        ex: u32,
        class: *const u16,
        title: *const u16,
        style: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        parent: isize,
        menu: isize,
        instance: isize,
        param: isize,
    ) -> isize;
    fn DestroyWindow(hwnd: isize) -> i32;
    fn DefWindowProcW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
    fn GetMessageW(msg: *mut Msg, hwnd: isize, min: u32, max: u32) -> i32;
    fn DispatchMessageW(msg: *const Msg) -> isize;
    fn PostQuitMessage(code: i32);
    fn PostThreadMessageW(thread: u32, msg: u32, wparam: usize, lparam: isize) -> i32;
    fn GetSystemMetrics(index: i32) -> i32;
    fn SetForegroundWindow(hwnd: isize) -> i32;
}

#[link(name = "gdi32")]
unsafe extern "system" {
    fn CreateSolidBrush(color: u32) -> isize;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetModuleHandleW(name: *const u16) -> isize;
    fn GetCurrentThreadId() -> u32;
}

const WS_POPUP: u32 = 0x8000_0000;
const WS_VISIBLE: u32 = 0x1000_0000;
const WM_DESTROY: u32 = 0x0002;
const WM_APP: u32 = 0x8000;
const SPLASH_GONE: u32 = WM_APP;
const FULL_UP: u32 = WM_APP + 1;
const CLOSE: u32 = WM_APP + 2;

/// The full-screen window, whose end ends the program.
static FULL: AtomicIsize = AtomicIsize::new(0);

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

extern "system" fn window_proc(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize {
    if msg == WM_DESTROY && hwnd == FULL.load(Ordering::SeqCst) {
        unsafe { PostQuitMessage(0) };
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// Registers a window class that paints its windows in `colour` (0x00BBGGRR).
fn class(name: &[u16], colour: u32) {
    let class = WndClass {
        style: 0,
        proc_: window_proc,
        cls_extra: 0,
        wnd_extra: 0,
        instance: unsafe { GetModuleHandleW(std::ptr::null()) },
        icon: 0,
        cursor: 0,
        background: unsafe { CreateSolidBrush(colour) },
        menu: std::ptr::null(),
        class: name.as_ptr(),
    };
    unsafe { RegisterClassW(&raw const class) };
}

fn window(class: &[u16], title: &[u16], x: i32, y: i32, w: i32, h: i32) -> isize {
    unsafe { CreateWindowExW(0, class.as_ptr(), title.as_ptr(), WS_POPUP | WS_VISIBLE, x, y, w, h, 0, 0, 0, 0) }
}

/// A splash, a moment with no window, then a window over the whole screen until `close_after`.
fn full_screen(title: &str, close_after: Duration) {
    let (splash_class, full_class, title) = (wide("fixture-splash"), wide("fixture-full"), wide(title));
    class(&splash_class, 0x008f_4d2a);
    class(&full_class, 0x001d_1d6b);
    let (cx, cy) = unsafe { (GetSystemMetrics(0), GetSystemMetrics(1)) };
    let splash = window(&splash_class, &title, (cx - 640) / 2, (cy - 360) / 2, 640, 360);
    let main = unsafe { GetCurrentThreadId() };
    std::thread::spawn(move || {
        for (wait, step) in [(2500, SPLASH_GONE), (1000, FULL_UP), (close_after.as_millis() as u64, CLOSE)] {
            std::thread::sleep(Duration::from_millis(wait));
            unsafe { PostThreadMessageW(main, step, 0, 0) };
        }
    });
    let mut msg = Msg::default();
    while unsafe { GetMessageW(&raw mut msg, 0, 0, 0) } > 0 {
        match msg.message {
            SPLASH_GONE => unsafe {
                DestroyWindow(splash);
            },
            FULL_UP => {
                let full = window(&full_class, &title, 0, 0, cx, cy);
                FULL.store(full, Ordering::SeqCst);
                unsafe { SetForegroundWindow(full) };
            }
            CLOSE => unsafe {
                DestroyWindow(FULL.load(Ordering::SeqCst));
            },
            _ => unsafe {
                DispatchMessageW(&raw const msg);
            },
        }
    }
}

fn main() {
    let close_after = std::env::args().nth(1).and_then(|a| a.parse::<u64>().ok()).map(Duration::from_secs);
    let exe = std::env::current_exe().unwrap();
    let title = exe.file_stem().unwrap().to_string_lossy().into_owned();
    if title.to_lowercase().ends_with("full") {
        return full_screen(&title, close_after.unwrap_or(Duration::from_secs(25)));
    }
    if let Some(after) = close_after {
        std::thread::spawn(move || {
            std::thread::sleep(after);
            std::process::exit(0);
        });
    }
    let text = format!("Fixture game running from\n{}", exe.display());
    unsafe { MessageBoxW(0, wide(&text).as_ptr(), wide(&title).as_ptr(), 0) };
}
