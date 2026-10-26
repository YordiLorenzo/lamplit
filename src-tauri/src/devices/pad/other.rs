// Other controllers (a DualShock 4, a Switch Pro Controller, a plain USB pad) through Windows.Gaming.Input, which
// reads any controller Windows knows without taking it from anyone. Windows hands its input only to the program in
// front, so these controllers move around Lamplit but can't bring it over a game.
//
// Controllers read another way are left out: the DualSense (over HID), Xbox-style ones (XInput, which reads them
// behind a game too), and Valve's, which are Steam Input's own. Windows.Gaming.Input knows the Xbox-style ones as
// gamepads, but a driver can make another controller a gamepad too, so a gamepad is left out only while XInput has
// it; otherwise it is read as a gamepad, whose buttons have names.
//
// Any other controller comes as a RawGameController, which numbers the buttons without saying which is which.
// Lamplit takes the order most DirectInput controllers use, the DualShock 4's and Logitech's among them.

use super::navigation::{Action, Dir, Input, Navigation};
use super::{Battery, Connection, Controller, Kind, dualsense, xbox};
use crate::devices::Charge;
use crate::launch::window;
use std::collections::HashSet;
use std::time::Instant;
use tauri::AppHandle;
use windows::Gaming::Input::{
    GameControllerSwitchPosition, Gamepad, GamepadButtons, GamepadReading, RawGameController,
};
use windows::System::Power::BatteryStatus;

const VALVE: u16 = 0x28DE;

/// The controllers being read.
#[derive(Default)]
pub struct Others {
    pads: Vec<Pad>,
    /// Ids of the controllers left out, so each is logged once.
    left_out: HashSet<String>,
    /// Windows.Gaming.Input failed last time, so the next failure isn't logged again.
    failed: bool,
}

struct Pad {
    id: String,
    kind: Kind,
    raw: RawGameController,
    /// Some for a gamepad XInput doesn't have, which is read with its buttons by name.
    gamepad: Option<Gamepad>,
    buttons: Vec<bool>,
    switches: Vec<GameControllerSwitchPosition>,
    axes: Vec<f64>,
    /// None while Lamplit isn't in front, when Windows sends it nothing: reading starts over when it comes back.
    navigation: Option<Navigation>,
}

impl Others {
    /// Looks for controllers that came or went, and how full the batteries are. A gamepad is read here only while
    /// `xbox` doesn't read it, which can change from one look to the next.
    pub fn look(&mut self, app: &AppHandle, xbox: &xbox::Slots) {
        let found = match connected() {
            Ok(found) => {
                self.failed = false;
                found
            }
            Err(e) => {
                if !std::mem::replace(&mut self.failed, true) {
                    log::warn!("controller: Windows.Gaming.Input unavailable: {e}");
                }
                return;
            }
        };
        self.pads.retain(|pad| {
            let here = found.iter().any(|(id, _)| *id == pad.id);
            if !here {
                super::unlist(app, &pad.id);
            }
            here
        });
        self.left_out.retain(|id| found.iter().any(|(found, _)| found == id));
        for (id, raw) in found {
            let (vendor, product) = (raw.HardwareVendorId().unwrap_or(0), raw.HardwareProductId().unwrap_or(0));
            let gamepad = Gamepad::FromGameController(&raw).ok();
            let elsewhere = read_elsewhere(vendor, product, gamepad.is_some(), xbox.reads(vendor, product));
            let listed = self.pads.iter().position(|pad| pad.id == id);
            match (listed, elsewhere) {
                (Some(_), false) => super::set_battery(app, &id, battery(&raw)),
                (Some(at), true) => {
                    log::info!("controller: {vendor:04X}:{product:04X} is read through XInput now");
                    super::unlist(app, &self.pads.swap_remove(at).id);
                    self.left_out.insert(id);
                }
                (None, true) => {
                    if self.left_out.insert(id) {
                        let name = raw.DisplayName().map(|n| n.to_string()).unwrap_or_default();
                        log::info!("controller: {name} ({vendor:04X}:{product:04X}) is read another way, or by Steam");
                    }
                }
                (None, false) => {
                    self.left_out.remove(&id);
                    self.add(app, id, raw, gamepad, (vendor, product));
                }
            }
        }
    }

