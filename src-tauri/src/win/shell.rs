// Opening exes, files and links the way Explorer does (ShellExecute), and starting an exe through the admin prompt.
// Both run on a thread of their own, one call at a time. ShellExecute can take long (a packaged app activating, the
// admin prompt of an exe that asks for one), and the thread that runs Lamplit's window must not wait for it.

use std::ffi::OsStr;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::sync::LazyLock;
use std::sync::mpsc;
use windows::Win32::Foundation::{E_HANDLE, HANDLE};
use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx};
use windows::Win32::System::Threading::{GetExitCodeProcess, INFINITE, WaitForSingleObject};
use windows::Win32::UI::Shell::{SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW, ShellExecuteW};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
use windows::core::{Error, HSTRING, PCWSTR, Result, w};

type Job = Box<dyn FnOnce() + Send>;

/// Runs `job` on the shell thread and returns its answer. That thread sets COM up the way ShellExecute asks for (a
/// single-threaded apartment without OLE1 DDE), which `shell:` and store links need.
fn on_shell_thread<T: Send + 'static>(job: impl FnOnce() -> T + Send + 'static) -> T {
    static SHELL: LazyLock<mpsc::Sender<Job>> = LazyLock::new(|| {
        let (tx, rx) = mpsc::channel::<Job>();
        std::thread::spawn(move || {
            // SAFETY: the reserved pointer is None as required. The result only says whether COM was set up already.
            let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
            for job in rx {
                job();
            }
        });
        tx
    });
    let (tx, rx) = mpsc::channel();
    SHELL.send(Box::new(move || drop(tx.send(job())))).expect("the shell thread runs as long as Lamplit");
    rx.recv().expect("the shell thread answers every job")
}

/// Opens `file` (an exe, a document or a link) as Explorer's Open does. Err is ShellExecute's error code: 2 or 3 for
/// a file that isn't there, 31 for a link no app is set up to open.
pub fn open(file: &OsStr, args: Option<&str>, dir: Option<&Path>) -> std::result::Result<(), isize> {
    let file = HSTRING::from(file);
    let (args, dir) = (args.map(HSTRING::from), dir.map(|d| HSTRING::from(d.as_os_str())));
    let code = on_shell_thread(move || {
        let ptr = |s: &Option<HSTRING>| s.as_ref().map_or(PCWSTR::null(), |s| PCWSTR(s.as_ptr()));
        // SAFETY: every string is NUL-terminated and lives until the call returns; a null one means none.
        unsafe { ShellExecuteW(None, w!("open"), &file, ptr(&args), ptr(&dir), SW_SHOWNORMAL) }.0 as isize
    });
    if code > 32 { Ok(()) } else { Err(code) }
}

/// A process started through the admin prompt, to wait for.
pub struct Elevated(OwnedHandle);

impl Elevated {
    /// Waits for the process to end and returns its exit code; None when Windows can't say.
    pub fn wait(self) -> Option<u32> {
        let process = HANDLE(self.0.as_raw_handle());
        let mut code = 0u32;
        // SAFETY: the handle is open until `self` drops at the end of this function, and code is a valid place for
        // the answer.
        unsafe {
            WaitForSingleObject(process, INFINITE);
            GetExitCodeProcess(process, &raw mut code).ok()?;
        }
        Some(code)
    }
}

/// Starts `exe` with `args` through Windows' admin prompt, which blocks until the prompt is answered. Err when the
/// exe didn't start, as when the prompt was declined.
pub fn run_as_admin(exe: &OsStr, args: &str) -> Result<Elevated> {
    let (verb, file, args) = (HSTRING::from("runas"), HSTRING::from(exe), HSTRING::from(args));
    on_shell_thread(move || {
        let mut info = SHELLEXECUTEINFOW {
            cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS,
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(args.as_ptr()),
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        };
        // SAFETY: info is a complete SHELLEXECUTEINFOW of the size it states, and its strings live until the call
        // returns.
        unsafe { ShellExecuteExW(&raw mut info) }?;
        // Windows leaves the handle out when it handed the file to an already running app instead of starting one.
        if info.hProcess.is_invalid() {
            return Err(Error::from(E_HANDLE));
        }
        // SAFETY: SEE_MASK_NOCLOSEPROCESS hands the new process's handle to the caller, and nothing else owns or
        // closes it.
        Ok(Elevated(unsafe { OwnedHandle::from_raw_handle(info.hProcess.0) }))
    })
}
