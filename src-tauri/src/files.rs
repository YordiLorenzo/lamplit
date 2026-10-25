// Files: reading what stores and Windows leave on disk (paths compared the way Windows compares them, text in
// whatever encoding a store wrote it, folder listings), and writing a file in one step.

use std::fs::File;
use std::io::Write;
use std::path::{Component, Path, PathBuf, Prefix};

/// A path in one spelling (backslashes, no trailing one, lower case), so two spellings of a folder compare equal.
pub fn folder_key(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// A full path on a drive letter (`D:\Games`, `\\?\D:\Games`). Lamplit follows only such paths from a store's files:
/// anything else may lead to a server (`\\server\share`, `\\?\UNC\...`, or `\??\UNC\...`, which Windows passes on
/// as it is), and Windows would sign in to that server with the player's account.
pub fn on_a_drive(p: &Path) -> bool {
    let mut parts = p.components();
    let Some(Component::Prefix(prefix)) = parts.next() else { return false };
    matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) && parts.next() == Some(Component::RootDir)
}

/// `rel` inside `dir`, or None when `rel` (from a store's file) could lead elsewhere: `join` puts an absolute path or
/// a network share in place of `dir`, and `..` climbs out of it.
pub fn inside(dir: &Path, rel: &str) -> Option<PathBuf> {
    let rel = Path::new(rel);
    let below = rel.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    (below && rel.file_name().is_some()).then(|| dir.join(rel))
}

/// A text file in UTF-8 or UTF-16 (with its byte order mark), as stores write them.
pub fn read_text(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let units: Vec<u16> = rest.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return Some(String::from_utf16_lossy(&units));
    }
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    Some(String::from_utf8_lossy(bytes).into_owned())
}

/// The folders in `dir`, sorted.
pub fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> =
        rd.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.path()).collect();
    out.sort();
    out
}

pub fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The file exists and has something in it.
pub fn nonempty(p: &Path) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.len() > 0)
}

/// %LOCALAPPDATA%, where the player's own app data lives.
pub fn local_app_data() -> PathBuf {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default()
}

/// Writes `bytes` to a file next to `path`, flushes it to the disk and renames it over `path`, so a crash or power
/// cut leaves the old file or the new one, never part of one.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let mut file = File::create(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_only_paths_on_a_drive() {
        for drive in [r"D:\Games", r"\\?\D:\Games", "D:/Games", r"C:\"] {
            assert!(on_a_drive(Path::new(drive)), "{drive}");
        }
        let elsewhere =
            [r"\\nas\games", r"\\?\UNC\nas\games", r"\\.\pipe\x", "//nas/games", r"\??\UNC\nas\games", r"\??\C:\x"];
        for path in elsewhere.into_iter().chain([r"bin\game.exe", r"\Games", r"D:Games", ""]) {
            assert!(!on_a_drive(Path::new(path)), "{path}");
        }
    }

    #[test]
    fn keeps_a_store_path_inside_its_folder() {
        let dir = Path::new(r"D:\SteamLibrary\steamapps\common");
        assert_eq!(inside(dir, "Game"), Some(dir.join("Game")));
        assert_eq!(inside(dir, r"bin\game.exe"), Some(dir.join(r"bin\game.exe")));
        assert_eq!(inside(dir, "./bin/game.exe"), Some(dir.join("./bin/game.exe")));
        for outside in [r"\\nas\games", r"C:\Windows", r"\Windows", "C:Windows", r"..\other", r"bin\..\..\x", "", "."] {
            assert_eq!(inside(dir, outside), None, "{outside}");
        }
    }

    #[test]
    fn write_atomic_replaces_the_file_and_leaves_no_temporary_one() {
        let dir = std::env::temp_dir().join(format!("lamplit-test-atomic-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("record.json");
        std::fs::write(&path, "old").unwrap();
        write_atomic(&path, b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        assert!(!dir.join("record.json.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
