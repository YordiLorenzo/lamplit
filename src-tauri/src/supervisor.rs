// Lamplit runs as a child of itself so a crash brings it back: Task Scheduler only restarts a task that fails to
// start, not one that dies later. Closing Lamplit (exit code 0) ends both.

use std::time::{Duration, Instant};

/// The argument that makes lamplit.exe the app rather than its supervisor.
pub const CHILD_FLAG: &str = "--app";

pub fn run() {
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(e) => return log::error!("can't find lamplit.exe: {e}"),
    };
    let mut crashes: Vec<Instant> = Vec::new();
    loop {
        match std::process::Command::new(&exe).arg(CHILD_FLAG).status() {
            Ok(status) if status.success() => return log::info!("Lamplit closed"),
            Ok(status) => log::warn!("Lamplit stopped ({status}); starting it again"),
            Err(e) => return log::error!("can't start Lamplit: {e}"),
        }
        crashes.retain(|t| t.elapsed() < Duration::from_mins(2));
        crashes.push(Instant::now());
        if crashes.len() >= 5 {
            return log::error!("Lamplit stopped 5 times in 2 minutes; giving up until the next sign-in");
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}
