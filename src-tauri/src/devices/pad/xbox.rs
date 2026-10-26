// Xbox controllers, and the many others that work like one (8BitDo, PowerA, a Logitech in its X mode), through
// XInput's four slots. XInput reads them while a game is in front too, so holding View and Menu brings Lamplit
// forward; the Xbox button belongs to Windows' Game Bar, and XInput documents no way to read it.
//
// While a Steam game runs, Steam Input adds a virtual Xbox controller to XInput for each controller it handles. That
// is a second copy of a controller Lamplit already reads (a DualSense over HID, an Xbox controller in its own slot),
// so a slot that holds one is left alone. Programs that add virtual controllers without Valve's ids (DS4Windows) can
// still show one controller twice.

use super::navigation::{Action, Dir, Input, Navigation};
use super::{Battery, Connection, Controller, Kind, Level};
use crate::win::xinput;
use std::time::Instant;
use tauri::AppHandle;
use windows::Win32::UI::Input::XboxController::{
    BATTERY_LEVEL_EMPTY, BATTERY_LEVEL_LOW, BATTERY_LEVEL_MEDIUM, BATTERY_TYPE_ALKALINE, BATTERY_TYPE_NIMH,
    XINPUT_BATTERY_INFORMATION, XINPUT_CAPS_WIRELESS, XINPUT_GAMEPAD, XINPUT_GAMEPAD_A, XINPUT_GAMEPAD_B,
    XINPUT_GAMEPAD_BACK, XINPUT_GAMEPAD_BUTTON_FLAGS, XINPUT_GAMEPAD_DPAD_DOWN, XINPUT_GAMEPAD_DPAD_LEFT,
    XINPUT_GAMEPAD_DPAD_RIGHT, XINPUT_GAMEPAD_DPAD_UP, XINPUT_GAMEPAD_LEFT_SHOULDER, XINPUT_GAMEPAD_RIGHT_SHOULDER,
    XINPUT_GAMEPAD_START, XINPUT_GAMEPAD_X, XINPUT_GAMEPAD_Y,
};

const MICROSOFT: u16 = 0x045E;
/// Steam Input's virtual controller: Valve's vendor id, as SDL tells it apart.
const STEAM_VIRTUAL: (u16, u16) = (0x28DE, 0x11FF);

/// What is in each of XInput's slots.
#[derive(Default)]
pub struct Slots([Option<Pad>; xinput::SLOTS as usize]);

struct Pad {
    /// The controller's USB ids, when Windows says: other ids in the same slot are another controller.
    ids: Option<(u16, u16)>,
    /// Steam Input's virtual controller: in the slot, but not read.
    steam: bool,
    navigation: Navigation,
}

impl Slots {
    /// Looks for controllers that came or went, and how full the batteries are.
    pub fn look(&mut self, app: &AppHandle) {
        for (slot, pad) in (0..).zip(&mut self.0) {
            let state = xinput::state(slot);
            let ids = state.and_then(|_| xinput::ids(slot));
            // Gone, or another controller took the slot. Ids that couldn't be read this time say nothing.
            if pad.as_ref().is_some_and(|p| state.is_none() || (ids.is_some() && p.ids != ids)) {
                forget(app, slot, pad);
            }
            let Some(state) = state else { continue };
            if let Some(pad) = pad {
                if !pad.steam {
                    super::set_battery(app, &id(slot), xinput::battery(slot).and_then(battery));
                }
                continue;
            }
            let steam = ids == Some(STEAM_VIRTUAL);
            if steam {
                log::info!("controller: XInput slot {} is Steam Input's virtual controller; not read", slot + 1);
            } else {
                let controller = controller(slot, ids);
                let at = ids.map(|(v, p)| format!(" ({v:04X}:{p:04X})")).unwrap_or_default();
                log::info!("controller: {}{at} in XInput slot {}", controller.name, slot + 1);
                super::list(app, controller);
            }
            *pad = Some(Pad { ids, steam, navigation: Navigation::starting_from(input(&state)) });
        }
    }

