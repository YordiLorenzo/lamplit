// The player's choices on the Settings screen, in prefs.json in the data folder. Read once at start and kept in
// Tauri's state; a change takes effect only once the file has it.

use crate::data;
use crate::error::{Error, Result};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const FILE: &str = "prefs.json";

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InterfaceSounds {
    Off,
    Quiet,
    #[default]
    Normal,
}

impl InterfaceSounds {
    pub fn parse(level: &str) -> Result<Self> {
        match level {
            "off" => Ok(Self::Off),
            "quiet" => Ok(Self::Quiet),
            "normal" => Ok(Self::Normal),
            _ => Err(Error::Player("Choose Off, Quiet or Normal for interface sounds.".into())),
        }
    }
}

#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Hint {
    pub starts: u8,
    pub done: bool,
    // A page reload is still the same start of Lamplit. Only the count and completion belong on disk.
    #[serde(skip)]
    shown: bool,
}

impl Hint {
    fn show(&mut self) -> bool {
        if self.done || (self.starts >= 3 && !self.shown) {
            return false;
        }
        if !self.shown {
            self.starts += 1;
            self.shown = true;
        }
        true
    }
}

#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Hints {
    pub game_menu: Hint,
    pub return_home: Hint,
}

impl Hints {
    fn named(&mut self, name: &str) -> Result<&mut Hint> {
        match name {
            "game_menu" => Ok(&mut self.game_menu),
            "return_home" => Ok(&mut self.return_home),
            _ => Err(Error::Player("That hint is not available.".into())),
        }
    }
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(default)]
pub struct Prefs {
    /// Sound follows the headset and controller headphones (accessories.rs).
    pub sound_follows: bool,
    pub interface_sounds: InterfaceSounds,
    pub hints: Hints,
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
            interface_sounds: InterfaceSounds::Normal,
            hints: Hints::default(),
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

/// Records only starts on which the page asks to show this hint, not every launch of the app.
pub fn hint_shown(app: &AppHandle, name: &str) -> Result<bool> {
    let state = app.state::<PrefsState>();
    let mut prefs = state.0.lock();
    let mut changed = *prefs;
    let hint = changed.hints.named(name)?;
    if hint.shown || hint.done || hint.starts >= 3 {
        return Ok(hint.show());
    }
    let show = hint.show();
    data::save(FILE, &changed)?;
    *prefs = changed;
    Ok(show)
}

pub fn hint_done(app: &AppHandle, name: &str) -> Result<()> {
    let state = app.state::<PrefsState>();
    let mut prefs = state.0.lock();
    let mut changed = *prefs;
    let hint = changed.hints.named(name)?;
    if hint.done {
        return Ok(());
    }
    hint.done = true;
    data::save(FILE, &changed)?;
    *prefs = changed;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{Hint, Hints, InterfaceSounds, Prefs};

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
        assert_eq!(prefs.interface_sounds, InterfaceSounds::Normal);
        assert_eq!(prefs.hints.game_menu.starts, 0);
        assert!(!prefs.hints.return_home.done);
    }

    #[test]
    fn prefs_with_the_old_screensaver_style_still_load() {
        let old = r#"{ "online_art": false, "screensaver_minutes": 10, "screensaver_style": "3d", "dock": false }"#;
        let prefs: Prefs = serde_json::from_str(old).unwrap();
        assert!(!prefs.online_art && !prefs.dock);
        assert_eq!(prefs.screensaver_minutes, 10);
    }

    #[test]
    fn sound_levels_accept_only_the_three_choices() {
        for (name, level) in
            [("off", InterfaceSounds::Off), ("quiet", InterfaceSounds::Quiet), ("normal", InterfaceSounds::Normal)]
        {
            assert_eq!(InterfaceSounds::parse(name).unwrap(), level);
            assert_eq!(serde_json::to_value(level).unwrap(), name);
        }
        assert!(InterfaceSounds::parse("loud").is_err());
    }

    #[test]
    fn hints_count_separate_starts_and_stop_after_three() {
        let mut hint = Hint::default();
        for starts in 1..=3 {
            assert!(hint.show());
            assert!(hint.show(), "a page reload is not another start");
            assert_eq!(hint.starts, starts);
            hint = serde_json::from_value(serde_json::to_value(hint).unwrap()).unwrap();
        }
        assert!(!hint.show());
        assert_eq!(hint.starts, 3);
    }

    #[test]
    fn completing_one_hint_keeps_it_gone_and_leaves_the_other_alone() {
        let mut hints = Hints::default();
        hints.named("game_menu").unwrap().done = true;
        let mut loaded: Hints = serde_json::from_value(serde_json::to_value(hints).unwrap()).unwrap();
        assert!(!loaded.game_menu.show());
        assert!(loaded.return_home.show());
        assert!(loaded.named("unknown").is_err());
        assert_eq!(serde_json::to_value(loaded.return_home.show()).unwrap(), ipc_fixture!("hint-shown"));
    }
}
