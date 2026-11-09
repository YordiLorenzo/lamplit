// Steam's service repair needs admin rights. Sign-in tasks are managed separately, without elevation (startup.rs).

use crate::error::{Error, Result};
use crate::events::{self, Event};
use crate::win::{drives, shell, token, trust};
use std::fs::File;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::AppHandle;
use windows::Win32::Storage::FileSystem::FILE_SHARE_READ;
use winreg::RegKey;
use winreg::enums::HKEY_LOCAL_MACHINE;

/// The argument that makes lamplit.exe run setup.
pub const FLAG: &str = "--setup";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Repairs Steam's service with Valve's signed executable.
///
/// # Errors
///
/// Without admin rights, a trusted repair executable, or a successful repair.
pub fn run() -> Result<Vec<String>> {
    if !token::elevated() {
        let message = "Repairing Steam's background service needs admin rights. Start it from Lamplit's settings.";
        return Err(Error::Player(message.into()));
    }
    let steam = repair_steam_service()?;
    log::info!("setup: {steam}");
    Ok(vec![steam])
}

/// Valve's own repair: `<Steam>\bin\SteamService.exe /repair` reinstalls the service and its permissions, also when
/// the copy in Common Files is missing. Steam's own repair prompt runs this file too. It runs with admin rights, and
/// Steam lets every account on the PC write to its folder, so the exe must carry Valve's signature, and the file that
/// was checked is the one that runs: it stays open (unchangeable) from the check until it has run, and runs from the
/// path that handle really has, so a junction swapped in along the way can't point somewhere else.
fn repair_steam_service() -> Result<String> {
    let Some(steam) = steam_install_path().filter(|p| p.join("steam.exe").is_file()) else {
        return Ok("Steam isn't installed on this PC's drives; nothing to repair".into());
    };
    let service = steam.join(r"bin\SteamService.exe");
    let cant_run = |e: std::io::Error| Error::Internal(format!("{}: {e}", service.display()));
    let held = std::fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ.0).open(&service).map_err(cant_run)?;
    let real = trust::final_path(&held)
        .ok_or_else(|| Error::Internal(format!("{}: Windows can't tell where it is", service.display())))?;
    signed_by_valve(&real, &held)?;
    let out = Command::new(&real).arg("/repair").creation_flags(CREATE_NO_WINDOW).output().map_err(cant_run)?;
    drop(held);
    if !out.status.success() {
        let said = String::from_utf8_lossy(&out.stderr);
        let code = out.status.code().unwrap_or(-1);
        return Err(Error::Internal(format!("Steam's service repair failed (exit {code}): {}", said.trim())));
    }
    Ok("Steam's background service repaired".into())
}

/// The name on the certificate Valve signs Steam with.
const VALVE: &str = "Valve Corp.";

/// Where Steam's installer put it, when that is on a fixed drive of this PC. Every account on the PC can change this
/// value (Steam's service gives them its key), so Valve's signature on what runs from there is the only protection.
/// A path anywhere else isn't followed at all: just looking for a file on a network share would sign this elevated
/// process in to that server with the administrator's account.
fn steam_install_path() -> Option<PathBuf> {
    let key = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\WOW6432Node\Valve\Steam").ok()?;
    let path = PathBuf::from(key.get_value::<String, _>("InstallPath").ok()?);
    drives::fixed().iter().any(|root| path.starts_with(root)).then_some(path)
}

/// Ok when the open file has a valid Authenticode signature from Valve.
fn signed_by_valve(path: &Path, file: &File) -> Result<()> {
    let problem = match trust::signer(path, file) {
        Ok(name) if name == VALVE => return Ok(()),
        Ok(name) => format!("is signed by {name}, not {VALVE}"),
        Err(0) => "has a valid signature that names no signer".to_string(),
        Err(status) => format!("has no valid signature (0x{status:08X})"),
    };
    Err(Error::Internal(format!("{} {problem}; not running it", path.display())))
}

/// Starts Steam's repair through Windows' admin prompt and tells the page when it ends.
pub fn start_elevated(app: AppHandle) -> Result<()> {
    let exe = std::env::current_exe()?;
    let setup = shell::run_as_admin(exe.as_os_str(), FLAG)
        .map_err(|_| Error::Player("Windows didn't start the repair (the admin prompt was declined?)".into()))?;
    std::thread::spawn(move || {
        let outcome = match setup.wait() {
            Some(0) => "Steam's background service repair finished.".to_string(),
            code => {
                log::warn!(
                    "Steam service repair failed (exit code {code:?}): setup.log of the account that ran it says why"
                );
                "Steam's repair didn't finish. The administrator's setup.log says why.".to_string()
            }
        };
        events::emit(&app, Event::Notice(outcome));
    });
    Ok(())
}