    /// Reads each controller once: the steps its buttons make by `now`.
    pub fn read(&mut self, app: &AppHandle, now: Instant) -> Vec<Action> {
        let mut actions = Vec::new();
        for (slot, pad) in (0..).zip(&mut self.0) {
            let Some(navigation) = pad.as_mut().filter(|p| !p.steam).map(|p| &mut p.navigation) else { continue };
            let Some(state) = xinput::state(slot) else {
                forget(app, slot, pad);
                continue;
            };
            actions.extend(navigation.update(input(&state), now));
            actions.extend(navigation.tick(now));
        }
        actions
    }

    /// A controller is being read, so it is worth asking often.
    pub fn reading(&self) -> bool {
        self.0.iter().flatten().any(|p| !p.steam)
    }
}

fn id(slot: u32) -> String {
    format!("xinput:{slot}")
}

/// Empties a slot whose controller is gone.
fn forget(app: &AppHandle, slot: u32, pad: &mut Option<Pad>) {
    if pad.take().is_some_and(|p| !p.steam) {
        log::info!("controller: XInput slot {} is empty", slot + 1);
        super::unlist(app, &id(slot));
    }
}

fn controller(slot: u32, ids: Option<(u16, u16)>) -> Controller {
    let wireless = xinput::capabilities(slot).is_some_and(|c| c.Flags.contains(XINPUT_CAPS_WIRELESS));
    let microsoft = ids.is_some_and(|(vendor, _)| vendor == MICROSOFT);
    Controller {
        id: id(slot),
        kind: Kind::Xbox,
        name: (if microsoft { "Xbox controller" } else { "Xbox-style controller" }).into(),
        connection: if wireless { Connection::Wireless } else { Connection::Usb },
        battery: xinput::battery(slot).and_then(battery),
        headphones: None,
        address: None,
    }
}

/// Buttons, and the direction from the d-pad or else the left stick (whose y grows away from the player).
fn input(pad: &XINPUT_GAMEPAD) -> Input {
    let down = |button: XINPUT_GAMEPAD_BUTTON_FLAGS| pad.wButtons.contains(button);
    // A diagonal is sideways, as on the DualSense.
    let dpad = if down(XINPUT_GAMEPAD_DPAD_LEFT) {
        Some(Dir::Left)
    } else if down(XINPUT_GAMEPAD_DPAD_RIGHT) {
        Some(Dir::Right)
    } else if down(XINPUT_GAMEPAD_DPAD_UP) {
        Some(Dir::Up)
    } else if down(XINPUT_GAMEPAD_DPAD_DOWN) {
        Some(Dir::Down)
    } else {
        None
    };
    let axis = |v: i16| f32::from(v) / 32768.0;
    Input {
        dir: dpad.or(Dir::of_stick(axis(pad.sThumbLX), -axis(pad.sThumbLY))),
        south: down(XINPUT_GAMEPAD_A),
        east: down(XINPUT_GAMEPAD_B),
        west: down(XINPUT_GAMEPAD_X),
        north: down(XINPUT_GAMEPAD_Y),
        l1: down(XINPUT_GAMEPAD_LEFT_SHOULDER),
        r1: down(XINPUT_GAMEPAD_RIGHT_SHOULDER),
        menu: down(XINPUT_GAMEPAD_START),
        view: down(XINPUT_GAMEPAD_BACK),
        home: false,
    }
}

