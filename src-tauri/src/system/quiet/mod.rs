// Quiet mode: no pop-ups over games or Lamplit. Windows' toast banners (this hides Windows Security's too), tips and
// suggestions, Game Bar's start-up tips and controller button, and Ubisoft Connect's notifications and in-game
// overlay. It also turns off Game Bar's recording, so Win+Alt+R and "record that" don't work while it is on. These
// are all the player's own settings (HKCU and their app data), so Lamplit needs no admin rights. Switching it on
// records what was there; switching it off puts that back.
// Steam's pop-ups (in game and on the desktop) go through its own settings, which only a running Steam with its
// DevTools port open can change. What can't be done at the moment of switching (Steam closed, Ubisoft Connect open)
// is finished by `catch_up`, which Lamplit runs every 10 s. NVIDIA's overlay notifications aren't covered: they are
// switched off in the overlay itself.

mod ubisoft;

use crate::data;
use crate::error::{Error, Result};
use crate::stores::steam::devtools;
use crate::stores::steam::settings::{DISABLE_ALL_TOASTS, DISABLE_TOASTS_IN_GAME, Setting};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};

/// What each of the registry values below is set to while quiet mode is on: 0 switches each of them off.
const QUIET: u32 = 0;

/// (key under HKCU, value).
const SETTINGS: &[(&str, &str)] = &[
    (r"Software\Microsoft\Windows\CurrentVersion\Notifications\Settings", "NOC_GLOBAL_SETTING_TOASTS_ENABLED"),
    (r"Software\Microsoft\Windows\CurrentVersion\PushNotifications", "ToastEnabled"),
    (r"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager", "SubscribedContent-338389Enabled"),
    (r"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager", "SubscribedContent-310093Enabled"),
    (r"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager", "SubscribedContent-338388Enabled"),
    (r"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager", "SubscribedContent-353698Enabled"),
    (r"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager", "SoftLandingEnabled"),
    (r"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager", "SystemPaneSuggestionsEnabled"),
    (r"Software\Microsoft\Windows\CurrentVersion\UserProfileEngagement", "ScoobeSystemSettingEnabled"),
    (r"Software\Microsoft\GameBar", "ShowStartupPanel"),
    (r"Software\Microsoft\GameBar", "UseNexusForGameBarEnabled"),
    // These two are Game Bar's recording. It is more than a pop-up, so the Settings row names it.
    (r"Software\Microsoft\Windows\CurrentVersion\GameDVR", "AppCaptureEnabled"),
    (r"System\GameConfigStore", "GameDVR_Enabled"),
];

/// What the player asked for, and what quiet mode replaced. Ubisoft Connect and Steam can't always be changed at the
/// moment of switching (Ubisoft Connect open, Steam closed), so for each the record keeps the settings from before and
/// whether Lamplit has them quiet right now; `sync_apps` closes the gap when the app allows, at the switch and from
/// `catch_up`. The record goes once quiet mode is off and everything is back.
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
struct Saved {
    /// Quiet mode is on: what the player asked for last.
    wanted: bool,
    registry: Vec<RegValue>,
    /// Ubisoft settings that were on before, as "section.key".
    ubisoft: Vec<String>,
    ubisoft_quiet: bool,
    /// Steam's toast settings before (by settings-store name; None: Steam's default). Empty until Steam was read.
    steam: BTreeMap<String, Option<bool>>,
    steam_quiet: bool,
}

/// A registry value under HKCU that quiet mode replaced, and what it was (None: it didn't exist).
#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct RegValue {
    key: String,
    name: String,
    before: Option<u32>,
}

const STEAM_TOASTS: [Setting; 2] = [DISABLE_ALL_TOASTS, DISABLE_TOASTS_IN_GAME];

/// The record is read and rewritten by the Settings screen and by the upkeep thread.
static RECORD: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Debug)]
#[cfg_attr(test, derive(strum::VariantArray))]
#[serde(rename_all = "lowercase")]
pub enum State {
    On,
    Off,
    Partly,
}

#[derive(Serialize)]
pub struct Report {
    pub state: State,
    /// The player has quiet mode on (Lamplit holds what it replaced, and switching off restores that).
    pub active: bool,
    /// Things Lamplit couldn't change right now, for the player.
    pub notes: Vec<String>,
}

