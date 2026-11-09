// The account owns new sign-in tasks. Only deleting a legacy task with a restrictive DACL can ask for elevation.

use crate::APP;
use crate::error::{Error, Result};
use crate::files::folder_key;
use crate::win::{shell, task, token};
use serde::Serialize;
use std::path::Path;
use windows::Win32::Foundation::E_ACCESSDENIED;

pub const DELETE_FLAG: &str = "--remove-startup";
pub const FOR_FLAG: &str = "--for";

#[derive(Serialize)]
pub struct Status {
    pub enabled: bool,
}

pub fn status() -> Result<Status> {
    let user = token::user_sid()?;
    let task = task::logon_task(&format!("{APP}-{user}"), &user)?;
    let exe = std::env::current_exe()?;
    Ok(Status { enabled: task.as_ref().is_some_and(|task| starts_this_exe(task, &exe)) })
}

fn starts_this_exe(task: &task::LogonTask, exe: &Path) -> bool {
    task.enabled && task.arguments.trim().is_empty() && folder_key(Path::new(&task.command)) == folder_key(exe)
}

pub fn set(on: bool) -> Result<Status> {
    if on {
        let user = token::user_sid()?;
        task::register_logon_task(&format!("{APP}-{user}"), &task_xml(&user, &std::env::current_exe()?))
            .map_err(|e| if e.code() == E_ACCESSDENIED {
                Error::Player("Windows won't replace the old sign-in task. Remove Lamplit's task in Task Scheduler, then try again.".into())
            } else { e.into() })?;
    } else {
        remove(true)?;
    }
    status()
}

pub fn remove(allow_prompt: bool) -> Result<()> {
    let user = token::user_sid()?;
    match delete_for(&user) {
        Ok(()) => Ok(()),
        Err(Error::Windows(e)) if e.code() == E_ACCESSDENIED && allow_prompt && !token::elevated() => {
            let exe = std::env::current_exe()?;
            let child = shell::run_as_admin(exe.as_os_str(), &format!("{DELETE_FLAG} {FOR_FLAG} {user}"))
                .map_err(|_| Error::Player("Windows didn't remove the sign-in task. Answer the admin prompt to remove it.".into()))?;
            if child.wait() != Some(0) {
                return Err(Error::Player("The sign-in task wasn't removed. Try again or remove it in Task Scheduler.".into()));
            }
            // The helper's exit code must not hide a task that is still there.
            delete_for(&user)
        }
        Err(Error::Windows(e)) if e.code() == E_ACCESSDENIED => Err(Error::Player(
            "The sign-in task needs admin rights to remove. Turn off Start when I sign in in Lamplit, or remove it in Task Scheduler.".into(),
        )),
        Err(e) => Err(e),
    }
}

/// The elevated helper can only remove Lamplit's task, never run it or register a different executable.
///
/// # Errors
///
/// An invalid account SID, or Task Scheduler refusing the deletion.
pub fn delete_for(user: &str) -> Result<()> {
    if !valid_sid(user) {
        return Err(Error::Player("The account SID for the sign-in task is invalid.".into()));
    }
    task::delete_logon_task(&format!("{APP}-{user}"))?;
    Ok(())
}

fn valid_sid(user: &str) -> bool {
    user.starts_with("S-1-")
        && user[4..].split('-').all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

/// The same interactive, least-privilege task used in 0.3, now registered without elevation.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_xml_escapes_the_path_and_names_the_account() {
        let xml = task_xml("S-1-5-21-1-2-3-1001", Path::new(r"C:\Games & Apps\Lamplit\lamplit.exe"));
        assert!(xml.contains(r"<Command>C:\Games &amp; Apps\Lamplit\lamplit.exe</Command>"));
        assert!(xml.contains(r"<WorkingDirectory>C:\Games &amp; Apps\Lamplit</WorkingDirectory>"));
        assert_eq!(xml.matches("<UserId>S-1-5-21-1-2-3-1001</UserId>").count(), 2);
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>"));
    }

    #[test]
    fn disabled_moved_and_other_process_modes_are_off() {
        let exe = Path::new(r"C:\Lamplit\lamplit.exe");
        let mut task = task::LogonTask { enabled: true, command: exe.display().to_string(), arguments: String::new() };
        assert!(starts_this_exe(&task, exe));
        task.enabled = false;
        assert!(!starts_this_exe(&task, exe));
        task.enabled = true;
        task.arguments = "--setup".into();
        assert!(!starts_this_exe(&task, exe));
        task.arguments.clear();
        task.command = r"C:\Old\lamplit.exe".into();
        assert!(!starts_this_exe(&task, exe));
    }

    #[test]
    fn helper_accepts_only_sid_text() {
        assert!(valid_sid("S-1-5-21-1-2-3-1001"));
        for bad in ["", "S-1-", "S-1-5-", "S-1-5/other", "S-1-5 --setup"] {
            assert!(!valid_sid(bad));
        }
    }

    #[test]
    fn status_reaches_the_page_as_in_its_fixture() {
        assert_eq!(serde_json::to_value(Status { enabled: true }).unwrap(), ipc_fixture!("startup"));
    }
}
