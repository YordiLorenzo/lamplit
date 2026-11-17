// What a DualSense's HID input reports say: the buttons and direction Lamplit navigates with, the battery and
// headphone jack the Settings screen shows, and the touchpad. docs/accessories.md has the report layouts.
//
// USB report 0x01 and Bluetooth report 0x31 (full mode) share a layout; every field sits at the same distance from
// the sticks, which start at byte 1 over USB and byte 2 over Bluetooth (offsets include the report id). Bluetooth
// 0x01 is the reduced report a DualSense sends until someone switches it to full mode: buttons only.

use super::gestures::Touch;
use super::navigation::{Dir, Input};
use crate::devices::Charge;
use crate::prefs::{EdgeButtons, EdgeTarget};

pub const SONY: u16 = 0x054C;
/// DualSense, DualSense Edge.
const PRODUCTS: [u16; 2] = [0x0CE6, 0x0DF2];

/// The controller with these USB ids is a DualSense.
pub fn is(vendor: u16, product: u16) -> bool {
    vendor == SONY && PRODUCTS.contains(&product)
}

/// The controller with this product id is a DualSense Edge, which has back and Fn buttons.
pub fn is_edge(product: u16) -> bool {
    product == PRODUCTS[1]
}

/// What the Settings screen calls it.
pub fn name(product: u16) -> &'static str {
    if is_edge(product) { "DualSense Edge" } else { "DualSense" }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Status {
    /// Percent, in steps of 10 (the controller reports 0 to 10).
    pub battery: u8,
    pub charge: Charge,
    pub headphones: bool,
}

/// The DualSense Edge's back and Fn buttons. Each is down only in an Edge's full report.
#[derive(Default, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Extra {
    pub left_back: bool,
    pub right_back: bool,
    pub left_fn: bool,
    pub right_fn: bool,
}

impl Extra {
    /// The third button byte of a full report: 0x10 left Fn, 0x20 right Fn, 0x40 left back, 0x80 right back. From
    /// SDL's `SDL_hidapi_ps5.c` (HIDAPI_DriverPS5_HandleStatePacketCommon, the PS5 left and right function and paddle
    /// buttons), which counts them only on the Edge.
    fn of(buttons3: u8) -> Self {
        Extra {
            left_fn: buttons3 & 0x10 != 0,
            right_fn: buttons3 & 0x20 != 0,
            left_back: buttons3 & 0x40 != 0,
            right_back: buttons3 & 0x80 != 0,
        }
    }

    /// The input with each of these buttons that is down pressing the button the player chose for it, so it does
    /// everything that button does: a step, a hold that ends when it is let go.
    pub fn onto(self, mut input: Input, chosen: EdgeButtons) -> Input {
        let pairs = [
            (self.left_back, chosen.left_back),
            (self.right_back, chosen.right_back),
            (self.left_fn, chosen.left_fn),
            (self.right_fn, chosen.right_fn),
        ];
        for (_, target) in pairs.into_iter().filter(|&(down, _)| down) {
            match target {
                EdgeTarget::Nothing => {}
                EdgeTarget::Cross => input.south = true,
                EdgeTarget::Circle => input.east = true,
                EdgeTarget::Triangle => input.north = true,
                EdgeTarget::Square => input.west = true,
                EdgeTarget::L1 => input.l1 = true,
                EdgeTarget::R1 => input.r1 = true,
                EdgeTarget::Options => input.menu = true,
            }
        }
        input
    }
}

/// One input report. Only full reports carry the touchpad and the status, and only an Edge's the extra buttons.
#[derive(Debug, PartialEq)]
pub struct Report {
    pub input: Input,
    pub extra: Extra,
    pub touch: Option<Touch>,
    pub status: Option<Status>,
}

/// `edge`: the report is a DualSense Edge's. A plain DualSense has no back or Fn buttons, so the bits they use there
/// aren't read.
pub fn parse(r: &[u8], bluetooth: bool, edge: bool) -> Option<Report> {
    match (r.first()?, bluetooth) {
        (0x01, false) => full(r, 1, edge),
        (0x31, true) => full(r, 2, edge),
        // The reduced report's third button byte holds a counter above PS and the touchpad press (SDL reads it
        // with & 0x03), so no Edge buttons.
        (0x01, true) if r.len() >= 8 => Some(Report {
            input: input(r[1], r[2], [r[5], r[6], r[7]]),
            extra: Extra::default(),
            touch: None,
            status: None,
        }),
        _ => None,
    }
}