    fn add(&mut self, app: &AppHandle, id: String, raw: RawGameController, gamepad: Option<Gamepad>, ids: (u16, u16)) {
        let name = raw.DisplayName().map(|n| n.to_string()).unwrap_or_default();
        let (vendor, product) = ids;
        let way = if gamepad.is_some() { "a gamepad" } else { "a raw controller" };
        log::info!("controller: {name} ({vendor:04X}:{product:04X}) through Windows.Gaming.Input, as {way}");
        let count = |n: windows::core::Result<i32>| n.ok().and_then(|n| usize::try_from(n).ok()).unwrap_or(0);
        let wireless = raw.IsWireless().unwrap_or(false);
        let kind = if vendor == dualsense::SONY { Kind::PlayStation } else { Kind::Other };
        super::list(
            app,
            Controller {
                id: id.clone(),
                kind,
                name: if name.trim().is_empty() { "Controller".into() } else { name },
                connection: if wireless { Connection::Wireless } else { Connection::Usb },
                battery: battery(&raw),
                headphones: None,
                address: None,
            },
        );
        self.pads.push(Pad {
            id,
            kind,
            buttons: vec![false; count(raw.ButtonCount())],
            switches: vec![GameControllerSwitchPosition::Center; count(raw.SwitchCount())],
            axes: vec![0.5; count(raw.AxisCount())],
            raw,
            gamepad,
            navigation: None,
        });
    }

    /// Reads each controller once while Lamplit is in front: the steps its buttons make by `now`.
    pub fn read(&mut self, now: Instant) -> Vec<(Kind, Action)> {
        let in_front = window::lamplit_in_front();
        let mut actions = Vec::new();
        for pad in &mut self.pads {
            if !in_front {
                pad.navigation = None;
                continue;
            }
            let input = match &pad.gamepad {
                Some(gamepad) => match gamepad.GetCurrentReading() {
                    Ok(reading) => gamepad_input(&reading),
                    Err(_) => continue,
                },
                None => match pad.raw.GetCurrentReading(&mut pad.buttons, &mut pad.switches, &mut pad.axes) {
                    Ok(_) => input(&pad.buttons, pad.switches.first().copied(), &pad.axes),
                    Err(_) => continue,
                },
            };
            let navigation = pad.navigation.get_or_insert_with(|| Navigation::starting_from(input));
            let steps = navigation.update(input, now).into_iter().chain(navigation.tick(now));
            actions.extend(steps.map(|action| (pad.kind, action)));
        }
        actions
    }

    /// A controller is being read, so it is worth asking often.
    pub fn reading(&self) -> bool {
        !self.pads.is_empty()
    }
}

/// Every controller Windows.Gaming.Input knows, by an id that stays the same while it is connected.
fn connected() -> windows::core::Result<Vec<(String, RawGameController)>> {
    let list = RawGameController::RawGameControllers()?;
    (0..list.Size()?)
        .map(|i| {
            let raw = list.GetAt(i)?;
            Ok((format!("wgi:{}", raw.NonRoamableId()?), raw))
        })
        .collect()
}

/// Controllers read another way: a DualSense over HID, Valve's, which are Steam Input's own (its virtual controllers
/// among them), and a gamepad XInput reads (`in_xinput`), which Microsoft's always are.
fn read_elsewhere(vendor: u16, product: u16, gamepad: bool, in_xinput: bool) -> bool {
    dualsense::is(vendor, product) || vendor == VALVE || (gamepad && (vendor == xbox::MICROSOFT || in_xinput))
}

