// The report uses Windows' Downloads location, including when the account moved it to another drive.

use std::path::PathBuf;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::WindowsProgramming::GetUserNameW;
use windows::Win32::UI::Shell::{FOLDERID_Downloads, KF_FLAG_DEFAULT, SHGetKnownFolderPath};
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CMONITORS};
use windows::core::{PWSTR, Result};
use winreg::{RegKey, enums::HKEY_LOCAL_MACHINE};

pub fn downloads() -> Result<PathBuf> {
    // SAFETY: the GUID is valid, and no token means the current account. Windows allocates the returned string.
    let path = unsafe { SHGetKnownFolderPath(&FOLDERID_Downloads, KF_FLAG_DEFAULT, None) }?;
    // SAFETY: success returned a NUL-terminated string. Copy it before freeing its allocation, also on a UTF-16 error.
    let copied = unsafe { path.to_string() };
    // SAFETY: SHGetKnownFolderPath allocates with the COM task allocator; this is its only free.
    unsafe { CoTaskMemFree(Some(path.0.cast())) };
    copied.map(PathBuf::from)
}

pub fn username() -> Result<String> {
    // UNLEN is 256 characters; GetUserNameW also writes the terminating NUL.
    let mut name = [0u16; 257];
    let mut size = name.len() as u32;
    // SAFETY: name has room for size UTF-16 units; size points to a live u32.
    unsafe { GetUserNameW(Some(PWSTR(name.as_mut_ptr())), &raw mut size) }?;
    Ok(String::from_utf16_lossy(&name[..size as usize - 1]))
}

pub fn screens() -> i32 {
    // SAFETY: GetSystemMetrics has no pointer arguments; SM_CMONITORS counts active display monitors.
    unsafe { GetSystemMetrics(SM_CMONITORS) }
}

pub fn windows_version() -> std::io::Result<String> {
    let version = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")?;
    let build: String = version.get_value("CurrentBuildNumber")?;
    let revision: u32 = version.get_value("UBR")?;
    let release: String = version.get_value("DisplayVersion")?;
    // ProductName still says Windows 10 on Windows 11. Its first public build was 22000.
    let number = build.parse::<u32>().map_err(std::io::Error::other)?;
    let name = if number >= 22_000 { "Windows 11" } else { "Windows 10" };
    Ok(format!("{name} {release}, build {build}.{revision}"))
}
