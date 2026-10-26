// What a DualSense's HID input reports say: the buttons and direction Lamplit navigates with, the battery and
// headphone jack the Settings screen shows, and the touchpad. docs/accessories.md has the report layouts.
//
// USB report 0x01 and Bluetooth report 0x31 (full mode) share a layout; every field sits at the same distance from
// the sticks, which start at byte 1 over USB and byte 2 over Bluetooth (offsets include the report id). Bluetooth
// 0x01 is the reduced report a DualSense sends until someone switches it to full mode: buttons only.

use super::gestures::Touch;
use crate::devices::Charge;
use serde::Serialize;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[cfg_attr(test, derive(strum::VariantArray))]
pub enum Dir {
    Up,
    Down,
    Left,
    Right,
}

impl Dir {
    pub fn action(self) -> &'static str {
        match self {
            Dir::Up => "up",
            Dir::Down => "down",
            Dir::Left => "left",
            Dir::Right => "right",
        }
    }
}

#[derive(Default, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Input {
    pub dir: Option<Dir>,
    pub cross: bool,
    pub circle: bool,
    pub triangle: bool,
    pub square: bool,
    pub options: bool,
    pub l1: bool,
    pub r1: bool,
    pub ps: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
pub struct Status {
    /// Percent, in steps of 10 (the controller reports 0 to 10).
    pub battery: u8,
    pub charge: Charge,
    pub headphones: bool,
}

/// One input report. Only full reports carry the touchpad and the status.
#[derive(Debug, PartialEq)]
pub struct Report {
    pub input: Input,
    pub touch: Option<Touch>,
    pub status: Option<Status>,
}

pub fn parse(r: &[u8], bluetooth: bool) -> Option<Report> {
    match (r.first()?, bluetooth) {
        (0x01, false) => full(r, 1),
        (0x31, true) => full(r, 2),
        (0x01, true) if r.len() >= 8 => {
            Some(Report { input: input(r[1], r[2], [r[5], r[6], r[7]]), touch: None, status: None })
        }
        _ => None,
    }
}

/// A full report whose sticks start at byte `base`: the buttons follow 7 bytes on, the touchpad 32 bytes on, the
/// battery and the plugged flags 52 bytes on.
fn full(r: &[u8], base: usize) -> Option<Report> {
    let at = |k: usize| r.get(base + k).copied();
    let buttons = [at(7)?, at(8)?, at(9)?];
    Some(Report {
        input: input(at(0)?, at(1)?, buttons),
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
    let (dx, dy) = (i16::from(lx) - 128, i16::from(ly) - 128);
    let stick = if dx.abs().max(dy.abs()) < 70 {
        None
    } else if dx.abs() > dy.abs() {
        Some(if dx > 0 { Dir::Right } else { Dir::Left })
    } else {
        Some(if dy > 0 { Dir::Down } else { Dir::Up })
    };
    Input {
        dir: hat.or(stick),
        cross: b0 & 0x20 != 0,
        circle: b0 & 0x40 != 0,
        triangle: b0 & 0x80 != 0,
        square: b0 & 0x10 != 0,
        options: b1 & 0x20 != 0,
        l1: b1 & 0x01 != 0,
        r1: b1 & 0x02 != 0,
        ps: b2 & 0x01 != 0,
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
        parse(r, bluetooth).unwrap().input
    }

    #[test]
    fn usb_report() {
        let i = input_of(&usb(128, 128, 0x08 | 0x20, 0, 0x01), false);
        assert_eq!(i.dir, None);
        assert!(i.cross && i.ps && !i.circle);
        let i = input_of(&usb(255, 128, 0x08, 0x20, 0), false);
        assert_eq!(i.dir, Some(Dir::Right));
        assert!(i.options && !i.square);
        // Square sits below cross in the first button byte, next to the d-pad's nibble.
        let i = input_of(&usb(128, 128, 0x08 | 0x10, 0, 0), false);
        assert!(i.square && !i.cross && !i.triangle);
        assert_eq!(i.dir, None);
        assert_eq!(parse(&usb(128, 128, 0x08, 0, 0)[..10], false), None);
    }

    #[test]
    fn bluetooth_reports() {
        let mut full = vec![0u8; 78];
        full[0] = 0x31;
        (full[2], full[3], full[9], full[10], full[11]) = (128, 128, 0x06 | 0x40, 0, 0);
        let i = input_of(&full, true);
        assert_eq!(i.dir, Some(Dir::Left));
        assert!(i.circle);
        let simple = [0x01, 128, 0, 128, 128, 0x08 | 0x10, 0, 0x01, 0, 0];
        let reduced = parse(&simple, true).unwrap();
        assert_eq!(reduced.input.dir, Some(Dir::Up));
        assert!(reduced.input.ps && reduced.input.square);
        assert_eq!((reduced.touch, reduced.status), (None, None));
    }

    #[test]
    fn battery_and_jack() {
        let mut wired = usb(128, 128, 0x08, 0, 0);
        (wired[53], wired[54]) = (0x16, 0x01); // charging, level 6; headphones in
        assert_eq!(
            parse(&wired, false).unwrap().status,
            Some(Status { battery: 65, charge: Charge::Charging, headphones: true })
        );
        let mut full = vec![0u8; 78];
        full[0] = 0x31;
        (full[54], full[55]) = (0x0A, 0x00); // on battery, level 10
        assert_eq!(
            parse(&full, true).unwrap().status,
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
        let t = parse(&wired, false).unwrap().touch.unwrap();
        assert_eq!(t.points, [Some((1000, 500)), None]);
        assert!(t.pressed);
        let mut full = vec![0u8; 78];
        full[0] = 0x31;
        full[34..42].copy_from_slice(&[0x80, 0, 0, 0, 0x80, 0, 0, 0]);
        assert_eq!(parse(&full, true).unwrap().touch, Some(Touch::default()));
    }
}
