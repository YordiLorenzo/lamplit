// Who this process runs as: the account's SID, and whether it has admin rights.

use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows::Win32::Foundation::{E_FAIL, HANDLE, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows::Win32::Security::{GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::UI::Shell::IsUserAnAdmin;
use windows::core::{Error, PWSTR, Result};

/// The process runs with admin rights.
pub fn elevated() -> bool {
    // SAFETY: takes nothing and returns a value.
    unsafe { IsUserAnAdmin() }.as_bool()
}

/// This account's SID as text, e.g. "S-1-5-21-…-1001".
pub fn user_sid() -> Result<String> {
    let mut token = HANDLE::default();
    // SAFETY: the current process's pseudo handle needs no closing, and token is a valid place for the new handle.
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw mut token) }?;
    // SAFETY: the token's handle was just opened for this function, and nothing else owns or closes it.
    let token = unsafe { OwnedHandle::from_raw_handle(token.0) };
    // Of u64s, so the TOKEN_USER read into it is aligned.
    let mut buf = vec![0u64; 32];
    let mut len = 0u32;
    let size = size_of_val(buf.as_slice()) as u32;
    // SAFETY: the buffer is `size` bytes and aligned for TOKEN_USER; the call fails rather than write past it.
    unsafe {
        GetTokenInformation(HANDLE(token.as_raw_handle()), TokenUser, Some(buf.as_mut_ptr().cast()), size, &raw mut len)
    }?;
    // SAFETY: the call succeeded, so the buffer starts with a TOKEN_USER whose SID points into the same buffer.
    let user = unsafe { &*buf.as_ptr().cast::<TOKEN_USER>() };
    let mut text = PWSTR::null();
    // SAFETY: the SID is valid while `buf` lives. The text Windows allocates is copied, then freed once with LocalFree.
    unsafe {
        ConvertSidToStringSidW(user.User.Sid, &raw mut text)?;
        let sid = text.to_string().map_err(|_| Error::from(E_FAIL));
        let _ = LocalFree(Some(HLOCAL(text.0.cast())));
        sid
    }
}
