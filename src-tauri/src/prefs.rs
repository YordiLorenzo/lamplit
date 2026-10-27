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
    /// Minutes without input before the page shows its screensaver, 0 for never (ui/screensaver).
    pub screensaver_minutes: u32,
    pub screensaver_style: ScreensaverStyle,
    /// Holding PS over a game opens the dock (dock/) rather than the home screen.
    pub dock: bool,
}

/// Which of the screensaver's scenes the page shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ScreensaverStyle {
    /// The 2D and the 3D scenes in turn.
    #[serde(rename = "mix")]
    Mix,
    #[serde(rename = "2d")]
    Flat,
    #[serde(rename = "3d")]
    Depth,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs {
            sound_follows: true,
            touchpad_mouse: false,
            steam_devtools: false,
            online_art: true,
            screensaver_minutes: 5,
            screensaver_style: ScreensaverStyle::Mix,
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
    use super::{Prefs, ScreensaverStyle};

    #[test]
    fn the_defaults_reach_the_page_as_in_the_fixture() {
        assert_eq!(serde_json::to_value(Prefs::default()).unwrap(), ipc_fixture!("prefs"));
    }

    #[test]
    fn every_screensaver_style_is_one_the_page_knows() {
        let all = [ScreensaverStyle::Mix, ScreensaverStyle::Flat, ScreensaverStyle::Depth];
        assert_eq!(serde_json::to_value(all).unwrap(), ipc_fixture!("values")["screensaver_style"]);
    }

    #[test]
    fn prefs_from_before_the_screensaver_get_its_defaults() {
        let old = r#"{ "sound_follows": false, "touchpad_mouse": true, "steam_devtools": false, "online_art": true }"#;
        let prefs: Prefs = serde_json::from_str(old).unwrap();
        assert!(!prefs.sound_follows && prefs.touchpad_mouse);
        assert_eq!((prefs.screensaver_minutes, prefs.screensaver_style), (5, ScreensaverStyle::Mix));
    }
}
