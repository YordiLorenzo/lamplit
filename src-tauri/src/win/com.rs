// COM, which Core Audio and Task Scheduler are reached through.

use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};

/// Sets COM up on the calling thread. Lamplit calls COM from threads it doesn't own (Tauri's thread pool), which may
/// not have it yet; on a thread that has it already, this changes nothing.
pub fn initialize() {
    // SAFETY: the reserved pointer is None as required. The result only says whether COM was set up already.
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
}
