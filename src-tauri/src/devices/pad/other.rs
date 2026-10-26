// Other controllers (a DualShock 4, a Switch Pro Controller, a plain USB pad) through Windows.Gaming.Input's
// RawGameController, which reads any controller Windows knows without taking it from anyone. Windows hands its input
// only to the program in front, so these controllers move around Lamplit but can't bring it over a game.
//
// Only RawGameController, never Windows.Gaming.Input's Gamepad: starting the Gamepad interface switches a DualShock 4
// on Bluetooth into its enhanced mode, which breaks DirectInput games. SDL loads the RawGameController statics alone at
// start for the same reason (SDL_windows_gaming_input.c).
//
// Controllers read another way are left out: the DualSense (over HID), Xbox-style ones (XInput, which reads them
// behind a game too), and Valve's, which are Steam Input's own. A RawGameController numbers its buttons; Windows names
// them for the controllers it knows (GetButtonLabel), and for the rest Lamplit takes the order most DirectInput
// controllers use, the DualShock 4's and Logitech's among them.

use super::navigation::{Action, Dir, Input, Navigation};
use super::{Battery, Connection, Controller, Kind, dualsense, xbox};
use crate::devices::Charge;
use crate::launch::window;
use std::collections::HashSet;
use std::time::Instant;
use tauri::AppHandle;
use windows::Gaming::Input::{GameControllerButtonLabel, GameControllerSwitchPosition, RawGameController};
use windows::System::Power::BatteryStatus;

const VALVE: u16 = 0x28DE;
/// Microsoft's controllers from this product id on are Xbox ones (the first Xbox controller is 0x0202). The SideWinder
/// controllers below it are DirectInput controllers, which XInput can't read.
const FIRST_XBOX: u16 = 0x0200;

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
    layout: Layout,
    buttons: Vec<bool>,
    switches: Vec<GameControllerSwitchPosition>,
    axes: Vec<f64>,
    /// None while Lamplit isn't in front, when Windows sends it nothing: reading starts over when it comes back.
    navigation: Option<Navigation>,
}

