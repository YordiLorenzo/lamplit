// Controllers, any number of them, three ways, all read only, so Steam and the games see them as before:
// - The DualSense over HID, USB and Bluetooth: no feature reports, no lightbar or rumble, so the controller's mode
//   stays whatever Steam or the game set. The same reports carry the battery and the headphone jack, which the
//   Settings screen shows; a Bluetooth controller can be turned off by dropping its Bluetooth link, as SpecialK does.
//   dualsense.rs reads the reports, trackpad.rs turns the touchpad into a mouse.
// - Xbox controllers, and others that work like one, through XInput (xbox.rs).
// - Any other controller Windows knows, through Windows.Gaming.Input (other.rs).
// navigation.rs turns what each says into steps for the page.

mod dualsense;
mod gestures;
mod navigation;
mod other;
mod trackpad;
mod xbox;

use crate::devices::{Charge, accessories};
use crate::dock;
use crate::error::{Error, Result};
use crate::events::{self, Event};
use crate::launch::window;
use crate::win::bluetooth;
use hidapi::{BusType, DeviceInfo, HidApi, HidDevice};
use navigation::{Action, Navigation};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::ffi::{CStr, CString};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use trackpad::Trackpad;

/// How often to look for controllers that were plugged in or connected.
const LOOK_EVERY: Duration = Duration::from_secs(2);
/// How often XInput and Windows.Gaming.Input are read while one of their controllers is connected: neither says when
/// a button changes.
const POLL_EVERY: Duration = Duration::from_millis(15);
/// A Bluetooth controller that went to sleep can leave a handle that never reads again; reopen it.
const IDLE_REOPEN: Duration = Duration::from_secs(15);
/// The Bluetooth HID service's UUID, which a Bluetooth controller's HID path contains: hidapi reports the bus of some
/// Bluetooth controllers as Unknown.
const BLUETOOTH_HID_SERVICE: &str = "00001124-0000-1000-8000-00805f9b34fb";

/// What kind of controller it is, which decides the button names the page shows (PlayStation symbols or Xbox
/// letters) and the Settings rows only a DualSense has.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[cfg_attr(test, derive(strum::VariantArray))]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Read over HID, with its battery, headphone jack and touchpad.
    DualSense,
    /// Another Sony controller (a DualShock 4), through Windows.Gaming.Input.
    PlayStation,
    /// An Xbox controller, or one that works like one, through XInput.
    Xbox,
    /// Any other controller, through Windows.Gaming.Input.
    Other,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[cfg_attr(test, derive(strum::VariantArray))]
#[serde(rename_all = "lowercase")]
pub enum Connection {
    Usb,
    Bluetooth,
    /// Bluetooth or Microsoft's wireless adapter: XInput and Windows.Gaming.Input don't say which.
    Wireless,
}

/// A controller's battery: the percent and the charge state from a DualSense or a controller Windows has a battery
/// report for, or only a rough level from an Xbox-style controller (XInput says no more).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
pub struct Battery {
    pub percent: Option<u8>,
    pub level: Option<Level>,
    pub charge: Option<Charge>,
}

impl Battery {
    fn percent(percent: u8, charge: Charge) -> Self {
        Battery { percent: Some(percent), level: None, charge: Some(charge) }
    }

    fn level(level: Level) -> Self {
        Battery { percent: None, level: Some(level), charge: None }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[cfg_attr(test, derive(strum::VariantArray))]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Empty,
    Low,
    Medium,
    Full,
}

#[derive(Clone, Serialize)]
pub struct Controller {
    /// A DualSense's HID path, which the UI hands back to turn it off; `xinput:<slot>` or `wgi:<Windows' id>` for
    /// the others.
    pub id: String,
    pub kind: Kind,
    /// What the Settings screen calls it.
    pub name: String,
    pub connection: Connection,
    /// None while it reports none: a Bluetooth DualSense nobody switched to full reports, a controller on a cable.
    pub battery: Option<Battery>,
    /// Headphones in a DualSense's jack, once a full report said; None for other controllers.
    pub headphones: Option<bool>,
    #[serde(skip)]
    pub address: Option<u64>,
}

impl Controller {
    /// The sound goes to its headphone jack: only over USB, with headphones plugged in.
    pub fn routes_sound(&self) -> bool {
        self.connection == Connection::Usb && self.headphones == Some(true)
    }
}

/// The controllers being read now, by id. Tauri state.
#[derive(Default)]
pub struct Controllers(Mutex<BTreeMap<String, Controller>>);

impl Controllers {
    pub fn list(&self) -> Vec<Controller> {
        self.0.lock().values().cloned().collect()
    }

