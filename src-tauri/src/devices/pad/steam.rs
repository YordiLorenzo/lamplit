// Steam Controller (2026, Triton) input, as described by SDL 3.4.20's Steam Triton driver and controller_structs.h.
// Its vendor HID collection carries gamepad reports even though Windows has no standard gamepad mapping for it.
// Unlike SDL, Lamplit never disables lizard mode or sends any feature/output reports. hidapi opens shared handles,
// so Steam keeps control of the mode. The built-in keyboard and mouse continue to reach Windows as before.

use super::navigation::{Dir, Input, Navigation};
use super::{Connection, Controller, Kind};
use hidapi::HidDevice;
use std::time::{Duration, Instant};
use tauri::AppHandle;

pub const VALVE: u16 = 0x28DE;

pub fn is(vendor: u16, product: u16) -> bool {
    vendor == VALVE && matches!(product, 0x1302..=0x1305)
}

/// The dongles also have keyboard, mouse and pairing collections; only the controller collection carries input.
pub fn collection(vendor: u16, product: u16, usage_page: u16, usage: u16) -> bool {
    is(vendor, product) && usage_page == 0xFF00 && usage == 1
}

pub fn connection(product: u16) -> Connection {
    match product {
        0x1303 => Connection::Bluetooth,
        0x1304 | 0x1305 => Connection::Wireless,
        _ => Connection::Usb,
    }
}

/// A receiver can stay present after its controller sleeps, without sending a disconnect report. State normally
/// arrives every few milliseconds. Stop held actions before the UI's hold to confirm can finish without the pad.
const INPUT_LOST: Duration = Duration::from_millis(250);

pub fn read(dev: &HidDevice, controller: &Controller, app: &AppHandle) {
    let mut navigation: Option<Navigation> = None;
    let mut last_input = Instant::now();
    let mut buf = [0u8; 128];
    loop {
        let n = match dev.read_timeout(&mut buf, 50) {
            Ok(n) => n,
            Err(e) => {
                log::info!("controller: Steam Controller read ended: {e}");
                break;
            }
        };
        let now = Instant::now();
        if let Some(input) = parse(&buf[..n]) {
            if navigation.is_none() {
                log::info!("controller: Steam Controller reporting ({:?})", controller.connection);
                super::list(app, controller.clone());
            }
            let navigation = navigation.get_or_insert_with(|| Navigation::starting_from(input));
            last_input = now;
            for action in navigation.update(input, now) {
                super::act(app, Kind::Xbox, action);
            }
        } else if disconnected(&buf[..n]) || now.duration_since(last_input) >= INPUT_LOST {
            if let Some(mut gone) = navigation.take() {
                for action in gone.let_go() {
                    super::act(app, Kind::Xbox, action);
                }
                super::unlist(app, &controller.id);
            }
            // A sleeping Bluetooth controller may leave a handle that never reads again. Let discovery reopen it.
            if now.duration_since(last_input) >= super::IDLE_REOPEN {
                break;
            }
        }
        if let Some(navigation) = &mut navigation {
            for action in navigation.tick(now) {
                super::act(app, Kind::Xbox, action);
            }
        }
    }
    if let Some(mut navigation) = navigation {
        for action in navigation.let_go() {
            super::act(app, Kind::Xbox, action);
        }
        super::unlist(app, &controller.id);
    }
}

fn disconnected(r: &[u8]) -> bool {
    matches!(r, [0x46 | 0x79, 1, ..])
}

/// USB, BLE and the newer timestamp report share buttons and sticks before their different touch/IMU fields.
fn parse(r: &[u8]) -> Option<Input> {
    if r.len() < 46 || !matches!(r[0], 0x42 | 0x45 | 0x47) {
        return None;
    }
    let buttons = u32::from_le_bytes([r[2], r[3], r[4], r[5]]);
    let down = |mask: u32| buttons & mask != 0;
    let axis = |at: usize| f32::from(i16::from_le_bytes([r[at], r[at + 1]])) / 32768.0;
    let dpad = Dir::of_dpad([0x2000, 0x0400, 0x1000, 0x0800].map(down));
    Some(Input {
        dir: dpad.or(Dir::of_stick(axis(10), -axis(12))),
        south: down(0x0001),
        east: down(0x0002),
        west: down(0x0004),
        north: down(0x0008),
        l1: down(0x0008_0000),
        r1: down(0x0200),
        view: down(0x0040),
        menu: down(0x4000),
        // Keep the Steam button for Steam. View + Menu already summons Lamplit with Xbox-style hints.
        home: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(id: u8, buttons: u32, x: i16, y: i16) -> [u8; 46] {
        let mut r = [0; 46];
        r[0] = id;
        r[2..6].copy_from_slice(&buttons.to_le_bytes());
        r[10..12].copy_from_slice(&x.to_le_bytes());
        r[12..14].copy_from_slice(&y.to_le_bytes());
        r
    }

    #[test]
    fn only_the_real_controllers_vendor_collection_is_opened() {
        for product in 0x1302..=0x1305 {
            assert!(collection(VALVE, product, 0xFF00, 1));
            assert!(!collection(VALVE, product, 1, 2));
            assert!(!collection(VALVE, product, 1, 6));
            assert!(!collection(VALVE, product, 0xFF00, 2));
        }
        assert!(!is(VALVE, 0x11FF));
        assert!(!is(0x1234, 0x1302));
        assert_eq!(connection(0x1302), Connection::Usb);
        assert_eq!(connection(0x1303), Connection::Bluetooth);
        assert_eq!(connection(0x1304), Connection::Wireless);
        assert_eq!(connection(0x1305), Connection::Wireless);
    }

    #[test]
    fn every_transport_uses_the_same_face_buttons_and_stick() {
        for id in [0x42, 0x45, 0x47] {
            let input = parse(&report(id, 0x0008_4249, 0, 32767)).unwrap();
            assert_eq!(input.dir, Some(Dir::Up));
            assert!(input.south && input.north && input.view && input.menu && input.l1 && input.r1);
            assert!(!input.east && !input.west && !input.home);
            let input = parse(&report(id, 0x0001_0006, -32768, 0)).unwrap();
            assert_eq!(input.dir, Some(Dir::Left));
            assert!(input.east && input.west && !input.south && !input.home);
        }
    }

    #[test]
    fn dpad_wins_over_stick_and_rest_is_no_direction() {
        for (buttons, dir) in [(0x2000, Dir::Up), (0x0400, Dir::Down), (0x1000, Dir::Left), (0x2800, Dir::Right)] {
            assert_eq!(parse(&report(0x42, buttons, 32767, 0)).unwrap().dir, Some(dir));
        }
        assert_eq!(parse(&report(0x45, 0, 100, -100)).unwrap().dir, None);
        assert_eq!(parse(&report(0x47, 0, 0, -32768)).unwrap().dir, Some(Dir::Down));
    }

    #[test]
    fn short_reports_keyboard_mouse_and_battery_are_not_navigation() {
        let full = report(0x42, 1, 0, 0);
        for n in 0..full.len() {
            assert_eq!(parse(&full[..n]), None);
        }
        for id in [0x40, 0x41, 0x43, 0x79, 0x7B] {
            assert_eq!(parse(&report(id, 1, 0, 0)), None);
        }
        assert!(disconnected(&[0x46, 1]));
        assert!(disconnected(&[0x79, 1, 0]));
        assert!(!disconnected(&[0x79, 2]));
        assert!(!disconnected(&[0x42, 1]));
        assert!(!disconnected(&[0x79]));
    }
}