impl Others {
    /// Looks for controllers that came or went, and how full the batteries are. An Xbox-style controller is read
    /// here only while `xbox` doesn't read it, which can change from one look to the next.
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
            // The layout of a controller read here; None for one read another way.
            let here = (!read_elsewhere(vendor, product))
                .then(|| Layout::of(&raw, vendor))
                .filter(|layout| !in_xinput(vendor, product, xbox.reads(vendor, product, layout.xbox), xbox.reading()));
            let listed = self.pads.iter().position(|pad| pad.id == id);
            match (listed, here) {
                (Some(_), Some(_)) => super::set_battery(app, &id, battery(&raw)),
                (Some(at), None) => {
                    log::info!("controller: {vendor:04X}:{product:04X} is read through XInput now");
                    super::unlist(app, &self.pads.swap_remove(at).id);
                    self.left_out.insert(id);
                }
                (None, None) => {
                    if self.left_out.insert(id) {
                        let name = raw.DisplayName().map(|n| n.to_string()).unwrap_or_default();
                        log::info!("controller: {name} ({vendor:04X}:{product:04X}) is read another way, or by Steam");
                    }
                }
                (None, Some(layout)) => {
                    self.left_out.remove(&id);
                    self.add(app, id, raw, layout, (vendor, product));
                }
            }
        }
    }

    fn add(&mut self, app: &AppHandle, id: String, raw: RawGameController, layout: Layout, ids: (u16, u16)) {
        let name = raw.DisplayName().map(|n| n.to_string()).unwrap_or_default();
        let (vendor, product) = ids;
        let named = if layout == Layout::DIRECTINPUT { "in DirectInput order" } else { "by Windows' names" };
        log::info!("controller: {name} ({vendor:04X}:{product:04X}) through Windows.Gaming.Input, buttons {named}");
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
            layout,
            buttons: vec![false; count(raw.ButtonCount())],
            switches: vec![GameControllerSwitchPosition::Center; count(raw.SwitchCount())],
            axes: vec![0.5; count(raw.AxisCount())],
            raw,
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
            if pad.raw.GetCurrentReading(&mut pad.buttons, &mut pad.switches, &mut pad.axes).is_err() {
                continue;
            }
            let input = input(&pad.layout, &pad.buttons, pad.switches.first().copied(), &pad.axes);
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

/// Controllers read another way, told by their USB ids alone: a DualSense over HID, and Valve's, which are Steam
/// Input's own (its virtual controllers among them).
fn read_elsewhere(vendor: u16, product: u16) -> bool {
    dualsense::is(vendor, product) || vendor == VALVE
}

/// XInput reads this controller: a slot holds its ids (`held`), or it is one of Microsoft's Xbox controllers while
/// XInput reads any controller (`xinput_reading`), since the ids XInput and Windows.Gaming.Input give one controller
/// can differ. With no XInput controller, a Microsoft one is read here: an original Xbox controller on a DirectInput
/// driver (XBCD) has no XInput slot.
fn in_xinput(vendor: u16, product: u16, held: bool, xinput_reading: bool) -> bool {
    held || (vendor == xbox::MICROSOFT && product >= FIRST_XBOX && xinput_reading)
}

/// Which button index is which. None for a button the controller doesn't have, or Windows doesn't name.
#[derive(Clone, Copy, PartialEq, Debug)]
struct Layout {
    south: Option<usize>,
    east: Option<usize>,
    west: Option<usize>,
    north: Option<usize>,
    l1: Option<usize>,
    r1: Option<usize>,
    view: Option<usize>,
    menu: Option<usize>,
    /// The d-pad as buttons (up, down, left, right), for a controller that has no hat switch for it.
    dpad: [Option<usize>; 4],
    /// Windows names the buttons as an Xbox controller's.
    xbox: bool,
}

impl Layout {
    /// The order most DirectInput controllers send their buttons in: west (Square, X), south (Cross, A), east
    /// (Circle, B), north (Triangle, Y), L1, R1, L2, R2, then View (Share, Back) and Menu (Options, Start).
    const DIRECTINPUT: Layout = Layout {
        west: Some(0),
        south: Some(1),
        east: Some(2),
        north: Some(3),
        l1: Some(4),
        r1: Some(5),
        view: Some(8),
        menu: Some(9),
        dpad: [None; 4],
        xbox: false,
    };

    /// The controller's layout by the names Windows gives its buttons, else the DirectInput order. A Sony controller
    /// isn't asked: a DualShock 4 is the controller Windows switches into another mode when its gamepad support
    /// starts, so Lamplit keeps clear of anything near that, and its buttons come in the DirectInput order anyway.
    fn of(raw: &RawGameController, vendor: u16) -> Layout {
        if vendor == dualsense::SONY {
            return Layout::DIRECTINPUT;
        }
        let labels: Vec<_> = (0..raw.ButtonCount().unwrap_or(0))
            .map(|i| raw.GetButtonLabel(i).unwrap_or(GameControllerButtonLabel::None))
            .collect();
        Layout::named(&labels).unwrap_or(Layout::DIRECTINPUT)
    }

    /// The layout Windows' button names give, once they name at least the bottom and right face buttons. Letters
    /// alone don't say where a button sits (a Nintendo controller's A is on the right), so they are left out.
    fn named(labels: &[GameControllerButtonLabel]) -> Option<Layout> {
        use windows::Gaming::Input::GameControllerButtonLabel as L;
        let find = |names: &[L]| labels.iter().position(|label| names.contains(label));
        let layout = Layout {
            south: find(&[L::XboxA, L::Cross]),
            east: find(&[L::XboxB, L::Circle]),
            west: find(&[L::XboxX, L::Square]),
            north: find(&[L::XboxY, L::Triangle]),
            l1: find(&[L::XboxLeftBumper, L::LeftBumper, L::Left1]),
            r1: find(&[L::XboxRightBumper, L::RightBumper, L::Right1]),
            view: find(&[L::XboxView, L::XboxBack, L::View, L::Back, L::Select, L::Share]),
            menu: find(&[L::XboxMenu, L::XboxStart, L::Menu, L::Start, L::Options]),
            dpad: [
                find(&[L::XboxUp, L::Up]),
                find(&[L::XboxDown, L::Down]),
                find(&[L::XboxLeft, L::Left]),
                find(&[L::XboxRight, L::Right]),
            ],
            xbox: labels.contains(&L::XboxA),
        };
        (layout.south.is_some() && layout.east.is_some()).then_some(layout)
    }
}

/// The buttons by `layout`. The direction comes from the first hat switch, else the d-pad's buttons, else the first
/// two axes (0 to 1, y growing towards the player).
fn input(layout: &Layout, buttons: &[bool], hat: Option<GameControllerSwitchPosition>, axes: &[f64]) -> Input {
    let pressed = |at: Option<usize>| at.and_then(|i| buttons.get(i).copied()).unwrap_or(false);
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
    let [up, down, left, right] = layout.dpad.map(pressed);
    let dpad = if left {
        Some(Dir::Left)
    } else if right {
        Some(Dir::Right)
    } else if up {
        Some(Dir::Up)
    } else if down {
        Some(Dir::Down)
    } else {
        None
    };
    let stick = match axes {
        [x, y, ..] => Dir::of_stick((*x as f32 - 0.5) * 2.0, (*y as f32 - 0.5) * 2.0),
        _ => None,
    };
    Input {
        dir: hat.or(dpad).or(stick),
        south: pressed(layout.south),
        east: pressed(layout.east),
        west: pressed(layout.west),
        north: pressed(layout.north),
        l1: pressed(layout.l1),
        r1: pressed(layout.r1),
        view: pressed(layout.view),
        menu: pressed(layout.menu),
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
    use windows::Gaming::Input::GameControllerButtonLabel as L;

    fn directinput(buttons: &[bool], hat: Option<GameControllerSwitchPosition>, axes: &[f64]) -> Input {
        input(&Layout::DIRECTINPUT, buttons, hat, axes)
    }

    #[test]
    fn buttons_in_directinput_order() {
        let mut buttons = [false; 14];
        buttons[1] = true;
        buttons[9] = true;
        let i = directinput(&buttons, None, &[0.5, 0.5]);
        assert!(i.south && i.menu);
        assert!(!i.west && !i.east && !i.north && !i.view && !i.l1 && !i.home);
        let i = directinput(&[true, false, true, true, true, true, false, false, true], None, &[]);
        assert!(i.west && i.east && i.north && i.l1 && i.r1 && i.view && !i.south && !i.menu);
        // A controller with only a few buttons.
        assert_eq!(directinput(&[false, true], None, &[]), Input { south: true, ..Input::default() });
    }

    #[test]
    fn the_hat_wins_over_the_stick() {
        let dir = |hat, axes: &[f64]| directinput(&[], hat, axes).dir;
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
    fn controllers_read_another_way_are_left_out_by_their_ids() {
        // Steam Input's virtual controller, a DualSense.
        assert!(read_elsewhere(0x28DE, 0x11FF));
        assert!(read_elsewhere(dualsense::SONY, 0x0CE6));
        // An Xbox Wireless Controller (left out only while XInput reads, below), a DualShock 4, a Switch Pro
        // Controller, an 8BitDo pad.
        assert!(!read_elsewhere(0x045E, 0x0B13));
        assert!(!read_elsewhere(dualsense::SONY, 0x09CC));
        assert!(!read_elsewhere(0x057E, 0x2009));
        assert!(!read_elsewhere(0x2DC8, 0x3106));
    }

    #[test]
    fn controllers_xinput_reads_are_left_out() {
        // A slot holds its ids: an 8BitDo pad.
        assert!(in_xinput(0x2DC8, 0x3106, true, true));
        assert!(!in_xinput(0x2DC8, 0x3106, false, true));
        // Microsoft's Xbox controllers while XInput reads any controller, whatever ids it gives.
        assert!(in_xinput(0x045E, 0x0B13, false, true));
        assert!(in_xinput(0x045E, 0x028E, false, true));
        // Microsoft id, no XInput slot connected: read through Windows.Gaming.Input (an original Xbox controller on
        // XBCD, 0x0202).
        assert!(!in_xinput(0x045E, 0x0202, false, false));
        // A SideWinder Force Feedback 2 is a DirectInput controller, read here even while XInput reads another.
        assert!(!in_xinput(0x045E, 0x001B, false, true));
    }

    /// The buttons Windows names for an Xbox-style controller, in an order unlike DirectInput's.
    const XBOX: [GameControllerButtonLabel; 14] = [
        L::XboxA,
        L::XboxB,
        L::XboxX,
        L::XboxY,
        L::XboxLeftBumper,
        L::XboxRightBumper,
        L::XboxView,
        L::XboxMenu,
        L::XboxLeftStickButton,
        L::XboxRightStickButton,
        L::XboxUp,
        L::XboxDown,
        L::XboxLeft,
        L::XboxRight,
    ];

    #[test]
    fn buttons_windows_names() {
        let layout = Layout::named(&XBOX).unwrap();
        assert!(layout.xbox);
        let press = |at: &[usize]| {
            let buttons: Vec<bool> = (0..XBOX.len()).map(|i| at.contains(&i)).collect();
            input(&layout, &buttons, None, &[0.5, 0.5])
        };
        assert_eq!(press(&[0, 7]), Input { south: true, menu: true, ..Input::default() });
        assert_eq!(press(&[2, 3, 6]), Input { west: true, north: true, view: true, ..Input::default() });
        assert_eq!(press(&[1, 4, 5]), Input { east: true, l1: true, r1: true, ..Input::default() });
        // A d-pad that comes as buttons; a diagonal is sideways.
        assert_eq!(press(&[10]).dir, Some(Dir::Up));
        assert_eq!(press(&[11, 13]).dir, Some(Dir::Right));
        // PlayStation names.
        let named = [L::Square, L::Cross, L::Circle, L::Triangle, L::Left1, L::Right1, L::Share, L::Options];
        let layout = Layout::named(&named).unwrap();
        assert!(!layout.xbox);
        assert_eq!((layout.south, layout.east, layout.view, layout.menu), (Some(1), Some(2), Some(6), Some(7)));
    }

    #[test]
    fn letters_or_no_names_fall_back_to_directinput_order() {
        assert_eq!(Layout::named(&[L::None; 12]), None);
        // A Nintendo controller's A sits on the right: letters don't say where a button is.
        assert_eq!(Layout::named(&[L::LetterB, L::LetterA, L::LetterY, L::LetterX]), None);
        assert_eq!(Layout::named(&[]), None);
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
