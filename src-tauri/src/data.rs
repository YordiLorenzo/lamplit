// Lamplit's data folder, %LOCALAPPDATA%\lamplit, and the JSON files it keeps there: the player's prefs, what the
// player keeps per game (favourites, hidden games, last played, play time), the art lookups, the setup record and
// quiet mode's record of the settings it replaced.

use crate::APP;
use crate::error::Result;
use crate::files::{local_app_data, write_atomic};
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub fn data_dir() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = local_app_data().join(APP);
        let _ = std::fs::create_dir_all(&dir);
        dir
    })
}

/// Reads `name`, keeping damaged JSON aside and restoring the last good copy when one exists.
pub fn load<T: DeserializeOwned>(name: &str) -> Result<Option<T>> {
    load_from(&data_dir().join(name))
}

fn beside(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    name.into()
}

fn read(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn keep_damaged(path: &Path, error: &serde_json::Error) -> Result<()> {
    let damaged = beside(path, ".damaged");
    // Keep the primary in place so quiet mode still refuses changes without a usable restore record.
    std::fs::copy(path, &damaged)?;
    log::warn!("{} is damaged ({error}); kept as {}", path.display(), damaged.display());
    Ok(())
}

fn load_from<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    let mut damaged = None;
    if let Some(bytes) = read(path)? {
        match serde_json::from_slice(&bytes) {
            Ok(value) => return Ok(Some(value)),
            Err(e) => {
                keep_damaged(path, &e)?;
                damaged = Some(e);
            }
        }
    }
    let backup = beside(path, ".bak");
    let Some(bytes) = read(&backup)? else {
        return match damaged {
            Some(e) => Err(e.into()),
            None => Ok(None),
        };
    };
    let value = serde_json::from_slice(&bytes)?;
    // Restore the primary too: quiet mode and setup may read it several times before the next save.
    write_atomic(path, &bytes)?;
    log::warn!("{} restored from the last good copy, {}", path.display(), backup.display());
    Ok(Some(value))
}

/// Reads `name`, recovering its last good copy, or uses the defaults when neither can be read.
pub fn load_or_default<T: DeserializeOwned + Default>(name: &str) -> T {
    load_or_default_from(&data_dir().join(name))
}

fn load_or_default_from<T: DeserializeOwned + Default>(path: &Path) -> T {
    match load_from(path) {
        Ok(value) => value.unwrap_or_default(),
        Err(e) => {
            log::warn!("{} can't be read, so Lamplit uses the defaults: {e}", path.display());
            T::default()
        }
    }
}

/// Writes `value` to `name` in the data folder as JSON, in one step (see `files::write_atomic`).
pub fn save<T: Serialize + DeserializeOwned>(name: &str, value: &T) -> Result<()> {
    save_to(&data_dir().join(name), value)
}

fn save_to<T: Serialize + DeserializeOwned>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    if let Some(previous) = read(path)? {
        match serde_json::from_slice::<T>(&previous) {
            Ok(_) => write_atomic(&beside(path, ".bak"), &previous)?,
            Err(e) => keep_damaged(path, &e)?,
        }
    }
    write_atomic(path, &bytes)?;
    Ok(())
}

pub fn remove(name: &str) -> std::io::Result<()> {
    remove_from(&data_dir().join(name))
}

fn remove_from(path: &Path) -> std::io::Result<()> {
    // Quiet mode has restored these settings. Its old backup must not bring the record back on the next read.
    match std::fs::remove_file(beside(path, ".bak")) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    std::fs::remove_file(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lamplit-test-data-{name}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn damaged_settings_are_kept_and_the_backup_is_restored() {
        let dir = scratch("recover");
        let path = dir.join("games.json");
        let good = json!({"steam:70": {"favourite": true, "hidden": true}});
        save_to(&path, &good).unwrap();
        save_to(&path, &json!({})).unwrap();
        fs::write(&path, "{cut off").unwrap();
        fs::write(beside(&path, ".damaged"), "older damage").unwrap();
        assert_eq!(load_from::<Value>(&path).unwrap(), Some(good.clone()));
        assert_eq!(fs::read_to_string(beside(&path, ".damaged")).unwrap(), "{cut off");
        assert_eq!(load_from::<Value>(&path).unwrap(), Some(good));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn damaged_settings_without_a_copy_use_defaults() {
        let dir = scratch("defaults");
        let path = dir.join("prefs.json");
        fs::write(&path, "{").unwrap();
        assert_eq!(load_or_default_from::<Vec<String>>(&path), Vec::<String>::new());
        assert_eq!(fs::read_to_string(beside(&path, ".damaged")).unwrap(), "{");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{", "the original stays until replaced");
        assert!(load_from::<Vec<String>>(&path).is_err(), "strict callers must still refuse this record");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn saving_keeps_the_previous_good_content_and_removing_does_not_restore_it() {
        let dir = scratch("save");
        let path = dir.join("quiet-saved.json");
        save_to(&path, &json!({"wanted": true})).unwrap();
        let previous = fs::read(&path).unwrap();
        save_to(&path, &json!({"wanted": false})).unwrap();
        assert_eq!(fs::read(beside(&path, ".bak")).unwrap(), previous);
        assert_eq!(load_from::<Value>(&path).unwrap(), Some(json!({"wanted": false})));
        fs::write(&path, "broken").unwrap();
        save_to(&path, &json!({"wanted": false})).unwrap();
        assert_eq!(fs::read(beside(&path, ".bak")).unwrap(), previous);
        remove_from(&path).unwrap();
        assert!(load_from::<Value>(&path).unwrap().is_none());
        assert!(beside(&path, ".damaged").is_file());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_wrong_json_shape_is_not_a_good_backup() {
        let dir = scratch("shape");
        let path = dir.join("prefs.json");
        save_to(&path, &vec!["old".to_string()]).unwrap();
        save_to(&path, &vec!["new".to_string()]).unwrap();
        let backup = fs::read(beside(&path, ".bak")).unwrap();
        fs::write(&path, "{}").unwrap();
        save_to(&path, &Vec::<String>::new()).unwrap();
        assert_eq!(fs::read(beside(&path, ".bak")).unwrap(), backup);
        assert_eq!(fs::read_to_string(beside(&path, ".damaged")).unwrap(), "{}");
        assert!(load_from::<Vec<String>>(&path).unwrap().unwrap().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }
}
