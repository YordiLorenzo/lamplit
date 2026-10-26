// Sleep, restart and shut down. Windows does these for a program only while the shutdown privilege is enabled in its
// token. A standard account holds that privilege, disabled, so this process enables it first.

use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows::Win32::Foundation::{GetLastError, HANDLE, LUID, WIN32_ERROR};
use windows::Win32::Security::{
    AdjustTokenPrivileges, LUID_AND_ATTRIBUTES, LookupPrivilegeValueW, SE_PRIVILEGE_ENABLED, SE_SHUTDOWN_NAME,
    TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES,
};
use windows::Win32::System::Power::SetSuspendState;
use windows::Win32::System::Shutdown::{
    InitiateShutdownW, SHTDN_REASON_FLAG_PLANNED, SHTDN_REASON_MAJOR_OTHER, SHTDN_REASON_MINOR_OTHER, SHUTDOWN_FLAGS,
    SHUTDOWN_POWEROFF, SHUTDOWN_RESTART,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::core::{Error, PCWSTR, Result};

/// Puts the PC to sleep, not into hibernation. Returns once it has woken up.
pub fn sleep() -> Result<()> {
    enable_shutdown_privilege()?;
    // SAFETY: takes plain values: sleep rather than hibernate, `force` (ignored since Windows Vista), and wake events
    // (a controller, a timer) still allowed. It returns false and sets the last error when the PC can't sleep.
    if unsafe { SetSuspendState(false, false, false) } { Ok(()) } else { Err(Error::from_thread()) }
}

pub fn restart() -> Result<()> {
    shut_down_with(SHUTDOWN_RESTART)
}

/// A full shutdown. Fast startup's hybrid one (SHUTDOWN_HYBRID) needs hibernation, which a PC may have off.
pub fn shut_down() -> Result<()> {
    shut_down_with(SHUTDOWN_POWEROFF)
}

/// Starts the shutdown and returns. As with the Start menu, apps are asked to close and may hold it up (an unsaved
/// document). It fails rather than sign out another account that is signed in (no SHUTDOWN_FORCE_OTHERS).
fn shut_down_with(flags: SHUTDOWN_FLAGS) -> Result<()> {
    enable_shutdown_privilege()?;
    let reason = SHTDN_REASON_MAJOR_OTHER | SHTDN_REASON_MINOR_OTHER | SHTDN_REASON_FLAG_PLANNED;
    // SAFETY: a null machine name means this PC and a null message shows none; the rest are plain values. A grace
    // period of 0 starts at once. It returns an error code.
    WIN32_ERROR(unsafe { InitiateShutdownW(PCWSTR::null(), PCWSTR::null(), 0, flags, reason) }).ok()
}

/// Enables the shutdown privilege in this process's token. A policy can take the privilege away from an account,
/// and then this fails with ERROR_NOT_ALL_ASSIGNED.
fn enable_shutdown_privilege() -> Result<()> {
    let mut luid = LUID::default();
    // SAFETY: a null system name means this PC, the name is a constant string, and luid is a valid place for the answer.
    unsafe { LookupPrivilegeValueW(PCWSTR::null(), SE_SHUTDOWN_NAME, &raw mut luid) }?;
    let mut token = HANDLE::default();
    // SAFETY: the current process's pseudo handle needs no closing, and token is a valid place for the new handle.
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES, &raw mut token) }?;
    // SAFETY: the token's handle was just opened for this function, and nothing else owns or closes it.
    let token = unsafe { OwnedHandle::from_raw_handle(token.0) };
    let enable = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        Privileges: [LUID_AND_ATTRIBUTES { Luid: luid, Attributes: SE_PRIVILEGE_ENABLED }],
    };
    // SAFETY: `enable` holds the one privilege it counts and lives until the call returns; the previous state isn't
    // asked for, so no buffer goes with it.
    unsafe { AdjustTokenPrivileges(HANDLE(token.as_raw_handle()), false, Some(&raw const enable), 0, None, None) }?;
    // A token without the privilege still succeeds, and says so only in the last error.
    // SAFETY: reads this thread's last error, which AdjustTokenPrivileges just set: ERROR_SUCCESS or
    // ERROR_NOT_ALL_ASSIGNED.
    unsafe { GetLastError() }.ok()
}
