// This process: its single-instance lock, its console, and keeping the PC awake while it waits. And the exe another
// process runs from.

use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::PathBuf;
use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError, HANDLE};
use windows::Win32::System::Console::{ATTACH_PARENT_PROCESS, AttachConsole};
use windows::Win32::System::Power::{ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED, SetThreadExecutionState};
use windows::Win32::System::Threading::{
    CreateMutexW, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::core::{HSTRING, PWSTR};

/// Claims `name` (a named mutex) for this process until it ends. Ok(false) when another process claimed it first;
/// Err when it exists but this process may not open it (another process with more rights claimed it).
pub fn claim(name: &str) -> windows::core::Result<bool> {
    // SAFETY: default security, and the name is an HSTRING that lives until the call returns. The handle is never
    // closed: the open handle is the claim, and Windows closes it when the process ends.
    unsafe { CreateMutexW(None, false, &HSTRING::from(name)) }?;
    // SAFETY: reads this thread's last error, which CreateMutexW just set.
    let error = unsafe { GetLastError() };
    Ok(error != ERROR_ALREADY_EXISTS)
}

/// Shows this process's output in the terminal that started it, if one did.
pub fn attach_parent_console() {
    // SAFETY: takes a constant. It fails when no terminal started the process, which is no error.
    let _ = unsafe { AttachConsole(ATTACH_PARENT_PROCESS) };
}

/// Keeps the PC and the screen awake while the calling thread waits, or lets them sleep again. Applies to the
/// calling thread, so it also ends with the thread.
pub fn keep_awake(on: bool) {
    let flags = if on { ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED } else { ES_CONTINUOUS };
    // SAFETY: takes flags and returns the previous ones.
    unsafe { SetThreadExecutionState(flags) };
}

/// The full path of the exe process `pid` runs. It asks only for the right to query a process's basic facts, which
/// Windows also grants on processes with more rights than this one (run as administrator). None for a process that
/// has gone, or that Windows protects.
pub fn exe_path(pid: u32) -> Option<PathBuf> {
    // SAFETY: takes plain values; the handle it returns is owned below.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    // SAFETY: the handle was just opened for this function, and nothing else owns or closes it.
    let handle = unsafe { OwnedHandle::from_raw_handle(handle.0) };
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    // SAFETY: the call is told the buffer's length in `len`, writes at most that, and sets `len` to what it wrote.
    unsafe {
        QueryFullProcessImageNameW(
            HANDLE(handle.as_raw_handle()),
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &raw mut len,
        )
    }
    .ok()?;
    Some(PathBuf::from(OsString::from_wide(&buf[..len as usize])))
}
