// Task Scheduler.

use super::com;
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
use windows::Win32::System::TaskScheduler::{
    ITaskService, TASK_CREATE_OR_UPDATE, TASK_LOGON_INTERACTIVE_TOKEN, TaskScheduler,
};
use windows::Win32::System::Variant::VARIANT;
use windows::core::{BSTR, Result};

/// Registers the task `name` in Task Scheduler's root folder from its XML, or replaces it, to run with the signed-in
/// user's own token. The XML goes straight from memory: a file in the user's temp folder could be swapped before an
/// elevated process imports it.
pub fn register_logon_task(name: &str, xml: &str) -> Result<()> {
    com::initialize();
    // SAFETY: COM calls on the service this function creates; every argument is an owned BSTR or an empty VARIANT
    // that lives until the call returns.
    unsafe {
        let service: ITaskService = CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER)?;
        let none = VARIANT::default();
        service.Connect(&none, &none, &none, &none)?;
        let folder = service.GetFolder(&BSTR::from("\\"))?;
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
