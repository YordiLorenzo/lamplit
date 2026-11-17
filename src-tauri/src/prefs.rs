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

#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Trailers {
    Off,
    #[default]
    Muted,
    WithSound,
}

impl Trailers {
    pub fn parse(level: &str) -> Result<Self> {
        match level {
            "off" => Ok(Self::Off),
            "muted" => Ok(Self::Muted),
            "with_sound" => Ok(Self::WithSound),
            _ => Err(Error::Player("Choose Off, Muted or With sound for trailers.".into())),
        }
    }
}

/// The Lamplit button a DualSense Edge's back or Fn button acts as, chosen in Settings > Controllers. Nothing by
/// default: a player who gives those buttons to games in Steam Input doesn't want them to move Lamplit's menus too.
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(strum::VariantArray))]
#[serde(rename_all = "lowercase")]
pub enum EdgeTarget {
    #[default]
    Nothing,
    Cross,
    Circle,
    Triangle,
    Square,
    L1,
    R1,
    Options,
}

impl EdgeTarget {
    pub fn parse(name: &str) -> Result<Self> {
        match name {
            "nothing" => Ok(Self::Nothing),
            "cross" => Ok(Self::Cross),
            "circle" => Ok(Self::Circle),
            "triangle" => Ok(Self::Triangle),
            "square" => Ok(Self::Square),
            "l1" => Ok(Self::L1),
            "r1" => Ok(Self::R1),
            "options" => Ok(Self::Options),
            _ => Err(Error::Player("Choose Nothing, Cross, Circle, Triangle, Square, L1, R1 or Options.".into())),
        }
    }
}

/// What a DualSense Edge's two back buttons and two Fn buttons do in Lamplit. One choice for every Edge.
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct EdgeButtons {
    pub left_back: EdgeTarget,
    pub right_back: EdgeTarget,
    pub left_fn: EdgeTarget,
    pub right_fn: EdgeTarget,
}

/// One of the four buttons' choices, picked out of an EdgeButtons.
pub type EdgeButton = fn(&mut EdgeButtons) -> &mut EdgeTarget;

