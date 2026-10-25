// DualSense input over HID, USB and Bluetooth, any number of controllers. Read only: no feature reports,
// no lightbar or rumble, so the controller's mode stays whatever Steam or the game set. The same reports carry the
// battery and the headphone jack, which the Settings screen shows; a Bluetooth controller can be turned off by
// dropping its Bluetooth link, as SpecialK does. dualsense.rs reads the reports, navigation.rs turns the buttons into
// steps for the page, trackpad.rs the touchpad into a mouse.

mod dualsense;
mod gestures;
mod navigation;
mod trackpad;

use crate::devices::accessories;
use crate::error::{Error, Result};
use crate::events::{self, Event};
use crate::launch::window;
use crate::win::bluetooth;
pub use dualsense::Status;
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

const SONY: u16 = 0x054C;
const DUALSENSE: [u16; 2] = [0x0CE6, 0x0DF2]; // DualSense, DualSense Edge
/// How often to look for controllers that were plugged in or connected.
const LOOK_EVERY: Duration = Duration::from_secs(2);
/// A Bluetooth controller that went to sleep can leave a handle that never reads again; reopen it.
const IDLE_REOPEN: Duration = Duration::from_secs(15);
/// The Bluetooth HID service's UUID, which a Bluetooth controller's HID path contains: hidapi reports the bus of some
/// Bluetooth controllers as Unknown.
const BLUETOOTH_HID_SERVICE: &str = "00001124-0000-1000-8000-00805f9b34fb";

#[derive(Clone, Serialize)]
pub struct Controller {
    /// The HID path, which the UI hands back to turn it off.
    pub id: String,
    pub bluetooth: bool,
    /// None until a full report came in: a Bluetooth controller nobody switched to full reports sends no battery.
    pub status: Option<Status>,
    #[serde(skip)]
    pub address: Option<u64>,
}

impl Controller {
    /// The sound goes to its headphone jack: only over USB, with headphones plugged in.
    pub fn routes_sound(&self) -> bool {
        !self.bluetooth && self.status.is_some_and(|s| s.headphones)
    }
}

/// The controllers being read now, by HID path. Tauri state.
#[derive(Default)]
pub struct Controllers(Mutex<BTreeMap<String, Controller>>);

impl Controllers {
    pub fn list(&self) -> Vec<Controller> {
        self.0.lock().values().cloned().collect()
    }

    /// Turns a Bluetooth controller off: dropping its link makes it power down.
    pub fn turn_off(&self, id: &str) -> Result<()> {
        let address = self.0.lock().get(id).filter(|c| c.bluetooth).and_then(|c| c.address);
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
    std::thread::spawn(move || {
        let connected = app.state::<Controllers>();
        let api = match HidApi::new() {
            Ok(api) => api,
            Err(e) => {
                log::warn!("controller: HID unavailable: {e}");
                return;
            }
        };
        let pads = api.device_list().filter(|d| d.vendor_id() == SONY && DUALSENSE.contains(&d.product_id())).count();
        log::info!("controller: {} HID devices, {pads} DualSense connected", api.device_list().count());
        // Shared with the readers, which reopen their controller through it.
        let api = Arc::new(Mutex::new(api));
        // Paths that failed to open, so one that keeps failing is logged once.
        let mut failed: HashSet<CString> = HashSet::new();
        loop {
            let mut sony = api.lock();
            // Only Sony's devices: listing every HID device would ask each one for its names every two seconds.
            if let Err(e) = sony.reset_devices().and_then(|()| sony.add_devices(SONY, 0)) {
                log::warn!("controller: device scan failed: {e}");
            }
            for info in sony.device_list().filter(|d| DUALSENSE.contains(&d.product_id())) {
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
    let address = dualsense::address(info.serial_number());
    let controller = Controller { id: id.clone(), bluetooth, status: None, address };
    app.state::<Controllers>().0.lock().insert(id.clone(), controller);
    events::emit(app, Event::Accessories);
    let (app, api) = (app.clone(), api.clone());
    std::thread::spawn(move || {
        read(dev, &api, &path, bluetooth, &id, &app);
        let gone = app.state::<Controllers>().0.lock().remove(&id);
        events::emit(&app, Event::Accessories);
        if gone.is_some_and(|c| c.routes_sound()) {
            accessories::settle_sound(&app);
        }
    });
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
                        act(app, action);
                    }
                    if let Some(touch) = report.touch {
                        trackpad.update(touch, app);
                    }
                    if report.status.is_some() && report.status != last_status {
                        last_status = report.status;
                        let jack_changed = app.state::<Controllers>().0.lock().get_mut(id).is_some_and(|c| {
                            let before = c.routes_sound();
                            c.status = last_status;
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
            act(app, action);
        }
    }
}

fn act(app: &AppHandle, action: Action) {
    match action {
        // Navigation only reaches the UI while Lamplit is the window in front, so a game never moves it.
        Action::Nav(nav) => {
            if window::lamplit_in_front() {
                events::emit(app, Event::Pad(nav));
            }
        }
        Action::Summon => window::summon(app),
    }
}