    /// Turns a Bluetooth DualSense off: dropping its link makes it power down. Other controllers' addresses are
    /// unknown to Lamplit.
    pub fn turn_off(&self, id: &str) -> Result<()> {
        let address = self.0.lock().get(id).filter(|c| c.connection == Connection::Bluetooth).and_then(|c| c.address);
        let Some(address) = address else {
            let message = "Only a controller on Bluetooth can be turned off here; unplug the cable instead.";
            return Err(Error::Player(message.into()));
        };
        let radio = bluetooth::first_radio().map_err(|e| Error::Player(format!("No Bluetooth radio found: {e}")))?;
        bluetooth::disconnect(&radio, address)
            .map_err(|e| Error::Player(format!("Windows didn't drop the controller's link: {e}")))
    }
}

pub fn start(app: AppHandle) {
    let polled = app.clone();
    std::thread::spawn(move || poll(&polled));
    std::thread::spawn(move || {
        let connected = app.state::<Controllers>();
        let api = match HidApi::new() {
            Ok(api) => api,
            Err(e) => {
                log::warn!("controller: HID unavailable: {e}");
                return;
            }
        };
        let pads = api.device_list().filter(|d| dualsense::is(d.vendor_id(), d.product_id())).count();
        log::info!("controller: {} HID devices, {pads} DualSense connected", api.device_list().count());
        // Shared with the readers, which reopen their controller through it.
        let api = Arc::new(Mutex::new(api));
        // Paths that failed to open, so one that keeps failing is logged once.
        let mut failed: HashSet<CString> = HashSet::new();
        loop {
            let mut sony = api.lock();
            // Only Sony's devices: listing every HID device would ask each one for its names every two seconds.
            if let Err(e) = sony.reset_devices().and_then(|()| sony.add_devices(dualsense::SONY, 0)) {
                log::warn!("controller: device scan failed: {e}");
            }
            for info in sony.device_list().filter(|d| dualsense::is(d.vendor_id(), d.product_id())) {
                let path = info.path();
                if connected.0.lock().contains_key(path.to_string_lossy().as_ref()) {
                    continue;
                }
                match info.open_device(&sony) {
                    Ok(dev) => {
                        failed.remove(path);
                        attach(&app, &api, info, dev);
                    }
                    Err(e) => {
                        if failed.insert(path.to_owned()) {
                            log::warn!("controller: can't open {}: {e}", path.to_string_lossy());
                        }
                    }
                }
            }
            drop(sony);
            std::thread::sleep(LOOK_EVERY);
        }
    });
}

/// Lists a controller that was just opened and reads it on a thread of its own. Once it is gone it leaves the list,
/// and the sound moves on if it went to the controller's headphones.
fn attach(app: &AppHandle, api: &Arc<Mutex<HidApi>>, info: &DeviceInfo, dev: HidDevice) {
    let path = info.path().to_owned();
    let id = path.to_string_lossy().into_owned();
    let bluetooth = matches!(info.bus_type(), BusType::Bluetooth) || id.to_lowercase().contains(BLUETOOTH_HID_SERVICE);
    log::info!("controller: opened {id} ({})", if bluetooth { "Bluetooth" } else { "USB" });
    list(
        app,
        Controller {
            id: id.clone(),
            kind: Kind::DualSense,
            name: dualsense::name(info.product_id()).into(),
            connection: if bluetooth { Connection::Bluetooth } else { Connection::Usb },
            battery: None,
            headphones: None,
            address: dualsense::address(info.serial_number()),
        },
    );
    let (app, api) = (app.clone(), api.clone());
    std::thread::spawn(move || {
        read(dev, &api, &path, bluetooth, &id, &app);
        unlist(&app, &id);
    });
}

/// Puts a controller Lamplit now reads on the list the Settings screen shows.
fn list(app: &AppHandle, controller: Controller) {
    app.state::<Controllers>().0.lock().insert(controller.id.clone(), controller);
    events::emit(app, Event::Accessories);
}

/// Takes a controller that is gone off the list. The sound moves on if it went to the controller's headphones.
fn unlist(app: &AppHandle, id: &str) {
    let gone = app.state::<Controllers>().0.lock().remove(id);
    events::emit(app, Event::Accessories);
    if gone.is_some_and(|c| c.routes_sound()) {
        accessories::settle_sound(app);
    }
}

/// What a listed controller's battery says now. The page hears only of a change.
fn set_battery(app: &AppHandle, id: &str, battery: Option<Battery>) {
    let controllers = app.state::<Controllers>();
    let changed =
        controllers.0.lock().get_mut(id).is_some_and(|c| std::mem::replace(&mut c.battery, battery) != battery);
    if changed {
        events::emit(app, Event::Accessories);
    }
}

/// Reads one controller until it is gone. A handle that read nothing for a while is reopened in place, so the
/// controller stays in the list meanwhile.
fn read(mut dev: HidDevice, api: &Mutex<HidApi>, path: &CStr, bluetooth: bool, id: &str, app: &AppHandle) {
    let mut buf = [0u8; 128];
    let mut navigation = Navigation::default();
    let mut trackpad = Trackpad::default();
    let mut last_data = Instant::now();
    let mut last_status = None;
    loop {
        match dev.read_timeout(&mut buf, 50) {
            Ok(0) if last_data.elapsed() > IDLE_REOPEN => {
                drop(dev);
                dev = match api.lock().open_path(path) {
                    Ok(dev) => dev,
                    Err(e) => {
                        log::info!("controller: gone ({e})");
                        return;
                    }
                };
                last_data = Instant::now();
            }
            Ok(0) => {}
            Ok(n) => {
                last_data = Instant::now();
                if let Some(report) = dualsense::parse(&buf[..n], bluetooth) {
                    for action in navigation.update(report.input, last_data) {
                        act(app, Kind::DualSense, action);
                    }
                    if let Some(touch) = report.touch {
                        trackpad.update(touch, app);
                    }
                    if let Some(status) = report.status
                        && Some(status) != last_status
                    {
                        last_status = Some(status);
                        let jack_changed = app.state::<Controllers>().0.lock().get_mut(id).is_some_and(|c| {
                            let before = c.routes_sound();
                            c.battery = Some(Battery::percent(status.battery, status.charge));
                            c.headphones = Some(status.headphones);
                            c.routes_sound() != before
                        });
                        events::emit(app, Event::Accessories);
                        // Moving the sound takes a moment, and this thread has reports to read.
                        if jack_changed {
                            let app = app.clone();
                            std::thread::spawn(move || accessories::settle_sound(&app));
                        }
                    }
                }
            }
            Err(e) => {
                log::info!("controller: read ended: {e}");
                return;
            }
        }
        for action in navigation.tick(Instant::now()) {
            act(app, Kind::DualSense, action);
        }
    }
}

/// Reads Xbox-style controllers (XInput) and other controllers (Windows.Gaming.Input), on one thread: every
/// POLL_EVERY while one is connected, and only looking for new ones every LOOK_EVERY otherwise.
fn poll(app: &AppHandle) {
    let (mut xbox, mut others) = (xbox::Slots::default(), other::Others::default());
    let mut look_at = Instant::now();
    loop {
        let now = Instant::now();
        if now >= look_at {
            xbox.look(app);
            others.look(app, &xbox);
            look_at = now + LOOK_EVERY;
        }
        let xbox_actions = xbox.read(app, now).into_iter().map(|action| (Kind::Xbox, action));
        for (kind, action) in xbox_actions.chain(others.read(now)) {
            act(app, kind, action);
        }
        let reading = xbox.reading() || others.reading();
        std::thread::sleep(if reading { POLL_EVERY } else { look_at.saturating_duration_since(Instant::now()) });
    }
}

/// The kind of controller that did something last. The page shows its button names, so it hears of a change.
static LAST_KIND: Mutex<Option<Kind>> = Mutex::new(None);

/// The kind of controller used last, None before any was. The controllers are read before the page listens, so it
/// asks once it does.
pub fn last_kind() -> Option<Kind> {
    *LAST_KIND.lock()
}

fn act(app: &AppHandle, kind: Kind, action: Action) {
    if LAST_KIND.lock().replace(kind) != Some(kind) {
        events::emit(app, Event::PadKind(kind));
    }
    match action {
        // Navigation only reaches the UI while Lamplit is the window in front, or while the dock is open, so a game
        // never moves it.
        Action::Nav(nav) => {
            if window::lamplit_in_front() {
                events::emit(app, Event::Pad(nav));
            } else if dock::is_open() {
                events::emit(app, Event::DockPad(nav));
            }
        }
        Action::Summon => dock::summon(app),
    }
}
