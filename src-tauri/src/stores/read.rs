// Discovery must distinguish an absent store from files it could not read this time.

use crate::error::{Error, Result};
use std::path::{Path, PathBuf};

pub fn optional<T>(result: std::io::Result<T>) -> std::io::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn bytes(path: &Path) -> Result<Option<Vec<u8>>> {
    optional(std::fs::read(path)).map_err(|e| Error::Internal(format!("{}: {e}", path.display())))
}

pub fn text(path: &Path) -> Result<Option<String>> {
    let Some(bytes) = bytes(path)? else { return Ok(None) };
    let text = if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let units: Vec<u16> = rest.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    } else {
        let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
        String::from_utf8_lossy(bytes).into_owned()
    };
    Ok(Some(text))
}

/// Optional details must not hide an otherwise readable installed game.
pub fn detail_text(path: &Path) -> Option<String> {
    text(path).unwrap_or_else(|e| {
        log::warn!("discovery: optional detail unavailable: {e}");
        None
    })
}

pub fn entries(dir: &Path) -> Result<Vec<std::fs::DirEntry>> {
    optional(std::fs::read_dir(dir))
        .and_then(|rd| {
            rd.into_iter().flatten().filter_map(|entry| optional(entry).transpose()).collect::<std::io::Result<_>>()
        })
        .map_err(|e| Error::Internal(format!("{}: {e}", dir.display())))
}

pub fn subdirs(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut dirs = Vec::new();
    for entry in entries(dir)? {
        if optional(entry.file_type())?.is_some_and(|kind| kind.is_dir()) {
            dirs.push(entry.path());
        }
    }
    dirs.sort();
    Ok(dirs)
}

pub fn is_dir(path: &Path) -> Result<bool> {
    Ok(optional(std::fs::metadata(path))?.is_some_and(|m| m.is_dir()))
}

pub fn is_file(path: &Path) -> Result<bool> {
    Ok(optional(std::fs::metadata(path))?.is_some_and(|m| m.is_file()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn missing_files_are_empty_but_unreadable_files_fail() {
        let dir = std::env::temp_dir().join(format!("lamplit-test-store-read-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("store.json");
        assert!(text(&file).unwrap().is_none());
        assert!(entries(&dir.join("missing")).unwrap().is_empty());
        fs::write(&file, b"\xef\xbb\xbf{}").unwrap();
        assert_eq!(text(&file).unwrap().as_deref(), Some("{}"));
        assert!(entries(&file).is_err());
        assert!(text(&dir).is_err());
        fs::write(&file, [0xff, 0xfe, b'{', 0, b'}', 0]).unwrap();
        assert_eq!(text(&file).unwrap().as_deref(), Some("{}"));
        fs::write(&file, [0xff, 0xfe, b'{']).unwrap();
        assert_eq!(text(&file).unwrap().as_deref(), Some(""));
        assert!(optional::<()>(Err(std::io::ErrorKind::PermissionDenied.into())).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