const RECORD_FILE: &str = "quiet-saved.json";

/// None when nothing is recorded. A record that can't be read is an error, never a fresh start: it is the only copy
/// of the settings quiet mode replaced.
fn load() -> Result<Option<Saved>> {
    data::load(RECORD_FILE)
}

/// Saves the record. A change that the record must be able to undo waits until this has succeeded.
fn save_record(saved: &Saved) -> Result<()> {
    data::save(RECORD_FILE, saved)
}

/// Saves the record, or removes it once quiet mode is off and nothing is left to put back. Afterwards, so a failure
/// is only logged: the record on disk still holds everything to put back.
fn save_or_remove_record(saved: &Saved) {
    let done = !saved.wanted && saved.registry.is_empty() && saved.ubisoft.is_empty() && saved.steam.is_empty();
    let kept = if done { data::remove(RECORD_FILE).map_err(Error::from) } else { save_record(saved) };
    if let Err(e) = kept {
        log::warn!("quiet mode: can't update {RECORD_FILE}: {e}");
    }
}

fn read_dword(key: &str, name: &str) -> Option<u32> {
    RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(key, KEY_READ).ok()?.get_value(name).ok()
}

fn write_dword(key: &str, name: &str, value: Option<u32>) -> std::io::Result<()> {
    let (k, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(key)?;
    match value {
        Some(v) => k.set_value(name, &v),
        None => {
            k.delete_value(name).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) })
        }
    }
}

pub fn state() -> Report {
    // One flag per switch: Windows' registry values, plus Ubisoft's as a whole when it is set up here.
    let mut quiet: Vec<bool> = SETTINGS.iter().map(|(k, n)| read_dword(k, n) == Some(QUIET)).collect();
    quiet.extend(ubisoft::loud_flags().map(|loud| loud.is_empty()));
    // Steam counts only while its settings can be read.
    if let Ok(toasts_off) = devtools::read_settings(&STEAM_TOASTS.map(|s| s.name)) {
        quiet.push(toasts_off.iter().all(|v| *v == Some(true)));
    }
    let active = load().ok().flatten().is_some_and(|saved| saved.wanted);
    Report { state: summarize(&quiet), active, notes: Vec::new() }
}

/// On when every switch is quiet, Off when none is, Partly otherwise.
fn summarize(quiet: &[bool]) -> State {
    if quiet.iter().all(|&q| q) {
        State::On
    } else if quiet.iter().all(|&q| !q) {
        State::Off
    } else {
        State::Partly
    }
}

pub fn set(on: bool) -> Report {
    let _record = RECORD.lock();
    let mut saved = match load() {
        Ok(saved) => saved.unwrap_or_default(),
        Err(e) => {
            let note =
                format!("Couldn't read the copy of your settings from before quiet mode, so nothing changed: {e}");
            return Report { notes: vec![note], ..state() };
        }
    };
    saved.wanted = on;
    let mut notes = Vec::new();
    if on {
        // Record what is there before changing anything; without that record nothing could be put back. What is
        // already recorded stays: it is what was there before Lamplit changed it.
        for &(key, name) in SETTINGS {
            if !saved.registry.iter().any(|r| r.key == key && r.name == name) {
                saved.registry.push(RegValue { key: key.into(), name: name.into(), before: read_dword(key, name) });
            }
        }
        if !saved.ubisoft_quiet {
            for id in ubisoft::loud_flags().unwrap_or_default() {
                if !saved.ubisoft.contains(&id) {
                    saved.ubisoft.push(id);
                }
            }
        }
        record_steam(&mut saved);
        if let Err(e) = save_record(&saved) {
            let note = format!("Couldn't keep a copy of the current settings, so nothing changed: {e}");
            return Report { notes: vec![note], ..state() };
        }
        for (key, name) in SETTINGS {
            if let Err(e) = write_dword(key, name, Some(QUIET)) {
                notes.push(format!("Couldn't change {name}: {e}"));
            }
        }
    } else {
        notes.extend(restore_registry(&mut saved));
    }
    notes.extend(sync_apps(&mut saved));
    if saved.steam_quiet != saved.wanted {
        notes.extend(devtools::closed_port_note());
    }
    save_or_remove_record(&saved);
    let report = Report { notes, ..state() };
    log::info!("quiet mode {}: now {:?} {:?}", if on { "on" } else { "off" }, report.state, report.notes);
    report
}