/// A wireless controller's rough level. A wired one has no battery to report, and one of unknown type no level
/// worth showing.
fn battery(info: XINPUT_BATTERY_INFORMATION) -> Option<Battery> {
    if ![BATTERY_TYPE_ALKALINE, BATTERY_TYPE_NIMH].contains(&info.BatteryType) {
        return None;
    }
    Some(Battery::level(match info.BatteryLevel {
        BATTERY_LEVEL_EMPTY => Level::Empty,
        BATTERY_LEVEL_LOW => Level::Low,
        BATTERY_LEVEL_MEDIUM => Level::Medium,
        _ => Level::Full,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::UI::Input::XboxController::{
        BATTERY_LEVEL, BATTERY_LEVEL_FULL, BATTERY_TYPE_DISCONNECTED, BATTERY_TYPE_UNKNOWN, BATTERY_TYPE_WIRED,
    };

    fn pad(buttons: XINPUT_GAMEPAD_BUTTON_FLAGS, x: i16, y: i16) -> XINPUT_GAMEPAD {
        XINPUT_GAMEPAD { wButtons: buttons, sThumbLX: x, sThumbLY: y, ..XINPUT_GAMEPAD::default() }
    }

    #[test]
    fn buttons_by_where_they_sit() {
        let i = input(&pad(XINPUT_GAMEPAD_A | XINPUT_GAMEPAD_Y | XINPUT_GAMEPAD_START, 0, 0));
        assert!(i.south && i.north && i.menu);
        assert!(!i.east && !i.west && !i.view && !i.home);
        let i =
            input(&pad(XINPUT_GAMEPAD_B | XINPUT_GAMEPAD_X | XINPUT_GAMEPAD_BACK | XINPUT_GAMEPAD_LEFT_SHOULDER, 0, 0));
        assert!(i.east && i.west && i.view && i.l1 && !i.r1 && !i.south);
        assert!(input(&pad(XINPUT_GAMEPAD_RIGHT_SHOULDER, 0, 0)).r1);
    }

    #[test]
    fn the_dpad_wins_over_the_stick() {
        let dir = |buttons, x, y| input(&pad(buttons, x, y)).dir;
        let none = XINPUT_GAMEPAD_BUTTON_FLAGS(0);
        assert_eq!(dir(XINPUT_GAMEPAD_DPAD_UP, 30000, 0), Some(Dir::Up));
        assert_eq!(dir(XINPUT_GAMEPAD_DPAD_UP | XINPUT_GAMEPAD_DPAD_RIGHT, 0, 0), Some(Dir::Right));
        assert_eq!(dir(XINPUT_GAMEPAD_DPAD_DOWN, 0, 0), Some(Dir::Down));
        assert_eq!(dir(XINPUT_GAMEPAD_DPAD_LEFT, 0, 0), Some(Dir::Left));
        // The stick: up is positive in XInput.
        assert_eq!(dir(none, 0, 32767), Some(Dir::Up));
        assert_eq!(dir(none, 0, -32768), Some(Dir::Down));
        assert_eq!(dir(none, -20000, 5000), Some(Dir::Left));
        // Resting, or inside the dead zone.
        assert_eq!(dir(none, 12000, -12000), None);
    }

    #[test]
    fn a_wireless_controller_reports_a_rough_level() {
        let info = |kind, level: BATTERY_LEVEL| XINPUT_BATTERY_INFORMATION { BatteryType: kind, BatteryLevel: level };
        assert_eq!(battery(info(BATTERY_TYPE_NIMH, BATTERY_LEVEL_LOW)), Some(Battery::level(Level::Low)));
        assert_eq!(battery(info(BATTERY_TYPE_ALKALINE, BATTERY_LEVEL_FULL)), Some(Battery::level(Level::Full)));
        assert_eq!(battery(info(BATTERY_TYPE_NIMH, BATTERY_LEVEL_EMPTY)), Some(Battery::level(Level::Empty)));
        assert_eq!(battery(info(BATTERY_TYPE_NIMH, BATTERY_LEVEL_MEDIUM)), Some(Battery::level(Level::Medium)));
        for kind in [BATTERY_TYPE_WIRED, BATTERY_TYPE_UNKNOWN, BATTERY_TYPE_DISCONNECTED] {
            assert_eq!(battery(info(kind, BATTERY_LEVEL_FULL)), None);
        }
    }
}