impl EdgeButtons {
    /// The button by the name the page gives it.
    pub fn button(name: &str) -> Result<EdgeButton> {
        match name {
            "left_back" => Ok(|b| &mut b.left_back),
            "right_back" => Ok(|b| &mut b.right_back),
            "left_fn" => Ok(|b| &mut b.left_fn),
            "right_fn" => Ok(|b| &mut b.right_fn),
            _ => Err(Error::Player("A DualSense Edge has no such button.".into())),
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

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Prefs {
    /// Sound follows the headset and controller headphones (accessories.rs).
    pub sound_follows: bool,
    pub interface_sounds: InterfaceSounds,
    pub trailers: Trailers,
    pub hints: Hints,
    /// The DualSense touchpad moves the mouse (trackpad.rs).
    pub touchpad_mouse: bool,
    /// The DualSense Edge's back and Fn buttons as other buttons (devices/pad/dualsense.rs).
    pub edge_buttons: EdgeButtons,
    /// Lamplit opens Steam's DevTools port, which the PS button guard and Steam's part of quiet mode need. Any program
    /// on the PC can control Steam through that port, so it is off until the player switches it on (devtools.rs).
    pub steam_devtools: bool,
    /// Keeps the Guide button for Lamplit, including closing Steam's Big Picture window.
    pub steam_guide: bool,
    /// Art Steam's library cache doesn't have comes from Steam's store, which then learns the names of the games
    /// outside Steam (art.rs).
    pub online_art: bool,
    /// Minutes without input before the page shows its screensaver, 0 for never (ui/screensaver). Prefs written while
    /// the screensaver still had a 2D and 3D choice also hold a `screensaver_style`, which serde passes over.
    pub screensaver_minutes: u32,
    /// Holding PS over a game opens the dock (dock/) rather than the home screen.
    pub dock: bool,
    /// Automatic GitHub update checks; a manual check works even when this is off.
    pub check_updates: bool,
    /// Unix seconds of the last check attempt, including a failed one, so restarts don't keep asking GitHub.
    pub update_checked_at: u64,
    /// Empty on a fresh install, which shows no What's new card.
    pub last_version_seen: String,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs {
            sound_follows: true,
            interface_sounds: InterfaceSounds::Normal,
            trailers: Trailers::Muted,
            hints: Hints::default(),
            touchpad_mouse: false,
            edge_buttons: EdgeButtons::default(),
            steam_devtools: false,
            steam_guide: true,
            online_art: true,
            screensaver_minutes: 5,
            dock: true,
            check_updates: true,
            update_checked_at: 0,
            last_version_seen: String::new(),
        }
    }
}

pub struct PrefsState(Mutex<Prefs>);

/// Tauri state. Not on the Builder: a file that can't be read is logged, and the log starts in setup.
pub fn load() -> PrefsState {
    PrefsState(Mutex::new(data::load_or_default(FILE)))
}

pub fn get(app: &AppHandle) -> Prefs {
    app.state::<PrefsState>().0.lock().clone()
}

/// Saves a change, then makes it.
pub fn change(app: &AppHandle, change: impl FnOnce(&mut Prefs)) -> Result<()> {
    let state = app.state::<PrefsState>();
    let mut prefs = state.0.lock();
    let mut changed = prefs.clone();
    change(&mut changed);
    data::save(FILE, &changed)?;
    *prefs = changed;
    Ok(())
}

/// Records only starts on which the page asks to show this hint, not every launch of the app.
pub fn hint_shown(app: &AppHandle, name: &str) -> Result<bool> {
    let state = app.state::<PrefsState>();
    let mut prefs = state.0.lock();
    let mut changed = prefs.clone();
    let hint = changed.hints.named(name)?;
    let starts = hint.starts;
    let show = hint.show();
    if hint.starts != starts {
        data::save(FILE, &changed)?;
    }
    *prefs = changed;
    Ok(show)
}

pub fn hint_done(app: &AppHandle, name: &str) -> Result<()> {
    let state = app.state::<PrefsState>();
    let mut prefs = state.0.lock();
    let mut changed = prefs.clone();
    let hint = changed.hints.named(name)?;
    if hint.done {
        return Ok(());
    }
    hint.done = true;
    data::save(FILE, &changed)?;
    *prefs = changed;
    Ok(())
}

/// The windowless restore has no Tauri state. An unreadable file must stay intact, not become default prefs.
pub fn stop_steam_changes() -> Result<bool> {
    let mut prefs: Prefs = data::load(FILE)?.unwrap_or_default();
    let opened_port = prefs.steam_devtools;
    prefs.steam_devtools = false;
    prefs.steam_guide = false;
    data::save(FILE, &prefs)?;
    Ok(opened_port)
}

#[cfg(test)]
mod tests {
    use super::{EdgeButtons, EdgeTarget, Hint, Hints, InterfaceSounds, Prefs, Trailers};

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
        assert_eq!(prefs.trailers, Trailers::Muted);
        assert_eq!(prefs.hints.game_menu.starts, 0);
        assert!(!prefs.hints.return_home.done);
        assert!(prefs.steam_guide);
        assert_eq!(prefs.edge_buttons, EdgeButtons::default());
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
    fn trailer_levels_accept_and_restore_only_the_three_choices() {
        for (name, level) in [("off", Trailers::Off), ("muted", Trailers::Muted), ("with_sound", Trailers::WithSound)] {
            assert_eq!(Trailers::parse(name).unwrap(), level);
            assert_eq!(serde_json::to_value(level).unwrap(), name);
            let saved = serde_json::json!({ "trailers": level });
            assert_eq!(serde_json::from_value::<Prefs>(saved).unwrap().trailers, level);
        }
        assert!(Trailers::parse("loud").is_err());
        assert!(serde_json::from_str::<Prefs>(r#"{ "trailers": "loud" }"#).is_err());
    }

    #[test]
    fn edge_buttons_take_only_the_page_s_names_and_choices() {
        let values = ipc_fixture!("values");
        let targets = <EdgeTarget as strum::VariantArray>::VARIANTS;
        assert_eq!(serde_json::to_value(targets).unwrap(), values["edge_target"]);
        for &target in targets {
            assert_eq!(EdgeTarget::parse(serde_json::to_value(target).unwrap().as_str().unwrap()).unwrap(), target);
        }
        assert!(EdgeTarget::parse("ps").is_err());
        // Each name the page sends sets its own button, saved in prefs.json under that name.
        for name in values["edge_button"].as_array().unwrap() {
            let name = name.as_str().unwrap();
            let mut chosen = EdgeButtons::default();
            *EdgeButtons::button(name).unwrap()(&mut chosen) = EdgeTarget::Cross;
            let saved = serde_json::to_value(chosen).unwrap();
            let crosses = saved.as_object().unwrap().iter().filter(|(_, target)| *target == "cross");
            assert_eq!(crosses.map(|(key, _)| key.as_str()).collect::<Vec<_>>(), [name]);
            assert_eq!(serde_json::from_value::<EdgeButtons>(saved).unwrap(), chosen);
        }
        assert_eq!(values["edge_button"].as_array().unwrap().len(), 4);
        assert!(EdgeButtons::button("touchpad").is_err());
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
