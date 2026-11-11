// Known folders follow the player's moved Videos and Captures locations without creating either folder.

use std::path::PathBuf;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Environment::ExpandEnvironmentStringsW;
use windows::Win32::UI::Shell::{FOLDERID_AppCaptures, FOLDERID_Videos, KF_FLAG_DONT_VERIFY, SHGetKnownFolderPath};
use windows::core::{GUID, PCWSTR, Result};

fn known(id: &GUID) -> Result<PathBuf> {
    // SAFETY: id is a known-folder GUID; no token selects the current account. Windows allocates the string.
    let path = unsafe { SHGetKnownFolderPath(id, KF_FLAG_DONT_VERIFY, None) }?;
    // SAFETY: success returned a NUL-terminated string, copied before its allocation is freed.
    let copied = unsafe { path.to_string() };
    // SAFETY: SHGetKnownFolderPath uses the COM task allocator, and this is the only free.
    unsafe { CoTaskMemFree(Some(path.0.cast())) };
    Ok(PathBuf::from(copied?))
}

pub fn videos() -> Result<PathBuf> {
    known(&FOLDERID_Videos)
}

pub fn gamebar() -> Result<PathBuf> {
    known(&FOLDERID_AppCaptures)
}

pub fn expand(value: &str) -> Result<PathBuf> {
    let input: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
    // SAFETY: input is NUL-terminated; no destination asks for the required size, including its NUL.
    let size = unsafe { ExpandEnvironmentStringsW(PCWSTR(input.as_ptr()), None) };
    if size == 0 {
        return Err(windows::core::Error::from_thread());
    }
    let mut output = vec![0; size as usize];
    // SAFETY: input lives through the call; output is a writable buffer whose size the wrapper passes to Windows.
    let written = unsafe { ExpandEnvironmentStringsW(PCWSTR(input.as_ptr()), Some(&mut output)) };
    if written == 0 || written > size {
        return Err(windows::core::Error::from_thread());
    }
    Ok(PathBuf::from(String::from_utf16_lossy(&output[..written as usize - 1])))
}