/// A full report whose sticks start at byte `base`: the buttons follow 7 bytes on, the touchpad 32 bytes on, the
/// battery and the plugged flags 52 bytes on.
fn full(r: &[u8], base: usize, edge: bool) -> Option<Report> {
    let at = |k: usize| r.get(base + k).copied();
    let buttons = [at(7)?, at(8)?, at(9)?];
    Some(Report {
        input: input(at(0)?, at(1)?, buttons),
        extra: if edge { Extra::of(buttons[2]) } else { Extra::default() },
        touch: r.get(base + 32..base + 40).map(|points| touch(points, buttons[2])),
        status: at(52).zip(at(53)).map(|(power, plugged)| status(power, plugged)),
    })
}

/// Buttons, and the direction from the d-pad or else the left stick.
fn input(lx: u8, ly: u8, [b0, b1, b2]: [u8; 3]) -> Input {
    let hat = match b0 & 0x0F {
        0 => Some(Dir::Up),
        1..=3 => Some(Dir::Right),
        4 => Some(Dir::Down),
        5..=7 => Some(Dir::Left),
        _ => None,
    };
    let axis = |v: u8| (f32::from(v) - 128.0) / 128.0;
    Input {
        dir: hat.or(Dir::of_stick(axis(lx), axis(ly))),
        west: b0 & 0x10 != 0,
        south: b0 & 0x20 != 0,
        east: b0 & 0x40 != 0,
        north: b0 & 0x80 != 0,
        l1: b1 & 0x01 != 0,
        r1: b1 & 0x02 != 0,
        view: b1 & 0x10 != 0,
        menu: b1 & 0x20 != 0,
        home: b2 & 0x01 != 0,
    }
}

/// Two touch points, 4 bytes each (contact byte with bit 7 set when not touching, then 12-bit x and 12-bit y), and
/// the pad's press in the third button byte (bit 1), next to PS.
fn touch(points: &[u8], buttons3: u8) -> Touch {
    let point = |b: &[u8]| {
        (b[0] & 0x80 == 0)
            .then(|| (u16::from(b[1]) | u16::from(b[2] & 0x0F) << 8, u16::from(b[2] >> 4) | u16::from(b[3]) << 4))
    };
    Touch { points: [point(&points[..4]), point(&points[4..])], pressed: buttons3 & 0x02 != 0 }
}

/// Battery, charging and the headphone jack.
fn status(power: u8, plugged: u8) -> Status {
    Status {
        // 0 to 10 in the low half: 10 % steps, reported as the middle of the step.
        battery: ((power & 0x0F) * 10 + 5).min(100),
        charge: match power >> 4 {
            0 => Charge::Battery,
            1 => Charge::Charging,
            2 => Charge::Full,
            _ => Charge::NotCharging,
        },
        headphones: plugged & 0x01 != 0,
    }
}

