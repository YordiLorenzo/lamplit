// The things the player holds or wears: the PRO X 2 headset and the controllers, as the Settings screen shows them,
// and where the sound goes. Windows doesn't move the sound when the headset turns off (its receiver stays plugged
// in) or when headphones go into a controller, so Lamplit does: headphones in a wired controller first, then the
// headset while it is on, else back to the device the sound was on before (or the TV). The player can switch that
// off.

use super::audio::{self, Device, Flow, Kind};
use super::headset::{self, Headset};
use super::pad::{Controller, Controllers};
use crate::data;
use crate::error::Result;
use crate::events::{self, Event};
use crate::prefs;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
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

const SOUND_FILE: &str = "sound-return.json";

/// Holding this lock also serialises a player's choice with moves made by the headset and controller threads.
pub struct SoundRouting(Mutex<Routes>);

#[derive(Clone, Default, Deserialize, PartialEq, Serialize)]
#[serde(default)]
struct Routes {
    output: Route,
    input: Route,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
struct Route {
    back_to: Option<String>,
    /// The last default Lamplit set or saw after it disappeared. A different default while this one is still
    /// available is the player's newer choice, not permission to restore the old one.
    via: Option<String>,
}

pub fn load_sound_routing() -> SoundRouting {
    SoundRouting(Mutex::new(data::load_or_default(SOUND_FILE)))
}

impl Routes {
    fn save_if_changed(&self, before: &Self) {
        if self != before
            && let Err(e) = data::save(SOUND_FILE, self)
        {
            log::warn!("sound: couldn't save the return devices: {e}");
        }
    }

    fn chosen(&mut self, sound: &audio::Sound, id: &str) {
        for (devices, route) in [(&sound.outputs, &mut self.output), (&sound.inputs, &mut self.input)] {
            if devices.iter().any(|d| d.id == id) {
                *route = Route::default();
            }
        }
    }
}

impl Route {
    /// Windows also changes defaults when an endpoint disappears. Keep the return record through that, but let
    /// a newer choice win when the previous default is still available.
    fn observe(&mut self, devices: &[Device]) -> bool {
        let Some(default) = devices.iter().find(|d| d.default) else { return false };
        if self.back_to.is_none() {
            return false;
        }
        let changed = self.via.as_deref() != Some(&default.id);
        let via_there = devices.iter().any(|d| Some(d.id.as_str()) == self.via.as_deref());
        if self.back_to.as_deref() == Some(&default.id) {
            // Back where it came from while the device it went to is still there: someone chose it, and the return is
            // done. With that device gone, Windows put it back by itself, and an accessory still on may want it.
            if via_there {
                *self = Self::default();
            }
            return via_there;
        }
        if changed && via_there {
            *self = Self::default();
            return true;
        }
        self.via = Some(default.id.clone());
        false
    }