/// A gamepad's buttons, by name as on an Xbox controller, and the d-pad or else the left stick (whose y grows away
/// from the player).
fn gamepad_input(reading: &GamepadReading) -> Input {
    let down = |button: GamepadButtons| reading.Buttons.contains(button);
    // A diagonal is sideways, as on the DualSense.
    let dpad = if down(GamepadButtons::DPadLeft) {
        Some(Dir::Left)
    } else if down(GamepadButtons::DPadRight) {
        Some(Dir::Right)
    } else if down(GamepadButtons::DPadUp) {
        Some(Dir::Up)
    } else if down(GamepadButtons::DPadDown) {
        Some(Dir::Down)
    } else {
        None
    };
    let stick = Dir::of_stick(reading.LeftThumbstickX as f32, -reading.LeftThumbstickY as f32);
    Input {
        dir: dpad.or(stick),
        south: down(GamepadButtons::A),
        east: down(GamepadButtons::B),
        west: down(GamepadButtons::X),
        north: down(GamepadButtons::Y),
        l1: down(GamepadButtons::LeftShoulder),
        r1: down(GamepadButtons::RightShoulder),
        menu: down(GamepadButtons::Menu),
        view: down(GamepadButtons::View),
        home: false,
    }
}

/// Buttons in the order most DirectInput controllers send them: west (Square, X), south (Cross, A), east (Circle,
/// B), north (Triangle, Y), L1, R1, L2, R2, then View (Share, Back) and Menu (Options, Start). The direction comes
/// from the first hat switch, else the first two axes (0 to 1, y growing towards the player).
fn input(buttons: &[bool], hat: Option<GameControllerSwitchPosition>, axes: &[f64]) -> Input {
    let button = |i: usize| buttons.get(i).copied().unwrap_or(false);
    // A diagonal is sideways, as on the DualSense.
    let hat = match hat {
        Some(GameControllerSwitchPosition::Up) => Some(Dir::Up),
        Some(
            GameControllerSwitchPosition::UpRight
            | GameControllerSwitchPosition::Right
            | GameControllerSwitchPosition::DownRight,
        ) => Some(Dir::Right),
        Some(GameControllerSwitchPosition::Down) => Some(Dir::Down),
        Some(
            GameControllerSwitchPosition::DownLeft
            | GameControllerSwitchPosition::Left
            | GameControllerSwitchPosition::UpLeft,
        ) => Some(Dir::Left),
        _ => None,
    };
    let stick = match axes {
        [x, y, ..] => Dir::of_stick((*x as f32 - 0.5) * 2.0, (*y as f32 - 0.5) * 2.0),
        _ => None,
    };
    Input {
        dir: hat.or(stick),
        west: button(0),
        south: button(1),
        east: button(2),
        north: button(3),
        l1: button(4),
        r1: button(5),
        view: button(8),
        menu: button(9),
        home: false,
    }
}

/// The percent and charge state, when Windows has a battery report for the controller.
fn battery(raw: &RawGameController) -> Option<Battery> {
    let report = raw.TryGetBatteryReport().ok()?;
    let remaining = report.RemainingCapacityInMilliwattHours().ok()?.Value().ok()?;
    let full = report.FullChargeCapacityInMilliwattHours().ok()?.Value().ok()?;
    let percent = percent(remaining, full)?;
    Some(Battery::percent(percent, charge(report.Status().ok()?, percent)?))
}

fn percent(remaining: i32, full: i32) -> Option<u8> {
    (full > 0).then(|| (i64::from(remaining.clamp(0, full)) * 100 / i64::from(full)) as u8)
}

