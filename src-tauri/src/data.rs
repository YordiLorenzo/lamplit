// Lamplit's data folder, %LOCALAPPDATA%\lamplit, and the JSON files it keeps there: the player's prefs, what the
// player keeps per game (favourites, hidden games, last played, play time), the art lookups, the setup record and
// quiet mode's record of the settings it replaced.

use crate::APP;
use crate::error::Result;
use crate::files::{local_app_data, write_atomic};
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::OnceLock;

pub fn data_dir() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = local_app_data().join(APP);
        let _ = std::fs::create_dir_all(&dir);
        dir
    })
}

/// Reads `name` from the data folder: None when there is no such file, an error when it can't be read or parsed.
pub fn load<T: DeserializeOwned>(name: &str) -> Result<Option<T>> {
    match std::fs::read(data_dir().join(name)) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Reads `name`, or the defaults when there is none. A file that can't be read is logged and stays as it is until
/// the next save replaces it.
pub fn load_or_default<T: DeserializeOwned + Default>(name: &str) -> T {
    match load(name) {
        Ok(value) => value.unwrap_or_default(),
        Err(e) => {
            log::warn!("{name} can't be read, so Lamplit uses the defaults: {e}");
            T::default()
        }
    }
}

/// Writes `value` to `name` in the data folder as JSON, in one step (see `files::write_atomic`).
pub fn save<T: Serialize>(name: &str, value: &T) -> Result<()> {
    write_atomic(&data_dir().join(name), &serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

pub fn remove(name: &str) -> std::io::Result<()> {
    std::fs::remove_file(data_dir().join(name))
}
