// Authenticode: whether a file carries a valid signature, and whose it is (WinVerifyTrust). And where an open file
// really is, so the file that was checked is the one that runs.

use std::fs::File;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use windows::Win32::Foundation::{HANDLE, HWND};
use windows::Win32::Security::Cryptography::{CERT_NAME_SIMPLE_DISPLAY_TYPE, CertGetNameStringW};
use windows::Win32::Security::WinTrust::{
    WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO, WTD_CHOICE_FILE,
    WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE, WTHelperGetProvSignerFromChain,
    WTHelperProvDataFromStateData, WinVerifyTrust,
};
use windows::Win32::Storage::FileSystem::{FILE_NAME_NORMALIZED, GetFinalPathNameByHandleW};
use windows::core::PCWSTR;

/// Where the open `file` really is: a drive path with every junction and link along it resolved. While the file is
/// open without write or delete sharing, neither it nor the folders on that path can be renamed or replaced, so
/// running this path runs this file. None when Windows can't say, or the file is on a network share.
pub fn final_path(file: &File) -> Option<PathBuf> {
    let mut buf = [0u16; 1024];
    // SAFETY: the handle is open while `file` lives, and the call writes at most the buffer's length. The flags
    // (0) ask for the path with junctions resolved, on its drive letter.
    let len =
        unsafe { GetFinalPathNameByHandleW(HANDLE(file.as_raw_handle()), &mut buf, FILE_NAME_NORMALIZED) } as usize;
    // 0 is a failure, and a length past the buffer is the size it would have needed.
    if len == 0 || len >= buf.len() {
        return None;
    }
    let path = String::from_utf16(&buf[..len]).ok()?;
    // Windows answers in the \\?\ form (\\?\UNC\ for a share); a process starts from the plain drive path.
    path.strip_prefix(r"\\?\").filter(|p| !p.starts_with(r"UNC\")).map(PathBuf::from)
}

/// The signer's name on the valid Authenticode signature of `file`, which is open at `path`. Holding it open keeps
/// its content from changing; `final_path` gives the path that runs this same file. Err is WinVerifyTrust's status,
/// or 0 when the signature is valid but names no signer.
pub fn signer(path: &Path, file: &File) -> Result<String, i32> {
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut info = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: PCWSTR(wide.as_ptr()),
        hFile: HANDLE(file.as_raw_handle()),
        ..Default::default()
    };
    let mut data = WINTRUST_DATA {
        cbStruct: size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 { pFile: &raw mut info },
        dwStateAction: WTD_STATEACTION_VERIFY,
        ..Default::default()
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    // SAFETY: data, info and the path they point to live until the second call has closed the check. The signer's
    // name is read while the check is still open, from the state data that check returned.
    unsafe {
        let status = WinVerifyTrust(HWND::default(), &raw mut action, (&raw mut data).cast());
        let signer = if status == 0 { signer_name(data.hWVTStateData) } else { None };
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        WinVerifyTrust(HWND::default(), &raw mut action, (&raw mut data).cast());
        signer.ok_or(status)
    }
}

/// The signer's name from a WinVerifyTrust check that is still open.
///
/// # Safety
///
/// `state` is the `hWVTStateData` of a check that hasn't been closed yet.
unsafe fn signer_name(state: HANDLE) -> Option<String> {
    // SAFETY: the caller keeps the check open, so the provider data and the certificate chain stay valid while
    // they are read; a null pointer at any step means there is nothing to read.
    unsafe {
        let provider = WTHelperProvDataFromStateData(state);
        if provider.is_null() {
            return None;
        }
        let signer = WTHelperGetProvSignerFromChain(provider, 0, false, 0).as_ref()?;
        // The first certificate in the chain is the signer's own.
        let cert = signer.pasCertChain.as_ref()?.pCert;
        let mut name = [0u16; 256];
        let len = CertGetNameStringW(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, None, Some(&mut name)) as usize;
        (len > 1).then(|| String::from_utf16_lossy(&name[..len - 1]))
    }
}

#[cfg(test)]
mod tests {
    use crate::files::folder_key;
    use std::fs::File;

    #[test]
    fn finds_where_an_open_file_is() {
        let exe = std::env::current_exe().unwrap();
        let found = super::final_path(&File::open(&exe).unwrap()).unwrap();
        assert_eq!(folder_key(&found), folder_key(&exe));
    }
}
