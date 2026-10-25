// First-time setup: the few things that need admin rights, done once so Lamplit never shows a Windows admin prompt
// (a controller can't answer one: it runs on Windows' secure desktop). Run `lamplit.exe --setup` from an elevated
// terminal, or from Lamplit's settings, which asks Windows once.
//
//   1. Steam's background service ("Steam Client Service") repaired: Steam asks for admin rights whenever it can't
//      start or update that service itself.
//   2. Lamplit's logon task: Lamplit starts at sign-in in the desktop session (its supervisor restarts it after a crash).
//
// On a standard account the admin prompt signs in an administrator, and the elevated process runs as that account.
// So the settings screen names its own account (`--for <SID>`) for the logon task, and records setup as done in its
// own data folder once the elevated process has succeeded. Each account has its own logon task.

use crate::APP;
use crate::data;
use crate::error::{Error, Result};
use crate::events::{self, Event};
use crate::files::folder_key;
use crate::win::{drives, shell, task, token, trust};
use serde::{Deserialize, Serialize};
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
/// Followed by the SID of the account to set up, when that isn't the account setup runs as.
pub const FOR_FLAG: &str = "--for";

/// Raise when setup gains a step, so PCs set up before get asked again.
const VERSION: u32 = 1;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Done {
    version: u32,
    /// The lamplit.exe the logon task starts. A Lamplit that was moved or copied since needs setup again.
    exe: PathBuf,
}

#[derive(Clone, Serialize)]
pub struct Status {
    pub needed: bool,
}

const DONE: &str = "setup.json";

pub fn status() -> Status {
    let done: Done = data::load_or_default(DONE);
    let moved = !std::env::current_exe().is_ok_and(|exe| folder_key(&exe) == folder_key(&done.exe));
    Status { needed: done.version < VERSION || moved }
}

fn record_done() -> Result<()> {
    data::save(DONE, &Done { version: VERSION, exe: std::env::current_exe()? })
}

/// Runs every step for the account with SID `for_user`, or for this one, and returns what it did, one line each.
/// Setup is done once the logon task is registered: a Steam problem is reported, but must not cost the player
/// Lamplit's start at sign-in. Only setup for this account records itself; for another account, that account's
/// Lamplit does (see `start_elevated`).
///
/// # Errors
///
/// Without admin rights, or when the logon task can't be registered.
pub fn run(for_user: Option<String>) -> Result<Vec<String>> {
    if !token::elevated() {
        let message = "Setup needs admin rights: run it from an elevated terminal, or from Lamplit's settings.";
        return Err(Error::Player(message.into()));
    }
    let steam = repair_steam_service().unwrap_or_else(|e| format!("Steam's background service wasn't repaired: {e}"));
    log::info!("setup: {steam}");
    let user = match &for_user {
        Some(sid) => sid.clone(),
        None => token::user_sid().map_err(|e| Error::Internal(format!("couldn't read this account's SID: {e}")))?,
    };
    let task = register_logon_task(&user)?;
    log::info!("setup: {task}");
    if for_user.is_none() {
        record_done()?;
    }
    Ok(vec![steam, task])
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

/// The task Lamplit starts from when the account with SID `user` signs in. Named after the account, so setting up a
/// second account doesn't take the first one's start away.
fn register_logon_task(user: &str) -> Result<String> {
    let exe = std::env::current_exe()?;
    let name = format!("{APP}-{user}");
    task::register_logon_task(&name, &task_xml(user, &exe))
        .map_err(|e| Error::Internal(format!("couldn't register the logon task: {e}")))?;
    Ok(format!("logon task '{name}' starts {}", exe.display()))
}

/// The logon task: `exe` at `user`'s sign-in, in the desktop session, with the account's normal rights, no time
/// limit, never twice. Task Scheduler takes the account as a SID: a "DOMAIN\name" fails in an SSH session, where
/// Windows sets USERDOMAIN to "WORKGROUP" (error 0x80070534).
fn task_xml(user: &str, exe: &Path) -> String {
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Lamplit: the full-screen game home screen</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>{exe}</Command><WorkingDirectory>{dir}</WorkingDirectory></Exec></Actions>
</Task>"#,
        user = esc(user),
        exe = esc(&exe.display().to_string()),
        dir = esc(&exe.parent().map(|d| d.display().to_string()).unwrap_or_default()),
    )
}

/// Starts setup for this account through Windows' admin prompt (the one time a keyboard or mouse is needed). Once
/// the elevated process ends, records setup as done if it succeeded, and tells the page how it went.
pub fn start_elevated(app: AppHandle) -> Result<()> {
    let exe = std::env::current_exe()?;
    let user = token::user_sid()?;
    let setup = shell::run_as_admin(exe.as_os_str(), &format!("{FLAG} {FOR_FLAG} {user}"))
        .map_err(|_| Error::Player("Windows didn't start setup (the admin prompt was declined?)".into()))?;
    std::thread::spawn(move || {
        let outcome = match setup.wait() {
            Some(0) => match record_done() {
                Ok(()) => {
                    log::info!("setup finished");
                    "Setup is done.".to_string()
                }
                Err(e) => {
                    log::warn!("setup finished, but {DONE} can't be written: {e}");
                    format!("Setup is done, but Lamplit couldn't record that: {e}")
                }
            },
            code => {
                log::warn!("setup failed (exit code {code:?}): setup.log of the account that ran it says why");
                "Setup didn't finish: setup.log in Lamplit's data folder says why.".to_string()
            }
        };
        events::emit(&app, Event::Notice(outcome));
        events::emit(&app, Event::Setup(status()));
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_xml_escapes_the_path_and_names_the_account() {
        let xml = task_xml("S-1-5-21-1-2-3-1001", Path::new(r"C:\Games & Apps\Lamplit\lamplit.exe"));
        assert!(xml.contains(r"<Command>C:\Games &amp; Apps\Lamplit\lamplit.exe</Command>"));
        assert!(xml.contains(r"<WorkingDirectory>C:\Games &amp; Apps\Lamplit</WorkingDirectory>"));
        assert_eq!(xml.matches("<UserId>S-1-5-21-1-2-3-1001</UserId>").count(), 2);
    }
}
