// The same ordered restoration for Settings and the uninstaller. Failed steps keep their originals on disk.

use super::{quiet, startup};
use crate::error::Result;
use crate::prefs;
use crate::stores::steam::devtools;
use parking_lot::Mutex;
use serde::Serialize;

pub const FLAG: &str = "--restore";
pub const NO_PROMPT_FLAG: &str = "--no-prompt";

/// Upkeep and the switches hold this too: none may reapply settings during a restore.
pub static CHANGES: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize)]
pub struct Step {
    pub name: String,
    pub restored: bool,
    pub message: String,
}

fn step(name: &str, outcome: Result<String>) -> Step {
    let restored = outcome.is_ok();
    let message = outcome.unwrap_or_else(|e| e.to_string());
    log::info!("restore: {name}: {message} (restored {restored})");
    Step { name: name.into(), restored, message }
}

pub fn run(allow_prompt: bool, stop_steam: impl FnOnce() -> Result<bool>, mut report: impl FnMut(&Step)) -> Vec<Step> {
    let _changes = CHANGES.lock();
    let mut steps = Vec::new();
    let mut tell = |name, outcome| {
        let next = step(name, outcome);
        report(&next);
        steps.push(next);
    };
    let stopped = stop_steam();
    tell("Quiet mode", quiet::restore());
    match stopped {
        Ok(opened_port) => match devtools::begin_restore(opened_port) {
            Ok(()) => {
                tell("Steam's Guide button", devtools::restore_guide());
                tell("Steam's DevTools port", quiet::steam_pending().and_then(devtools::restore_port));
            }
            Err(e) => tell("Steam settings", Err(e)),
        },
        Err(e) => tell("Steam preferences", Err(e)),
    }
    tell("Start when I sign in", startup::remove(allow_prompt).map(|()| "Sign-in task removed.".into()));
    steps
}

/// No window, no background threads, and only the old task deletion may request elevation.
#[must_use]
pub fn headless(allow_prompt: bool) -> bool {
    // A separate process cannot change the live app's in-memory prefs. Claim its slot until restoration ends.
    match crate::win::process::claim(&format!("Local\\{}-app", crate::APP)) {
        Ok(true) => {}
        Ok(false) => {
            log::error!("Close Lamplit, then run --restore again.");
            return false;
        }
        Err(e) => {
            log::error!("Couldn't check whether Lamplit is closed: {e}");
            return false;
        }
    }
    run(allow_prompt, prefs::stop_steam_changes, |_| {}).iter().all(|step| step.restored)
}

/// A pending Steam restore finishes after quiet mode, before the port's flag is put back.
pub fn catch_up() {
    match devtools::restoring() {
        Ok(true) => {
            let _ = devtools::restore_guide();
            if let Err(e) = quiet::steam_pending().and_then(devtools::restore_port) {
                log::info!("Steam restore still waiting: {e}");
            }
        }
        Ok(false) => {}
        Err(e) => log::warn!("Couldn't read Steam's restore record: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;

    #[test]
    fn a_pending_step_reaches_the_page_without_claiming_success() {
        let pending = step("Quiet mode", Err(Error::Player("Close Ubisoft Connect, then try again.".into())));
        assert_eq!(serde_json::to_value(&pending).unwrap(), ipc_fixture!("restore-step"));
        assert!(!pending.restored);
        assert!(step("Quiet mode", Ok("Restored.".into())).restored);
    }
}
