// The PC's drives.

use std::path::PathBuf;
use windows::Win32::Storage::FileSystem::GetDriveTypeW;
use windows::core::HSTRING;

/// The fixed drives' roots (C:\ and so on), not removable, network or optical ones.
pub fn fixed() -> Vec<PathBuf> {
    const DRIVE_FIXED: u32 = 3;
    (b'C'..=b'Z')
        .map(|l| format!("{}:\\", l as char))
        // SAFETY: the root is an HSTRING that lives until the call returns.
        .filter(|root| unsafe { GetDriveTypeW(&HSTRING::from(root.as_str())) } == DRIVE_FIXED)
        .map(PathBuf::from)
        .collect()
}