    fn moved(&mut self, devices: &[Device], device: &Device, following: bool) {
        if following && self.back_to.is_none() {
            self.back_to = devices.iter().find(|d| d.default && !d.kind.follows()).map(|d| d.id.clone());
        }
        if self.back_to.as_deref() == Some(&device.id) {
            *self = Self::default();
        } else if self.back_to.is_some() {
            self.via = Some(device.id.clone());
        }
    }
}

/// An explicit choice cancels a pending return in that direction, even when the player picks the current default.
pub fn set_sound_default(app: &AppHandle, id: &str) -> Result<audio::Sound> {
    let state = app.state::<SoundRouting>();
    let mut routes = state.0.lock();
    let sound = audio::state()?;
    audio::set_default(id).inspect_err(|e| log::warn!("can't switch audio to {id}: {e}"))?;
    let before = routes.clone();
    routes.chosen(&sound, id);
    routes.save_if_changed(&before);
    log::info!("audio device switched to {id}");
    audio::state()
}

/// The TV may have been off at start. Upkeep checks pending returns, without starting new moves to accessories.
pub fn catch_up_sound(app: &AppHandle) {
    route_sound(app, false);
}

/// Puts the sound where it belongs now (see the top of this file), when the player lets Lamplit do that. Called when
/// the headset turns on or off and when headphones go into or out of a controller.
pub fn settle_sound(app: &AppHandle) {
    route_sound(app, true);
}

fn route_sound(app: &AppHandle, follow: bool) {
    if !prefs::get(app).sound_follows {
        return;
    }
    let state = app.state::<SoundRouting>();
    let mut routes = state.0.lock();
    if !follow && routes.output.back_to.is_none() && routes.input.back_to.is_none() {
        return;
    }
    let controllers = app.state::<Controllers>().list();
    let headset = app.state::<Headset>().status();
    let want = wanted(controllers.iter().any(Controller::routes_sound), headset.on == Some(true));
    let mut wired = controllers
        .iter()
        .filter(|c| c.kind == super::pad::Kind::DualSense && c.connection == super::pad::Connection::Usb)
        .peekable();
    let jacks_known = wired.peek().is_some() && wired.all(|c| c.headphones.is_some());
    let Ok(sound) = audio::state() else { return };
    let before = routes.clone();
    let Routes { output, input } = &mut *routes;
    for (devices, route, output) in [(&sound.outputs, output, true), (&sound.inputs, input, false)] {
        if route.observe(devices) {
            continue;
        }
        if !follow && (want.is_some() || route.back_to.is_none()) {
            continue;
        }
        // At start an accessory can still be reporting whether it is in use. Never take its sound away on that
        // incomplete information; a later upkeep or its status report will try again.
        if !follow
            && devices.iter().any(|d| {
                d.default
                    && match d.kind {
                        Kind::Headset => headset.receiver && headset.on.is_none(),
                        Kind::Controller => !jacks_known,
                        _ => false,
                    }
            })
        {
            continue;
        }
        let what = if output { "output" } else { "microphone" };
        // A TV has no microphone to go back to.
        let device = match pick(devices, want, route.back_to.as_deref(), output.then_some(Kind::Tv)) {
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
        match audio::move_default(if output { Flow::Output } else { Flow::Input }, &device.id) {
            Ok(()) => {
                route.moved(devices, device, want.is_some());
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
    routes.save_if_changed(&before);
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
/// kind. Going back (None) restores a pending return, else only moves off an accessory. Route::observe must first
/// discard a return superseded by the player's choice. A missing return stays recorded even after a fallback.
fn pick<'a>(devices: &'a [Device], want: Option<Kind>, back_to: Option<&str>, fallback: Option<Kind>) -> Pick<'a> {
    let default = devices.iter().find(|d| d.default);
    let kind = match want {
        Some(kind) if default.is_some_and(|d| d.kind == kind) => return Pick::Stay,
        Some(kind) => Some(kind),
        None => {
            if let Some(device) = back_to.and_then(|id| devices.iter().find(|d| d.id == id)) {
                return if device.default { Pick::Stay } else { Pick::Switch(device) };
            }
            if !default.is_some_and(|d| d.kind.follows()) {
                return Pick::Stay;
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
        assert_eq!(pick(&devices, None, None, Some(Kind::Tv)), Pick::Stay);
    }

    fn returning(back_to: &str, via: &str) -> Route {
        Route { back_to: Some(back_to.into()), via: Some(via.into()) }
    }

    #[test]
    fn remembers_the_soundbar_and_microphone_across_a_restart() {
        let devices = [device("soundbar", Kind::Other, true), device("headset", Kind::Headset, false)];
        let mut routes = Routes::default();
        routes.output.moved(&devices, &devices[1], true);
        routes.input = returning("desk-mic", "headset-mic");
        let saved = serde_json::to_string(&routes).unwrap();
        let mut loaded: Routes = serde_json::from_str(&saved).unwrap();
        assert_eq!(loaded.output, returning("soundbar", "headset"));
        assert_eq!(loaded.input, returning("desk-mic", "headset-mic"));
        let after = [device("soundbar", Kind::Other, false), device("headset", Kind::Headset, true)];
        assert!(!loaded.output.observe(&after));
        assert_eq!(pick(&after, None, loaded.output.back_to.as_deref(), Some(Kind::Tv)), Pick::Switch(&after[0]));
        loaded.output.moved(&after, &after[0], false);
        assert_eq!(loaded.output, Route::default());
        assert_eq!(loaded.input, returning("desk-mic", "headset-mic"));
    }

    #[test]
    fn a_tv_off_at_start_can_return_later() {
        let mut route = returning("tv", "headset");
        let missing = [device("headset", Kind::Headset, true)];
        assert!(!route.observe(&missing));
        assert_eq!(pick(&missing, None, route.back_to.as_deref(), Some(Kind::Tv)), Pick::Missing);
        assert_eq!(route, returning("tv", "headset"));
        let back = [device("tv", Kind::Tv, false), device("headset", Kind::Headset, true)];
        assert!(!route.observe(&back));
        assert_eq!(pick(&back, None, route.back_to.as_deref(), Some(Kind::Tv)), Pick::Switch(&back[0]));
    }

    #[test]
    fn a_fallback_does_not_replace_the_missing_soundbar() {
        let mut route = returning("soundbar", "headset");
        let devices = [device("tv", Kind::Tv, false), device("headset", Kind::Headset, true)];
        assert_eq!(pick(&devices, None, route.back_to.as_deref(), Some(Kind::Tv)), Pick::Switch(&devices[0]));
        route.moved(&devices, &devices[0], false);
        assert_eq!(route, returning("soundbar", "tv"));
        let on_tv = [device("tv", Kind::Tv, true), device("headset", Kind::Headset, false)];
        assert!(!route.observe(&on_tv));
        assert_eq!(pick(&on_tv, None, route.back_to.as_deref(), Some(Kind::Tv)), Pick::Stay);
        let back = [device("tv", Kind::Tv, true), device("soundbar", Kind::Other, false)];
        assert!(!route.observe(&back));
        assert_eq!(pick(&back, None, route.back_to.as_deref(), Some(Kind::Tv)), Pick::Switch(&back[1]));
    }

    #[test]
    fn windows_putting_it_back_on_the_tv_still_lets_the_headset_take_it() {
        // TV, then controller headphones, then the headset on, then the controller goes and Windows picks the TV.
        let mut route = returning("tv", "controller");
        let devices = [device("tv", Kind::Tv, true), device("headset", Kind::Headset, false)];
        assert!(!route.observe(&devices));
        assert_eq!(
            pick(&devices, Some(Kind::Headset), route.back_to.as_deref(), Some(Kind::Tv)),
            Pick::Switch(&devices[1])
        );
        // The player choosing the TV while the controller is still there ends the return.
        let mut chosen = returning("tv", "controller");
        let both = [device("tv", Kind::Tv, true), device("controller", Kind::Controller, false)];
        assert!(chosen.observe(&both));
        assert_eq!(chosen, Route::default());
    }

    #[test]
    fn windows_falling_back_when_a_device_goes_keeps_the_return() {
        let mut route = returning("soundbar", "controller");
        assert!(!route.observe(&[]));
        assert_eq!(route, returning("soundbar", "controller"));
        let fallback = [device("speakers", Kind::Other, true)];
        assert!(!route.observe(&fallback));
        assert_eq!(route, returning("soundbar", "speakers"));
        let back = [device("speakers", Kind::Other, true), device("soundbar", Kind::Other, false)];
        assert!(!route.observe(&back));
        assert_eq!(pick(&back, None, route.back_to.as_deref(), Some(Kind::Tv)), Pick::Switch(&back[1]));
    }

    #[test]
    fn a_newer_windows_choice_wins_even_while_the_return_device_is_missing() {
        let mut route = returning("soundbar", "headset");
        let chosen = [device("speakers", Kind::Other, true), device("headset", Kind::Headset, false)];
        assert!(route.observe(&chosen));
        assert_eq!(route, Route::default());
        let back = [device("speakers", Kind::Other, true), device("soundbar", Kind::Other, false)];
        assert_eq!(pick(&back, None, route.back_to.as_deref(), Some(Kind::Tv)), Pick::Stay);
        // Choosing an accessory explicitly wins too, even though it normally follows the player.
        let mut route = returning("soundbar", "headset");
        let chosen = [device("controller", Kind::Controller, true), device("headset", Kind::Headset, false)];
        assert!(route.observe(&chosen));
        assert_eq!(route, Route::default());
    }

    #[test]
    fn choosing_the_current_device_cancels_only_that_directions_return() {
        let sound = audio::Sound {
            outputs: vec![device("headset", Kind::Headset, true)],
            inputs: vec![device("headset-mic", Kind::Headset, true)],
            volume: None,
            muted: None,
            mic_muted: None,
        };
        let mut routes = Routes { output: returning("tv", "headset"), input: returning("desk-mic", "headset-mic") };
        routes.chosen(&sound, "headset");
        assert_eq!(routes.output, Route::default());
        assert_eq!(routes.input, returning("desk-mic", "headset-mic"));
        routes.chosen(&sound, "headset-mic");
        assert_eq!(routes.input, Route::default());
    }

    #[test]
    fn going_from_headset_to_controller_keeps_the_original_return() {
        let mut route = returning("soundbar", "headset");
        let devices = [device("headset", Kind::Headset, true), device("controller", Kind::Controller, false)];
        route.moved(&devices, &devices[1], true);
        assert_eq!(route, returning("soundbar", "controller"));
    }

    #[test]
    fn returning_without_lamplit_clears_the_record() {
        let mut route = returning("tv", "headset");
        assert!(route.observe(&[device("tv", Kind::Tv, true)]));
        assert_eq!(route, Route::default());
        assert_eq!(serde_json::from_str::<Routes>("{}").unwrap().output, Route::default());
    }
}
