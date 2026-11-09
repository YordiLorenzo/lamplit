// Ubisoft Connect: its games (the launcher's Installs key), its processes and its remembered sign-in.

use super::names::prettify;
use super::{Store, machine_value, read};
use crate::error::Result;
use crate::files::{file_name, local_app_data, nonempty};
use crate::library::{Game, Launch};
use std::path::{Path, PathBuf};
use winreg::RegKey;
use winreg::enums::HKEY_LOCAL_MACHINE;

pub fn exe() -> Option<PathBuf> {
    machine_value(r"SOFTWARE\WOW6432Node\Ubisoft\Launcher", "InstallDir")
        .map(|d| Path::new(&d).join("UbisoftConnect.exe"))
}

/// Ubisoft Connect's processes: its launcher, and upc.exe, which the launcher hands over to before it exits.
pub const PROCESSES: [&str; 2] = ["UbisoftConnect.exe", "upc.exe"];

/// The paths of Ubisoft Connect's processes, next to its launcher `exe`.
pub fn processes(exe: &Path) -> Vec<PathBuf> {
    PROCESSES.iter().map(|name| exe.with_file_name(name)).collect()
}

pub fn games() -> Result<Vec<Game>> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let Some(installs) = read::optional(hklm.open_subkey(r"SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs"))? else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for id in installs.enum_keys() {
        let id = id?;
        let Some(dir) = read::optional(installs.open_subkey(&id).and_then(|k| k.get_value::<String, _>("InstallDir")))?
        else {
            continue;
        };
        let dir = PathBuf::from(dir.replace('/', "\\").trim_end_matches('\\'));
        if !read::is_dir(&dir)? {
            continue;
        }
        let name = prettify(&file_name(&dir));
        out.push(Game::new(
            format!("ubisoft:{id}"),
            name,
            Some(Store::Ubisoft),
            dir,
            Launch::Uri(format!("uplay://launch/{id}/0")),
        ));
    }
    Ok(out)
}

pub fn remembered() -> bool {
    let dir = local_app_data().join("Ubisoft Game Launcher");
    nonempty(&dir.join("ConnectSecureStorage.dat")) && nonempty(&dir.join("user.dat"))
}
