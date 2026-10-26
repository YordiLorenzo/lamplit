// Other controllers (a DualShock 4, a Switch Pro Controller, a plain USB pad) through Windows.Gaming.Input's
// RawGameController, which reads any controller Windows knows without taking it from anyone. Windows hands its input
// only to the program in front, so these controllers move around Lamplit but can't bring it over a game.
//
// Controllers read another way are left out: the DualSense (over HID), Xbox-style ones (XInput, which reads them
// behind a game too; Windows.Gaming.Input knows them as gamepads), and Valve's, which are Steam Input's own.
//
// RawGameController numbers the buttons without saying which is which. Lamplit takes the order most DirectInput
// controllers use, the DualShock 4's and Logitech's among them.

use super::navigation::{Action, Dir, Input, Navigation};
use super::{Battery, Connection, Controller, Kind, dualsense};
use crate::devices::Charge;
use crate::launch::window;
use std::collections::HashSet;
use std::time::Instant;
use tauri::AppHandle;
use windows::Gaming::Input::{GameControllerSwitchPosition, Gamepad, RawGameController};
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
    buttons: Vec<bool>,
    switches: Vec<GameControllerSwitchPosition>,
    axes: Vec<f64>,
    /// None while Lamplit isn't in front, when Windows sends it nothing: reading starts over when it comes back.
    navigation: Option<Navigation>,
}

impl Others {
    /// Looks for controllers that came or went, and how full the batteries are.
    pub fn look(&mut self, app: &AppHandle) {
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
            if self.pads.iter().any(|pad| pad.id == id) {
                super::set_battery(app, &id, battery(&raw));
                continue;
            }
            if self.left_out.contains(&id) {
                continue;
            }
            let (vendor, product) = (raw.HardwareVendorId().unwrap_or(0), raw.HardwareProductId().unwrap_or(0));
            let name = raw.DisplayName().map(|n| n.to_string()).unwrap_or_default();
            let gamepad = Gamepad::FromGameController(&raw).is_ok();
            if left_out(vendor, product, gamepad) {
                log::info!("controller: {name} ({vendor:04X}:{product:04X}) is read another way, or by Steam");
                self.left_out.insert(id);
                continue;
            }
            let count = |n: windows::core::Result<i32>| n.ok().and_then(|n| usize::try_from(n).ok()).unwrap_or(0);
            let pad = Pad {
                id: id.clone(),
                kind: if vendor == dualsense::SONY { Kind::PlayStation } else { Kind::Other },
                buttons: vec![false; count(raw.ButtonCount())],
                switches: vec![GameControllerSwitchPosition::Center; count(raw.SwitchCount())],
                axes: vec![0.5; count(raw.AxisCount())],
                navigation: None,
                raw,
            };
            log::info!("controller: {name} ({vendor:04X}:{product:04X}) through Windows.Gaming.Input");
            let wireless = pad.raw.IsWireless().unwrap_or(false);
            super::list(
                app,
                Controller {
                    id,
                    kind: pad.kind,
                    name: if name.trim().is_empty() { "Controller".into() } else { name },
                    connection: if wireless { Connection::Wireless } else { Connection::Usb },
                    battery: battery(&pad.raw),
                    headphones: None,
                    address: None,
                },
            );
            self.pads.push(pad);
        }
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
            if pad.raw.GetCurrentReading(&mut pad.buttons, &mut pad.switches, &mut pad.axes).is_err() {
                continue;
            }
            let input = input(&pad.buttons, pad.switches.first().copied(), &pad.axes);
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

/// Controllers read another way: a DualSense over HID, an Xbox-style controller (`gamepad`) through XInput, and
/// Valve's, which are Steam Input's own (its virtual controllers among them).
fn left_out(vendor: u16, product: u16, gamepad: bool) -> bool {
    gamepad || vendor == VALVE || dualsense::is(vendor, product)
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
        assert!(left_out(0x045E, 0x0B13, true));
        assert!(left_out(0x28DE, 0x11FF, false));
        assert!(left_out(dualsense::SONY, 0x0CE6, false));
        // A DualShock 4, a Switch Pro Controller.
        assert!(!left_out(dualsense::SONY, 0x09CC, false));
        assert!(!left_out(0x057E, 0x2009, false));
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
