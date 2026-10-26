// The things the player holds or wears: the PRO X 2 headset and the controllers, as the Settings screen shows them,
// and where the sound goes. Windows doesn't move the sound when the headset turns off (its receiver stays plugged
// in) or when headphones go into a controller, so Lamplit does: headphones in a wired controller first, then the
// headset while it is on, else back to the device the sound was on before (or the TV). The player can switch that
// off.

use super::audio::{self, Device, Flow, Kind};
use super::headset::{self, Headset};
use super::pad::{Controller, Controllers};
use crate::error::Result;
use crate::events::{self, Event};
use crate::prefs;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct Accessories {
    pub headset: headset::Status,
    pub controllers: Vec<Controller>,
}

pub fn state(app: &AppHandle) -> Accessories {
    Accessories { headset: app.state::<Headset>().status(), controllers: app.state::<Controllers>().list() }
}

pub fn set_sound_follows(app: &AppHandle, on: bool) -> Result<()> {
    prefs::change(app, |p| p.sound_follows = on)?;
    if on {
        settle_sound(app);
    }
    Ok(())
}

pub fn set_touchpad_mouse(app: &AppHandle, on: bool) -> Result<()> {
    prefs::change(app, |p| p.touchpad_mouse = on)?;
    log::info!("touchpad as mouse {}", if on { "on" } else { "off" });
    Ok(())
}

/// Lamplit found the headset off at start while Windows still sends the sound to its receiver: move the sound. Only
/// off the headset: at start the controllers may not have reported yet, and settle_sound would take the sound off a
/// controller's headphone jack that is in use.
pub fn move_sound_off_headset_found_off(app: &AppHandle) {
    if audio::state().is_ok_and(|s| s.outputs.iter().any(|d| d.default && d.kind == Kind::Headset)) {
        settle_sound(app);
    }
}

/// The output and the microphone Lamplit moved the sound away from, to go back to. Holding the lock also makes moves
/// one at a time: the headset's thread and each controller's can all ask.
static MOVED_FROM: Mutex<[Option<String>; 2]> = Mutex::new([None, None]);

/// Puts the sound where it belongs now (see the top of this file), when the player lets Lamplit do that. Called when
/// the headset turns on or off and when headphones go into or out of a controller.
pub fn settle_sound(app: &AppHandle) {
    if !prefs::get(app).sound_follows {
        return;
    }
    let mut moved_from = MOVED_FROM.lock();
    let jack = app.state::<Controllers>().list().iter().any(Controller::routes_sound);
    let want = wanted(jack, app.state::<Headset>().status().on == Some(true));
    let Ok(sound) = audio::state() else { return };
    let [output_from, input_from] = &mut *moved_from;
    for (devices, from, output) in [(&sound.outputs, output_from, true), (&sound.inputs, input_from, false)] {
        let what = if output { "output" } else { "microphone" };
        // A TV has no microphone to go back to.
        let device = match pick(devices, want, from.as_deref(), output.then_some(Kind::Tv)) {
            Pick::Stay => continue,
            Pick::Switch(device) => device,
            Pick::Missing => {
                log::info!("sound: no {what} to move to");
                continue;
            }
            // Two wired controllers both show up as sound devices, and Lamplit can't tell which one has the headphones.
            Pick::Ambiguous(n) => {
                log::info!("sound: {n} devices could be the {what}; not guessing which");
                continue;
            }
        };
        let players_own = devices.iter().find(|d| d.default && !d.kind.follows()).map(|d| d.id.clone());
        match audio::move_default(if output { Flow::Output } else { Flow::Input }, &device.id) {
            Ok(()) => {
                // Remember the player's own device when the sound leaves it, and forget it once back.
                if want.is_none() {
                    *from = None;
                } else if players_own.is_some() {
                    *from = players_own;
                }
                log::info!("sound: {what} is now {}", device.windows_name);
                // The page shows which device is in use; the news that set off this move came before it.
                events::emit(app, Event::Accessories);
                if output {
                    events::emit(app, Event::Notice(format!("Sound: {}", device.name)));
                }
            }
            Err(e) => log::warn!("sound: couldn't switch to {}: {e}", device.windows_name),
        }
    }
}

/// The kind of device the sound follows to: headphones in a wired controller, else the headset while it is on.
/// None: neither, so the sound goes back.
fn wanted(jack: bool, headset_on: bool) -> Option<Kind> {
    if jack {
        Some(Kind::Controller)
    } else if headset_on {
        Some(Kind::Headset)
    } else {
        None
    }
}

/// What settle_sound does in one direction.
#[derive(Debug, PartialEq)]
enum Pick<'a> {
    /// The default device is right as it is.
    Stay,
    Switch(&'a Device),
    /// No device fits.
    Missing,
    /// This many devices fit and none is the default, so Lamplit doesn't guess.
    Ambiguous(usize),
}