/// Puts the recorded registry values back; the ones that fail stay recorded.
fn restore_registry(saved: &mut Saved) -> Vec<String> {
    let mut notes = Vec::new();
    saved.registry.retain(|r| match write_dword(&r.key, &r.name, r.before) {
        Ok(()) => false,
        Err(e) => {
            notes.push(format!("Couldn't change {}: {e}", r.name));
            true
        }
    });
    notes
}

/// Brings Ubisoft Connect's and Steam's settings to what the player asked for, as far as they allow right now. Once
/// quiet mode is off and an app's settings are back, its part of the record goes. A closed Steam gets no note.
fn sync_apps(saved: &mut Saved) -> Vec<String> {
    let mut notes = Vec::new();
    if !saved.ubisoft.is_empty() && saved.ubisoft_quiet != saved.wanted {
        match ubisoft::apply(saved.wanted, &saved.ubisoft) {
            Ok(()) => saved.ubisoft_quiet = saved.wanted,
            Err(e) => notes.push(e.to_string()),
        }
    }
    if !saved.wanted && !saved.ubisoft_quiet {
        saved.ubisoft.clear();
    }
    if !saved.steam.is_empty() && saved.steam_quiet != saved.wanted && write_steam(saved).is_ok() {
        saved.steam_quiet = saved.wanted;
    }
    if !saved.wanted && !saved.steam_quiet {
        saved.steam.clear();
    }
    notes
}

/// Records Steam's toast settings, if Steam can be read and they aren't recorded yet.
fn record_steam(saved: &mut Saved) {
    if !saved.steam.is_empty() {
        return;
    }
    if let Ok(values) = devtools::read_settings(&STEAM_TOASTS.map(|s| s.name)) {
        saved.steam = STEAM_TOASTS.iter().map(|s| s.name.to_string()).zip(values).collect();
    }
}

/// Steam's toasts off while quiet mode is wanted, else back to what was recorded. Steam's settings disable toasts,
/// so true is quiet.
fn write_steam(saved: &Saved) -> Result<()> {
    let fields: Vec<(u32, bool)> = STEAM_TOASTS
        .iter()
        .filter_map(|s| saved.steam.get(s.name).map(|before| (s.field, saved.wanted || before.unwrap_or(false))))
        .collect();
    devtools::write_settings(&fields)
}

/// Finishes what had to wait: Steam's toasts once Steam runs, Ubisoft's settings once Ubisoft Connect is closed,
/// and registry values that couldn't be put back. Cheap when there's nothing to do: a small file read.
pub fn catch_up() {
    let _record = RECORD.lock();
    let Ok(Some(mut saved)) = load() else { return };
    let before = saved.clone();
    if saved.wanted {
        record_steam(&mut saved);
        if saved.steam != before.steam && save_record(&saved).is_err() {
            return;
        }
    } else {
        restore_registry(&mut saved);
    }
    sync_apps(&mut saved);
    if saved != before {
        save_or_remove_record(&saved);
        log::info!(
            "quiet mode: caught up with what had waited (Ubisoft quiet {}, Steam quiet {})",
            saved.ubisoft_quiet,
            saved.steam_quiet
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_report_reaches_the_page_as_in_its_fixture() {
        let notes = vec!["Close Ubisoft Connect so Lamplit can quiet it.".into()];
        let report = Report { state: State::Partly, active: true, notes };
        assert_eq!(serde_json::to_value(report).unwrap(), ipc_fixture!("quiet"));
        let states = <State as strum::VariantArray>::VARIANTS;
        assert_eq!(serde_json::to_value(states).unwrap(), ipc_fixture!("values")["quiet_state"]);
    }

    #[test]
    fn summarizes_the_switches() {
        assert_eq!(summarize(&[true, true]), State::On);
        assert_eq!(summarize(&[false, false]), State::Off);
        assert_eq!(summarize(&[true, false, true]), State::Partly);
    }
}