/// Idle is neither charging nor running down: full on its cable, or not charging.
fn charge(status: BatteryStatus, percent: u8) -> Option<Charge> {
    match status {
        BatteryStatus::Discharging => Some(Charge::Battery),
        BatteryStatus::Charging => Some(Charge::Charging),
        BatteryStatus::Idle if percent >= 95 => Some(Charge::Full),
        BatteryStatus::Idle => Some(Charge::NotCharging),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buttons_in_directinput_order() {
        let mut buttons = [false; 14];
        buttons[1] = true;
        buttons[9] = true;
        let i = input(&buttons, None, &[0.5, 0.5]);
        assert!(i.south && i.menu);
        assert!(!i.west && !i.east && !i.north && !i.view && !i.l1 && !i.home);
        let i = input(&[true, false, true, true, true, true, false, false, true], None, &[]);
        assert!(i.west && i.east && i.north && i.l1 && i.r1 && i.view && !i.south && !i.menu);
        // A controller with only a few buttons.
        assert_eq!(input(&[false, true], None, &[]), Input { south: true, ..Input::default() });
    }

    #[test]
    fn the_hat_wins_over_the_stick() {
        let dir = |hat, axes: &[f64]| input(&[], hat, axes).dir;
        assert_eq!(dir(Some(GameControllerSwitchPosition::Up), &[1.0, 0.5]), Some(Dir::Up));
        assert_eq!(dir(Some(GameControllerSwitchPosition::DownRight), &[]), Some(Dir::Right));
        assert_eq!(dir(Some(GameControllerSwitchPosition::UpLeft), &[]), Some(Dir::Left));
        assert_eq!(dir(Some(GameControllerSwitchPosition::Down), &[]), Some(Dir::Down));
        assert_eq!(dir(Some(GameControllerSwitchPosition::Center), &[0.0, 0.5]), Some(Dir::Left));
        assert_eq!(dir(None, &[0.5, 0.0]), Some(Dir::Up));
        assert_eq!(dir(None, &[0.5, 1.0]), Some(Dir::Down));
        assert_eq!(dir(None, &[0.6, 0.4]), None);
        // One axis is no stick.
        assert_eq!(dir(None, &[0.0]), None);
    }

    #[test]
    fn controllers_read_another_way_are_left_out() {
        // Gamepads: Microsoft's always, others while XInput reads them.
        assert!(read_elsewhere(0x045E, 0x0B13, true, false));
        assert!(read_elsewhere(0x2DC8, 0x3106, true, true));
        assert!(!read_elsewhere(0x2DC8, 0x3106, true, false));
        assert!(read_elsewhere(0x28DE, 0x11FF, false, false));
        assert!(read_elsewhere(dualsense::SONY, 0x0CE6, false, false));
        // A DualShock 4, a Switch Pro Controller.
        assert!(!read_elsewhere(dualsense::SONY, 0x09CC, false, false));
        assert!(!read_elsewhere(0x057E, 0x2009, false, false));
    }

    #[test]
    fn a_gamepad_by_its_button_names() {
        let reading = |buttons, x, y| GamepadReading {
            Buttons: buttons,
            LeftThumbstickX: x,
            LeftThumbstickY: y,
            ..GamepadReading::default()
        };
        let i =
            gamepad_input(&reading(GamepadButtons::A | GamepadButtons::View | GamepadButtons::RightShoulder, 0.0, 0.0));
        assert!(i.south && i.view && i.r1 && !i.east && !i.menu && i.dir.is_none());
        let i = gamepad_input(&reading(GamepadButtons::X | GamepadButtons::Y | GamepadButtons::Menu, 0.0, 0.0));
        assert!(i.west && i.north && i.menu && !i.south);
        assert_eq!(gamepad_input(&reading(GamepadButtons::DPadUp, 1.0, 0.0)).dir, Some(Dir::Up));
        assert_eq!(gamepad_input(&reading(GamepadButtons::None, 0.0, 1.0)).dir, Some(Dir::Up));
        assert_eq!(gamepad_input(&reading(GamepadButtons::None, 0.0, -1.0)).dir, Some(Dir::Down));
    }

    #[test]
    fn battery_reports() {
        assert_eq!(percent(1500, 3000), Some(50));
        assert_eq!(percent(3100, 3000), Some(100));
        assert_eq!(percent(-5, 3000), Some(0));
        assert_eq!(percent(100, 0), None);
        assert_eq!(charge(BatteryStatus::Discharging, 50), Some(Charge::Battery));
        assert_eq!(charge(BatteryStatus::Charging, 50), Some(Charge::Charging));
        assert_eq!(charge(BatteryStatus::Idle, 100), Some(Charge::Full));
        assert_eq!(charge(BatteryStatus::Idle, 60), Some(Charge::NotCharging));
        assert_eq!(charge(BatteryStatus::NotPresent, 0), None);
    }
}