/// The device among `devices` (one direction) to make the default. Following (`want` Some), it is the device of that
/// kind. Going back (None) only moves the sound off the headset or a controller, never off the player's own choice:
/// to `back_to` (the device it was moved away from) while that is still there, else to the one `fallback` device.
fn pick<'a>(devices: &'a [Device], want: Option<Kind>, back_to: Option<&str>, fallback: Option<Kind>) -> Pick<'a> {
    let default = devices.iter().find(|d| d.default);
    let kind = match want {
        Some(kind) if default.is_some_and(|d| d.kind == kind) => return Pick::Stay,
        Some(kind) => Some(kind),
        None if !default.is_some_and(|d| d.kind.follows()) => return Pick::Stay,
        None => {
            if let Some(device) = back_to.and_then(|id| devices.iter().find(|d| d.id == id)) {
                return Pick::Switch(device);
            }
            fallback
        }
    };
    let fits: Vec<&Device> = devices.iter().filter(|d| Some(d.kind) == kind).collect();
    match fits[..] {
        [] => Pick::Missing,
        [device] => Pick::Switch(device),
        _ => Pick::Ambiguous(fits.len()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::{Charge, pad};

    #[test]
    fn accessories_reach_the_page_as_in_their_fixture() {
        let headset = headset::Status {
            receiver: true,
            on: Some(true),
            battery: Some(80),
            charge: Some(Charge::Charging),
            sidetone: Some(40),
            auto_off: Some(30),
        };
        let dualsense = Controller {
            id: r"\\?\hid#{00001124-0000-1000-8000-00805f9b34fb}_vid&0002054c_pid&0ce6".into(),
            kind: pad::Kind::DualSense,
            name: "DualSense".into(),
            connection: pad::Connection::Bluetooth,
            battery: Some(pad::Battery { percent: Some(60), level: None, charge: Some(Charge::Battery) }),
            headphones: Some(false),
            address: Some(1),
        };
        let xbox = Controller {
            id: "xinput:0".into(),
            kind: pad::Kind::Xbox,
            name: "Xbox controller".into(),
            connection: pad::Connection::Wireless,
            battery: Some(pad::Battery { percent: None, level: Some(pad::Level::Medium), charge: None }),
            headphones: None,
            address: None,
        };
        let accessories = Accessories { headset, controllers: vec![dualsense, xbox] };
        assert_eq!(serde_json::to_value(accessories).unwrap(), ipc_fixture!("accessories"));
        let values = ipc_fixture!("values");
        let charges = <Charge as strum::VariantArray>::VARIANTS;
        assert_eq!(serde_json::to_value(charges).unwrap(), values["charge"]);
        let kinds = <pad::Kind as strum::VariantArray>::VARIANTS;
        assert_eq!(serde_json::to_value(kinds).unwrap(), values["pad_kind"]);
        let connections = <pad::Connection as strum::VariantArray>::VARIANTS;
        assert_eq!(serde_json::to_value(connections).unwrap(), values["connection"]);
        let levels = <pad::Level as strum::VariantArray>::VARIANTS;
        assert_eq!(serde_json::to_value(levels).unwrap(), values["battery_level"]);
    }

    fn device(id: &str, kind: Kind, default: bool) -> Device {
        Device { id: id.into(), windows_name: id.into(), name: id.into(), kind, default }
    }

    #[test]
    fn headphones_in_a_controller_win() {
        assert_eq!(wanted(true, true), Some(Kind::Controller));
        assert_eq!(wanted(false, true), Some(Kind::Headset));
        assert_eq!(wanted(false, false), None);
    }

    #[test]
    fn follows_to_the_headset_and_controller() {
        let devices = [device("tv", Kind::Tv, true), device("headset", Kind::Headset, false)];
        assert_eq!(pick(&devices, Some(Kind::Headset), None, Some(Kind::Tv)), Pick::Switch(&devices[1]));
        let on_it = [device("tv", Kind::Tv, false), device("headset", Kind::Headset, true)];
        assert_eq!(pick(&on_it, Some(Kind::Headset), None, Some(Kind::Tv)), Pick::Stay);
        let two_pads =
            [device("tv", Kind::Tv, true), device("a", Kind::Controller, false), device("b", Kind::Controller, false)];
        assert_eq!(pick(&two_pads, Some(Kind::Controller), None, Some(Kind::Tv)), Pick::Ambiguous(2));
        assert_eq!(pick(&devices, Some(Kind::Controller), None, Some(Kind::Tv)), Pick::Missing);
    }

    #[test]
    fn goes_back_where_it_came_from() {
        let devices = [
            device("tv", Kind::Tv, false),
            device("soundbar", Kind::Other, false),
            device("headset", Kind::Headset, true),
        ];
        assert_eq!(pick(&devices, None, Some("soundbar"), Some(Kind::Tv)), Pick::Switch(&devices[1]));
        // The soundbar is gone: the TV.
        assert_eq!(pick(&devices, None, Some("unplugged"), Some(Kind::Tv)), Pick::Switch(&devices[0]));
        // A microphone has no TV to fall back to.
        assert_eq!(pick(&devices, None, None, None), Pick::Missing);
    }

    #[test]
    fn falls_back_to_the_tv_only_when_there_is_one() {
        let screens =
            [device("monitor", Kind::Tv, false), device("tv", Kind::Tv, false), device("headset", Kind::Headset, true)];
        assert_eq!(pick(&screens, None, None, Some(Kind::Tv)), Pick::Ambiguous(2));
        let no_screen = [device("speakers", Kind::Other, false), device("headset", Kind::Headset, true)];
        assert_eq!(pick(&no_screen, None, None, Some(Kind::Tv)), Pick::Missing);
    }

    #[test]
    fn leaves_the_players_own_choice() {
        let devices = [device("tv", Kind::Tv, false), device("soundbar", Kind::Other, true)];
        assert_eq!(pick(&devices, None, Some("tv"), Some(Kind::Tv)), Pick::Stay);
    }
}
