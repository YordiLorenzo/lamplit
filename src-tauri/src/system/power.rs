// Sleep, restart and shut down, from Settings > Power. win/power.rs asks Windows; this file logs it and turns a
// refusal into words for the player.

use crate::error::{Error, Result};
use crate::win;
use windows::Win32::Foundation::{
    ERROR_NOT_ALL_ASSIGNED, ERROR_PRIVILEGE_NOT_HELD, ERROR_SHUTDOWN_IN_PROGRESS, ERROR_SHUTDOWN_IS_SCHEDULED,
    ERROR_SHUTDOWN_USERS_LOGGED_ON, WIN32_ERROR,
};

/// Returns once the PC has woken up again.
pub fn sleep() -> Result<()> {
    log::info!("power: sleep, from Settings");
    win::power::sleep().map_err(|e| refused("go to sleep", &e))?;
    log::info!("power: awake again");
    Ok(())
}

pub fn restart() -> Result<()> {
    log::info!("power: restart, from Settings");
    win::power::restart().map_err(|e| refused("restart", &e))
}

pub fn shut_down() -> Result<()> {
    log::info!("power: shut down, from Settings");
    win::power::shut_down().map_err(|e| refused("shut down", &e))
}

fn refused(what: &str, e: &windows::core::Error) -> Error {
    log::warn!("power: Windows didn't {what}: {e}");
    let next = match WIN32_ERROR::from_error(e) {
        // Lamplit doesn't force it: that would sign the other account out and lose its unsaved work.
        Some(ERROR_SHUTDOWN_USERS_LOGGED_ON) => "Another Windows account is signed in on this PC: sign it out first.",
        Some(ERROR_SHUTDOWN_IN_PROGRESS | ERROR_SHUTDOWN_IS_SCHEDULED) => "Windows is already shutting down.",
        // A policy took the shutdown privilege away from this account.
        Some(ERROR_NOT_ALL_ASSIGNED | ERROR_PRIVILEGE_NOT_HELD) => "Your Windows account isn't allowed to.",
        _ => "Try it from the Start menu.",
    };
    Error::Player(format!("Windows didn't {what}. {next}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_why_windows_refused() {
        let text = |what, code: WIN32_ERROR| refused(what, &code.into()).to_string();
        assert_eq!(
            text("shut down", ERROR_SHUTDOWN_USERS_LOGGED_ON),
            "Windows didn't shut down. Another Windows account is signed in on this PC: sign it out first."
        );
        assert_eq!(
            text("restart", ERROR_NOT_ALL_ASSIGNED),
            "Windows didn't restart. Your Windows account isn't allowed to."
        );
        // ERROR_NOT_SUPPORTED: no sleep state on this PC, say.
        assert_eq!(text("go to sleep", WIN32_ERROR(50)), "Windows didn't go to sleep. Try it from the Start menu.");
    }
}
