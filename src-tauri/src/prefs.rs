// The player's choices on the Settings screen, in prefs.json in the data folder. Read once at start and kept in
// Tauri's state; a change takes effect only once the file has it.

use crate::data;
use crate::error::Result;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const FILE: &str = "prefs.json";

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(default)]
pub struct Prefs {
    /// Sound follows the headset and controller headphones (accessories.rs).
    pub sound_follows: bool,
    /// The DualSense touchpad moves the mouse (trackpad.rs).
    pub touchpad_mouse: bool,
    /// Lamplit opens Steam's DevTools port, which the PS button guard and Steam's part of quiet mode need. Any program
    /// on the PC can control Steam through that port, so it is off until the player switches it on (devtools.rs).
    pub steam_devtools: bool,
    /// Art Steam's library cache doesn't have comes from Steam's store, which then learns the names of the games
    /// outside Steam (art.rs).
    pub online_art: bool,
    /// Minutes without input before the page shows its screensaver, 0 for never (ui/screensaver). Prefs written while
    /// the screensaver still had a 2D and 3D choice also hold a `screensaver_style`, which serde passes over.
    pub screensaver_minutes: u32,
    /// Holding PS over a game opens the dock (dock/) rather than the home screen.
    pub dock: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs {
            sound_follows: true,
            touchpad_mouse: false,
            steam_devtools: false,
            online_art: true,
            screensaver_minutes: 5,
            dock: true,
        }
    }
}

pub struct PrefsState(Mutex<Prefs>);

/// Tauri state. Not on the Builder: a file that can't be read is logged, and the log starts in setup.
pub fn load() -> PrefsState {
    PrefsState(Mutex::new(data::load_or_default(FILE)))
}

pub fn get(app: &AppHandle) -> Prefs {
    *app.state::<PrefsState>().0.lock()
}

/// Saves a change, then makes it.
pub fn change(app: &AppHandle, change: impl FnOnce(&mut Prefs)) -> Result<()> {
    let state = app.state::<PrefsState>();
    let mut prefs = state.0.lock();
    let mut changed = *prefs;
    change(&mut changed);
    data::save(FILE, &changed)?;
    *prefs = changed;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Prefs;

    #[test]
    fn the_defaults_reach_the_page_as_in_the_fixture() {
        assert_eq!(serde_json::to_value(Prefs::default()).unwrap(), ipc_fixture!("prefs"));
    }

    #[test]
    fn prefs_from_before_the_screensaver_get_its_defaults() {
        let old = r#"{ "sound_follows": false, "touchpad_mouse": true, "steam_devtools": false, "online_art": true }"#;
        let prefs: Prefs = serde_json::from_str(old).unwrap();
        assert!(!prefs.sound_follows && prefs.touchpad_mouse);
        assert_eq!(prefs.screensaver_minutes, 5);
    }

    #[test]
    fn prefs_with_the_old_screensaver_style_still_load() {
        let old = r#"{ "online_art": false, "screensaver_minutes": 10, "screensaver_style": "3d", "dock": false }"#;
        let prefs: Prefs = serde_json::from_str(old).unwrap();
        assert!(!prefs.online_art && !prefs.dock);
        assert_eq!(prefs.screensaver_minutes, 10);
    }
}