/// The Bluetooth address from the serial number Windows reports, e.g. "a1b2c3d4e5f6".
pub fn address(serial: Option<&str>) -> Option<u64> {
    let hex: String = serial?.chars().filter(char::is_ascii_hexdigit).collect();
    (hex.len() == 12).then(|| u64::from_str_radix(&hex, 16).ok()).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usb(lx: u8, ly: u8, b0: u8, b1: u8, b2: u8) -> Vec<u8> {
        let mut r = vec![0u8; 64];
        r[0] = 0x01;
        (r[1], r[2], r[8], r[9], r[10]) = (lx, ly, b0, b1, b2);
        r
    }

    fn input_of(r: &[u8], bluetooth: bool) -> Input {
        parse(r, bluetooth, false).unwrap().input
    }

    #[test]
    fn usb_report() {
        let i = input_of(&usb(128, 128, 0x08 | 0x20, 0, 0x01), false);
        assert_eq!(i.dir, None);
        assert!(i.south && i.home && !i.east);
        let i = input_of(&usb(255, 128, 0x08, 0x20, 0), false);
        assert_eq!(i.dir, Some(Dir::Right));
        assert!(i.menu && !i.view);
        // Square and Create, and the stick just past its dead zone, or just short of it.
        let i = input_of(&usb(128, 128 - 70, 0x08 | 0x10, 0x10, 0), false);
        assert_eq!(i.dir, Some(Dir::Up));
        assert!(i.west && i.view && !i.south);
        assert_eq!(input_of(&usb(128 + 69, 128, 0x08, 0, 0), false).dir, None);
        assert_eq!(parse(&usb(128, 128, 0x08, 0, 0)[..10], false, false), None);
    }

    #[test]
    fn bluetooth_reports() {
        let i = input_of(&bluetooth(0x06 | 0x40, 0, 0), true);
        assert_eq!(i.dir, Some(Dir::Left));
        assert!(i.east);
        let simple = [0x01, 128, 0, 128, 128, 0x08, 0, 0x01, 0, 0];
        let reduced = parse(&simple, true, false).unwrap();
        assert_eq!(reduced.input.dir, Some(Dir::Up));
        assert!(reduced.input.home);
        assert_eq!((reduced.touch, reduced.status), (None, None));
    }

    const UP: Extra = Extra { left_back: false, right_back: false, left_fn: false, right_fn: false };
    /// Each Edge button's bit in the third button byte, and that button alone down.
    const EXTRA: [(u8, Extra); 4] = [
        (0x10, Extra { left_fn: true, ..UP }),
        (0x20, Extra { right_fn: true, ..UP }),
        (0x40, Extra { left_back: true, ..UP }),
        (0x80, Extra { right_back: true, ..UP }),
    ];

    /// A full Bluetooth report (0x31, 78 bytes) with these three button bytes and the sticks at rest.
    fn bluetooth(b0: u8, b1: u8, b2: u8) -> Vec<u8> {
        let mut r = vec![0u8; 78];
        r[0] = 0x31;
        (r[2], r[3], r[9], r[10], r[11]) = (128, 128, b0, b1, b2);
        r
    }

    #[test]
    fn an_edge_reports_each_back_and_fn_button_over_usb_and_bluetooth() {
        for (bit, alone) in EXTRA {
            for (report, bt) in [(usb(128, 128, 0x08, 0, bit | 0x01), false), (bluetooth(0x08, 0, bit | 0x01), true)] {
                let r = parse(&report, bt, true).unwrap();
                assert_eq!(r.extra, alone, "bit {bit:#04x}, Bluetooth {bt}");
                // PS beside it still reads, and the button itself is no other button.
                assert_eq!(r.input, Input { home: true, ..Input::default() });
            }
        }
        // All four at once, and none.
        let all = parse(&usb(128, 128, 0x08, 0, 0xF0), false, true).unwrap().extra;
        assert_eq!(all, Extra { left_back: true, right_back: true, left_fn: true, right_fn: true });
        assert_eq!(parse(&bluetooth(0x08, 0, 0x02), true, true).unwrap().extra, Extra::default());
    }

    #[test]
    fn a_plain_dualsense_or_a_reduced_report_has_no_extra_buttons() {
        let every_target = EdgeButtons {
            left_back: EdgeTarget::Cross,
            right_back: EdgeTarget::Circle,
            left_fn: EdgeTarget::Options,
            right_fn: EdgeTarget::R1,
        };
        for (report, bt) in [(usb(128, 128, 0x08, 0, 0xF0), false), (bluetooth(0x08, 0, 0xF0), true)] {
            let r = parse(&report, bt, false).unwrap();
            assert_eq!(r.extra, Extra::default());
            assert_eq!(r.extra.onto(r.input, every_target), Input::default());
        }
        // Bluetooth's reduced report counts in the bits above PS and the touchpad press.
        let reduced = parse(&[0x01, 128, 128, 128, 128, 0x08, 0, 0xFC, 0, 0], true, true).unwrap();
        assert_eq!(reduced.extra, Extra::default());
    }

    #[test]
    fn an_edge_button_presses_the_button_chosen_for_it() {
        let targets = [
            (EdgeTarget::Nothing, Input::default()),
            (EdgeTarget::Cross, Input { south: true, ..Input::default() }),
            (EdgeTarget::Circle, Input { east: true, ..Input::default() }),
            (EdgeTarget::Triangle, Input { north: true, ..Input::default() }),
            (EdgeTarget::Square, Input { west: true, ..Input::default() }),
            (EdgeTarget::L1, Input { l1: true, ..Input::default() }),
            (EdgeTarget::R1, Input { r1: true, ..Input::default() }),
            (EdgeTarget::Options, Input { menu: true, ..Input::default() }),
        ];
        let back = Extra { left_back: true, ..Extra::default() };
        for (target, want) in targets {
            let chosen = EdgeButtons { left_back: target, ..EdgeButtons::default() };
            assert_eq!(back.onto(Input::default(), chosen), want, "{target:?}");
        }
        // The buttons really pressed stay pressed, and a button with no choice does nothing.
        let held = Input { dir: Some(Dir::Up), l1: true, home: true, ..Input::default() };
        let chosen = EdgeButtons { right_fn: EdgeTarget::Square, ..EdgeButtons::default() };
        let all = Extra { left_back: true, right_back: true, left_fn: true, right_fn: true };
        assert_eq!(all.onto(held, chosen), Input { west: true, ..held });
    }

    #[test]
    fn a_back_button_given_cross_steps_and_lets_go_like_cross() {
        use super::super::navigation::{Action, Navigation};
        let chosen =
            EdgeButtons { left_back: EdgeTarget::Cross, right_back: EdgeTarget::Circle, ..EdgeButtons::default() };
        let read = |report: Vec<u8>| {
            let r = parse(&report, false, true).unwrap();
            r.extra.onto(r.input, chosen)
        };
        let (mut nav, t) = (Navigation::default(), std::time::Instant::now());
        assert_eq!(nav.update(read(usb(128, 128, 0x08, 0, 0x40)), t), [Action::Nav("ok")]);
        assert!(nav.update(read(usb(128, 128, 0x08, 0, 0x40)), t).is_empty());
        assert_eq!(nav.update(read(usb(128, 128, 0x08, 0, 0)), t), [Action::Release("ok-up")]);
        assert_eq!(nav.update(read(usb(128, 128, 0x08, 0, 0x80)), t), [Action::Nav("back")]);
    }

    #[test]
    fn battery_and_jack() {
        let mut wired = usb(128, 128, 0x08, 0, 0);
        (wired[53], wired[54]) = (0x16, 0x01); // charging, level 6; headphones in
        assert_eq!(
            parse(&wired, false, false).unwrap().status,
            Some(Status { battery: 65, charge: Charge::Charging, headphones: true })
        );
        let mut full = vec![0u8; 78];
        full[0] = 0x31;
        (full[54], full[55]) = (0x0A, 0x00); // on battery, level 10
        assert_eq!(
            parse(&full, true, false).unwrap().status,
            Some(Status { battery: 100, charge: Charge::Battery, headphones: false })
        );
        assert_eq!(address(Some("a1:b2:c3:d4:e5:f6")), Some(0xa1b2_c3d4_e5f6));
        assert_eq!(address(Some("")), None);
    }

    #[test]
    fn touchpad() {
        let mut wired = usb(128, 128, 0x08, 0, 0x02); // pad pressed
        // Point 1 touching at (1000, 500): x 0x3E8, y 0x1F4. Point 2 not touching.
        wired[33..41].copy_from_slice(&[0x05, 0xE8, 0x43, 0x1F, 0x86, 0, 0, 0]);
        let t = parse(&wired, false, false).unwrap().touch.unwrap();
        assert_eq!(t.points, [Some((1000, 500)), None]);
        assert!(t.pressed);
        let mut full = vec![0u8; 78];
        full[0] = 0x31;
        full[34..42].copy_from_slice(&[0x80, 0, 0, 0, 0x80, 0, 0, 0]);
        assert_eq!(parse(&full, true, false).unwrap().touch, Some(Touch::default()));
    }
}
