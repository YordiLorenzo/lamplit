// A stand-in game for testing Lamplit: one window titled after the exe, open until closed.
// With an argument N it closes itself after N seconds.
#![windows_subsystem = "windows"]

#[link(name = "user32")]
unsafe extern "system" {
    fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn main() {
    if let Some(secs) = std::env::args().nth(1).and_then(|a| a.parse::<u64>().ok()) {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(secs));
            std::process::exit(0);
        });
    }
    let exe = std::env::current_exe().unwrap();
    let title = exe.file_stem().unwrap().to_string_lossy().into_owned();
    let text = format!("Fixture game running from\n{}", exe.display());
    unsafe { MessageBoxW(0, wide(&text).as_ptr(), wide(&title).as_ptr(), 0) };
}
