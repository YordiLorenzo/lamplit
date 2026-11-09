// Task Scheduler.

use super::com;
use windows::Win32::Foundation::{E_ACCESSDENIED, ERROR_FILE_NOT_FOUND, VARIANT_BOOL};
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
use windows::Win32::System::TaskScheduler::{
    IExecAction, ILogonTrigger, ITaskFolder, ITaskService, TASK_ACTION_EXEC, TASK_ACTION_TYPE, TASK_CREATE_OR_UPDATE,
    TASK_LOGON_INTERACTIVE_TOKEN, TASK_TRIGGER_LOGON, TASK_TRIGGER_TYPE2, TaskScheduler,
};
use windows::Win32::System::Variant::VARIANT;
use windows::core::{BSTR, HRESULT, Interface, Result};

fn root() -> Result<ITaskFolder> {
    com::initialize();
    // SAFETY: the service and empty connection arguments remain owned until these COM calls finish.
    unsafe {
        let service: ITaskService = CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER)?;
        let none = VARIANT::default();
        service.Connect(&none, &none, &none, &none)?;
        service.GetFolder(&BSTR::from("\\"))
    }
}

pub struct LogonTask {
    pub enabled: bool,
    pub command: String,
    pub arguments: String,
}

/// The account's enabled logon trigger and executable action, read from Scheduler, never from Lamplit's records.
pub fn logon_task(name: &str, user: &str) -> Result<Option<LogonTask>> {
    let folder = root()?;
    // SAFETY: COM interfaces own their references; every out parameter is a valid local of the required type.
    unsafe {
        let task = match folder.GetTask(&BSTR::from(name)) {
            Ok(task) => task,
            Err(e) if e.code() == HRESULT::from_win32(ERROR_FILE_NOT_FOUND.0) => return Ok(None),
            Err(e) => return Err(e),
        };
        let definition = task.Definition()?;
        let actions = definition.Actions()?;
        let mut count = 0;
        actions.Count(&raw mut count)?;
        if count != 1 {
            return Ok(None);
        }
        let action = actions.get_Item(1)?;
        let mut kind = TASK_ACTION_TYPE::default();
        action.Type(&raw mut kind)?;
        if kind != TASK_ACTION_EXEC {
            return Ok(None);
        }
        let exec: IExecAction = action.cast()?;
        let (mut command, mut arguments) = (BSTR::new(), BSTR::new());
        exec.Path(&raw mut command)?;
        exec.Arguments(&raw mut arguments)?;
        let triggers = definition.Triggers()?;
        triggers.Count(&raw mut count)?;
        let mut at_sign_in = false;
        for i in 1..=count {
            let trigger = triggers.get_Item(i)?;
            let mut kind = TASK_TRIGGER_TYPE2::default();
            let mut enabled = VARIANT_BOOL::default();
            trigger.Type(&raw mut kind)?;
            trigger.Enabled(&raw mut enabled)?;
            if kind == TASK_TRIGGER_LOGON && enabled.as_bool() {
                let logon: ILogonTrigger = trigger.cast()?;
                let mut account = BSTR::new();
                logon.UserId(&raw mut account)?;
                at_sign_in |= account.is_empty() || account.to_string() == user;
            }
        }
        Ok(Some(LogonTask {
            enabled: task.Enabled()?.as_bool() && at_sign_in,
            command: command.to_string(),
            arguments: arguments.to_string(),
        }))
    }
}

/// Deleting a missing task is already done. A legacy task's DACL may allow read/run but deny deletion.
pub fn delete_logon_task(name: &str) -> Result<()> {
    let folder = root()?;
    // SAFETY: owned task name and service interfaces remain valid throughout these synchronous COM calls.
    unsafe {
        match folder.DeleteTask(&BSTR::from(name), 0) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == HRESULT::from_win32(ERROR_FILE_NOT_FOUND.0) => Ok(()),
            Err(e) => {
                if e.code() == E_ACCESSDENIED {
                    // OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION.
                    if let Ok(task) = folder.GetTask(&BSTR::from(name)) {
                        match task.GetSecurityDescriptor(7) {
                            Ok(sddl) => log::info!("logon task deletion denied; security descriptor: {sddl}"),
                            Err(reason) => log::info!("logon task security descriptor couldn't be read: {reason}"),
                        }
                    }
                }
                Err(e)
            }
        }
    }
}

/// Registers the task `name` in Task Scheduler's root folder from its XML, or replaces it, to run with the signed-in
/// user's own token. The XML goes straight from memory: a file in the user's temp folder could be swapped before an
/// elevated process imports it.
pub fn register_logon_task(name: &str, xml: &str) -> Result<()> {
    let folder = root()?;
    // SAFETY: COM calls on the service this function creates; every argument is an owned BSTR or an empty VARIANT
    // that lives until the call returns.
    unsafe {
        let none = VARIANT::default();
        folder.RegisterTask(
            &BSTR::from(name),
            &BSTR::from(xml),
            TASK_CREATE_OR_UPDATE.0,
            &none,
            &none,
            TASK_LOGON_INTERACTIVE_TOKEN,
            &none,
        )?;
    }
    Ok(())
}
