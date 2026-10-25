// What Windows knows about the software on the PC (the installed-programs list, the exes it has seen run as games,
// the fixed drives), and which exe in a folder starts it. Several stores read these, and so does loose.rs.

use crate::files::{file_name, folder_key};
use crate::win;
use std::path::{Path, PathBuf};
use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

/// What Windows knows about the software on this PC, read once per scan.
pub struct Installed {
    /// The fixed drives (C:\ and so on).
    pub drives: Vec<PathBuf>,
    pub programs: Vec<Program>,
    /// Exes Windows has seen run as games.
    pub game_exes: Vec<PathBuf>,
}

impl Installed {
    pub fn read() -> Self {
        Installed { drives: win::drives::fixed(), programs: installed_programs(), game_exes: game_config_store() }
    }
}

/// An entry of Windows' installed-programs list (the Uninstall registry keys).
pub struct Program {
    pub(super) name: String,
    pub(super) folder: Option<PathBuf>,
    pub(super) exe: Option<PathBuf>,
}

/// Exes Windows has seen run as games (Game Bar's list), that still exist.
fn game_config_store() -> Vec<PathBuf> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(children) = hkcu.open_subkey(r"System\GameConfigStore\Children") else { return Vec::new() };
    let mut out: Vec<PathBuf> = children
        .enum_keys()
        .flatten()
        .filter_map(|k| children.open_subkey(k).ok()?.get_value::<String, _>("MatchedExeFullPath").ok())
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .collect();
    out.sort();
    out.dedup_by(|a, b| folder_key(a) == folder_key(b));
    out
}

/// Windows' installed-programs list, from the machine-wide (64- and 32-bit) and per-user Uninstall keys.
fn installed_programs() -> Vec<Program> {
    const UNINSTALL: [(winreg::HKEY, &str); 3] = [
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ];
    let mut out = Vec::new();
    for (hive, path) in UNINSTALL {
        let Ok(root) = RegKey::predef(hive).open_subkey(path) else { continue };
        for sub in root.enum_keys().flatten() {
            let Ok(key) = root.open_subkey(&sub) else { continue };
            let Ok(name) = key.get_value::<String, _>("DisplayName") else { continue };
            let system = key.get_value::<u32, _>("SystemComponent").is_ok_and(|v| v == 1);
            if system || key.get_value::<String, _>("ParentKeyName").is_ok() {
                continue;
            }
            // DisplayIcon looks like `"C:\Games\X\x.exe",0`; it is usually the game's own exe.
            let exe = key
                .get_value::<String, _>("DisplayIcon")
                .ok()
                .map(|icon| PathBuf::from(icon.rsplit_once(',').map_or(icon.as_str(), |(p, _)| p).trim_matches('"')))
                .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe")) && p.is_file());
            let folder = key
                .get_value::<String, _>("InstallLocation")
                .ok()
                .map(|l| PathBuf::from(l.trim_matches('"').replace('/', "\\").trim_end_matches('\\')))
                .filter(|d| d.is_dir())
                .or_else(|| exe.as_ref().and_then(|e| e.parent()).map(Path::to_path_buf));
            out.push(Program { name, folder, exe });
        }
    }
    out
}

const SKIP_EXE: &[&str] = &[
    "unins", "setup", "install", "redist", "dxsetup", "crash", "report", "launcher", "anticheat", "battleye",
    "beservice", "helper", "updater", "touchup", "cleanup", "activation", "webhelper", "prereq", "bugsplat",
    "cefprocess", "dotnet", "vc_", "eac_", "easyanticheat",
];
const SKIP_DIR: &[&str] = &[
    "_commonredist", "redist", "redistributables", "support", "easyanticheat", "battleye", "directx", "vcredist",
    "dotnet", "installer", "prereqs", "crashreporter",
];

/// An exe that comes with a game but doesn't start it: an installer, a crash reporter, anti-cheat and the like.
pub(super) fn skip_exe(path: &Path) -> bool {
    let name = file_name(path).to_lowercase();
    SKIP_EXE.iter().any(|s| name.contains(s))
}

/// The exe to start for a folder: the one Windows has seen run as a game, else the hint (the installed-programs
/// icon), else the largest likely one.
pub fn pick_exe(dir: &Path, game_exes: &[PathBuf], hint: Option<&Path>) -> Option<PathBuf> {
    let key = format!("{}\\", folder_key(dir));
    if let Some(known) = game_exes.iter().find(|p| folder_key(p).starts_with(&key)) {
        return Some(known.clone());
    }
    if let Some(h) = hint.filter(|h| folder_key(h).starts_with(&key) && !skip_exe(h)) {
        return Some(h.to_path_buf());
    }
    let mut best: Option<(u64, PathBuf)> = None;
    let mut stack = vec![(dir.to_path_buf(), 0)];
    while let Some((d, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let path = e.path();
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() {
                let n = file_name(&path).to_lowercase();
                if depth < 3 && !SKIP_DIR.contains(&n.as_str()) && !n.starts_with("__") {
                    stack.push((path, depth + 1));
                }
            } else if path.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe")) && !skip_exe(&path) {
                let size = e.metadata().map_or(0, |m| m.len());
                if best.as_ref().is_none_or(|(s, _)| size > *s) {
                    best = Some((size, path));
                }
            }
        }
    }
    best.map(|(_, p)| p)
}
