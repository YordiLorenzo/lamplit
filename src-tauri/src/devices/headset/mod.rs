// The Logitech G PRO X 2 LIGHTSPEED headset, through its USB receiver (046D:0AF7): on or off, battery, sidetone and
// the auto-off timer. The receiver speaks Logitech's Centurion protocol (centurion.rs) on its vendor HID collection
// (usage page 0xFFA0).
//
// One thread owns the receiver. It hears the receiver announce the headset going on or off, reads the battery when
// the headset comes on and every few minutes while it is on (never while it is off: polling an off headset can
// wedge the receiver), and makes the changes the Settings screen asks for. Settings live on the headset itself.

mod centurion;

use crate::devices::{Charge, accessories};
use crate::error::{Error, Result};
use crate::events::{self, Event};
use centurion::{AUTO_OFF, BATTERY, BRIDGE, Message, Reply, Request, SIDETONE};
use hidapi::{HidApi, HidDevice, HidError, HidResult};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// Part of the names Windows gives the receiver's sound devices, "Speakers (PRO X 2 LIGHTSPEED)" and "Microphone
/// (PRO X 2 LIGHTSPEED)": the sound follows the headset to these.
pub const SOUND_NAME: &str = "PRO X 2";

const LOGITECH: u16 = 0x046D;
const PRO_X2_RECEIVER: u16 = 0x0AF7;
const VENDOR_PAGE: u16 = 0xFFA0;
const ANSWER_WITHIN: Duration = Duration::from_millis(1500);
const BATTERY_EVERY: Duration = Duration::from_mins(5);
/// A headset that just came on needs a moment before it answers.
const READ_AFTER_ON: Duration = Duration::from_secs(2);
const READ_AGAIN: Duration = Duration::from_secs(5);
/// How often to look for the receiver while it isn't plugged in.
const LOOK_EVERY: Duration = Duration::from_secs(10);
/// A receiver that is plugged in but doesn't answer is asked half as often each time, down to this.
const LOOK_AT_LEAST_EVERY: Duration = Duration::from_mins(5);
/// How long the Settings screen waits for the headset to take a change.
const CHANGE_WITHIN: Duration = Duration::from_secs(5);

/// What the Settings screen shows about the headset.
#[derive(Clone, Default, Serialize)]
pub struct Status {
    /// The receiver is plugged in.
    pub receiver: bool,
    /// The headset is on; None until Lamplit knows.
    pub on: Option<bool>,
    pub battery: Option<u8>,
    pub charge: Option<Charge>,
    /// 0 to 100; None when the headset doesn't offer it.
    pub sidetone: Option<u8>,
    /// Minutes until an unused headset turns itself off, 0 = never; None when it can't be changed here.
    pub auto_off: Option<u8>,
}

/// The headset as Lamplit last heard from it, and the way to the thread that owns the receiver. Tauri state.
pub struct Headset {
    status: Mutex<Status>,
    changes: Sender<Change>,
}

impl Headset {
    pub fn status(&self) -> Status {
        self.status.lock().clone()
    }

    fn update(&self, change: impl FnOnce(&mut Status)) {
        change(&mut self.status.lock());
    }

    /// Changes a setting on the headset; waits for the headset to take it.
    pub fn change(&self, setting: Setting, value: u8) -> Result<()> {
        let (done, answer) = channel();
        let deadline = Instant::now() + CHANGE_WITHIN;
        if self.changes.send(Change { setting, value, done, deadline }).is_err() {
            return Err(Error::Player("Lamplit isn't watching the headset.".into()));
        }
        answer.recv_timeout(CHANGE_WITHIN).unwrap_or_else(|_| Err(Error::Player("The headset didn't answer.".into())))
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Setting {
    Sidetone,
    AutoOff,
}

struct Change {
    setting: Setting,
    value: u8,
    done: Sender<Result<()>>,
    /// When the caller stops waiting and tells the player the headset didn't answer.
    deadline: Instant,
}

/// Puts the headset in Tauri's state and starts the thread that owns the receiver.
pub fn start(app: AppHandle) {
    let (changes, requests) = channel();
    app.manage(Headset { status: Mutex::default(), changes });
    std::thread::spawn(move || watch(&app, &requests));
}

/// Looks for the receiver, and serves it while it is plugged in.
fn watch(app: &AppHandle, changes: &Receiver<Change>) {
    let headset = app.state::<Headset>();
    let mut api = match HidApi::new() {
        Ok(api) => api,
        Err(e) => {
            log::warn!("headset: HID unavailable: {e}");
            return;
        }
    };
    // What the last look found. It is logged only when it differs, since the same look repeats every few seconds.
    let mut found = String::new();
    let mut wait = LOOK_EVERY;
    loop {
        let now_found = match open_receiver(&mut api) {
            Ok(None) => {
                wait = LOOK_EVERY;
                "no PRO X 2 receiver plugged in".to_string()
            }
            Err(e) => format!("can't open the receiver: {e}"),
            Ok(Some(dev)) => match find_bridge(&dev) {
                Ok(bridge) => {
                    log::info!("headset: receiver found");
                    wait = LOOK_EVERY;
                    let mut link = Link {
                        dev,
                        bridge,
                        app,
                        headset: &headset,
                        on: None,
                        features: None,
                        sidetone_len: 0,
                        auto_off_data: Vec::new(),
                        read_at: None,
                        tries: 0,
                    };
                    let Err(why) = link.serve(changes);
                    headset.update(|s| *s = Status::default());
                    events::emit(app, Event::Accessories);
                    format!("receiver gone ({why})")
                }
                Err(e) => {
                    wait = (wait * 2).min(LOOK_AT_LEAST_EVERY);
                    format!("the receiver doesn't say where its headset is: {e}")
                }
            },
        };
        if now_found != found {
            log::info!("headset: {now_found}");
            found = now_found;
        }
        // Until the receiver is back, answer changes right away rather than letting them wait.
        match changes.recv_timeout(wait) {
            Ok(change) => {
                let _ = change.done.send(Err(Error::Player("The headset's receiver isn't plugged in.".into())));
            }
            Err(RecvTimeoutError::Timeout) => {}
            // Lamplit is closing.
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// Opens the receiver's vendor collection when it is plugged in. Only Logitech's receiver is listed: listing every
/// HID device would ask each one for its names on every look.
fn open_receiver(api: &mut HidApi) -> HidResult<Option<HidDevice>> {
    api.reset_devices()?;
    api.add_devices(LOGITECH, PRO_X2_RECEIVER)?;
    api.device_list().find(|d| d.usage_page() == VENDOR_PAGE).map(|d| d.open_device(api)).transpose()
}

/// Asks the receiver for the index of its bridge to the headset.
fn find_bridge(dev: &HidDevice) -> Result<u8> {
    let request = Request::to_receiver(0, 0);
    dev.write(&request.frame(&BRIDGE.to_be_bytes()))?;
    let deadline = Instant::now() + ANSWER_WITHIN;
    let mut buf = [0u8; 64];
    while Instant::now() < deadline {
        let n = dev.read_timeout(&mut buf, 100)?;
        match request.reply(&centurion::parse(&buf[..n], None)) {
            Some(Reply::Answer(&[bridge, ..])) if bridge != 0 => return Ok(bridge),
            Some(_) => return Err(Error::Internal("it has no headset bridge".into())),
            None => {}
        }
    }
    Err(Error::Internal("no answer".into()))
}

enum Fail {
    /// The headset (or the receiver's bridge) said no: usually because the headset is off.
    Refused,
    /// No answer in time.
    Silent,
    /// The receiver can't be read any more (unplugged).
    Gone(HidError),
}

/// The headset's feature indexes (None: it doesn't have that one).
#[derive(Clone, Copy)]
struct Features {
    battery: Option<u8>,
    sidetone: Option<u8>,
    auto_off: Option<u8>,
}

struct Link<'a> {
    dev: HidDevice,
    bridge: u8,
    app: &'a AppHandle,
    headset: &'a Headset,
    /// The headset is on; None until Lamplit knows.
    on: Option<bool>,
    features: Option<Features>,
    /// The sidetone answer's length: 3 bytes (level last) or 4 (with a reserved byte before it).
    sidetone_len: usize,
    /// What the auto-off timer read as; its last byte is the minutes.
    auto_off_data: Vec<u8>,
    /// When to read the headset next (it just came on, or didn't answer yet), and how often that failed in a row.
    read_at: Option<Instant>,
    tries: u8,
}

impl Link<'_> {
    /// Asks the headset's feature at `index` and waits for the answer, taking in the receiver's on/off news on the
    /// way.
    fn ask(&mut self, index: u8, function: u8, params: &[u8]) -> Result<Vec<u8>, Fail> {
        let request = Request::to_headset(self.bridge, index, function);
        self.dev.write(&request.frame(params)).map_err(Fail::Gone)?;
        let deadline = Instant::now() + ANSWER_WITHIN;
        let mut buf = [0u8; 64];
        while Instant::now() < deadline {
            let n = self.dev.read_timeout(&mut buf, 100).map_err(Fail::Gone)?;
            let message = centurion::parse(&buf[..n], Some(self.bridge));
            match request.reply(&message) {
                Some(Reply::Answer(data)) => return Ok(data.to_vec()),
                Some(Reply::Refused) => return Err(Fail::Refused),
                None => {
                    if let Message::Power(on) = message {
                        self.heard(on);
                    }
                }
            }
        }
        Err(Fail::Silent)
    }

    /// Serves the receiver until it can't be read any more, and says why.
    fn serve(&mut self, changes: &Receiver<Change>) -> Result<Infallible> {
        self.headset.update(|h| h.receiver = true);
        // Whether the headset is on at the start shows in whether it answers.
        match self.read_all() {
            Ok(()) => self.power(true),
            Err(Fail::Refused) => self.power(false),
            // Unless the receiver said "off" meanwhile: an off headset is never asked again.
            Err(Fail::Silent) if self.on != Some(false) => self.read_at = Some(Instant::now() + READ_AGAIN),
            Err(Fail::Silent) => {}
            Err(Fail::Gone(e)) => return Err(e.into()),
        }
        events::emit(self.app, Event::Accessories);
        let mut next_battery = Instant::now() + BATTERY_EVERY;
        let mut buf = [0u8; 64];
        loop {
            while let Ok(change) = changes.try_recv() {
                // Past its deadline the player was told the headset didn't answer, so it must not change after all.
                if Instant::now() < change.deadline {
                    let _ = change.done.send(self.apply(change.setting, change.value));
                }
            }
            if self.read_at.is_some_and(|at| Instant::now() >= at) {
                self.read_at = None;
                match self.read_all() {
                    Ok(()) => {
                        self.tries = 0;
                        next_battery = Instant::now() + BATTERY_EVERY;
                        self.power(true);
                    }
                    Err(Fail::Gone(e)) => return Err(e.into()),
                    // The receiver said "off" while Lamplit was asking: stop.
                    Err(_) if self.on == Some(false) => {}
                    // Just switched on, it can take a moment to answer.
                    Err(_) if self.tries < 5 => {
                        self.tries += 1;
                        self.read_at = Some(Instant::now() + READ_AGAIN);
                    }
                    Err(_) => log::warn!("headset: no answer from the headset; trying again when it next turns on"),
                }
                events::emit(self.app, Event::Accessories);
            }
            if self.on == Some(true) && Instant::now() >= next_battery {
                if let Err(Fail::Gone(e)) = self.read_battery() {
                    return Err(e.into());
                }
                next_battery = Instant::now() + BATTERY_EVERY;
            }
            let n = self.dev.read_timeout(&mut buf, 250)?;
            if let Message::Power(on) = centurion::parse(&buf[..n], Some(self.bridge)) {
                self.heard(on);
            }
        }
    }

    /// The receiver says the headset turned on or off. One that came on is read once it is ready to answer.
    fn heard(&mut self, on: bool) {
        if self.on == Some(on) {
            return;
        }
        self.read_at = on.then(|| Instant::now() + READ_AFTER_ON);
        self.tries = 0;
        self.power(on);
    }

    /// The headset is on or off (the receiver's news, or Lamplit finding out).
    fn power(&mut self, on: bool) {
        let was = self.on.replace(on);
        if was == Some(on) {
            return;
        }
        log::info!("headset: {}", if on { "on" } else { "off" });
        self.headset.update(|h| h.on = Some(on));
        events::emit(self.app, Event::Accessories);
        // A real change moves the sound. Finding out at start doesn't, except away from a headset that is off: Windows
        // keeps sending sound to its receiver then, and nothing plays.
        if was.is_some() {
            accessories::settle_sound(self.app);
        } else if !on {
            accessories::move_sound_off_headset_found_off(self.app);
        }
    }

    /// Reads all the headset tells: features (once), battery, sidetone, auto-off. An off headset refuses.
    fn read_all(&mut self) -> Result<(), Fail> {
        if self.features.is_none() {
            self.features = Some(self.find_features()?);
        }
        self.read_battery()?;
        self.read_sidetone()?;
        self.read_auto_off()
    }

    fn find_features(&mut self) -> Result<Features, Fail> {
        let mut index = |id: u16| self.ask(0, 0, &id.to_be_bytes()).map(|d| d.first().copied().filter(|&i| i != 0));
        let found = Features { battery: index(BATTERY)?, sidetone: index(SIDETONE)?, auto_off: index(AUTO_OFF)? };
        log::info!(
            "headset: feature indexes battery {:?}, sidetone {:?}, auto-off {:?}",
            found.battery,
            found.sidetone,
            found.auto_off
        );
        Ok(found)
    }

    fn feature(&self, pick: impl Fn(Features) -> Option<u8>) -> Option<u8> {
        self.features.and_then(pick)
    }

    /// Battery: [level %, level again, charge state].
    fn read_battery(&mut self) -> Result<(), Fail> {
        let Some(index) = self.feature(|f| f.battery) else { return Ok(()) };
        let data = self.ask(index, 0, &[])?;
        let (battery, charge) = centurion::battery(&data).ok_or(Fail::Silent)?;
        self.headset.update(|h| {
            h.battery = Some(battery);
            h.charge = Some(charge);
        });
        Ok(())
    }

    fn read_sidetone(&mut self) -> Result<(), Fail> {
        let Some(index) = self.feature(|f| f.sidetone) else { return Ok(()) };
        let data = self.ask(index, 0, &[])?;
        let level = matches!(data.len(), 3 | 4).then(|| data[data.len() - 1].min(100));
        self.sidetone_len = data.len();
        self.headset.update(|h| h.sidetone = level);
        Ok(())
    }

    fn read_auto_off(&mut self) -> Result<(), Fail> {
        let Some(index) = self.feature(|f| f.auto_off) else { return Ok(()) };
        let data = self.ask(index, 0, &[])?;
        // One byte (minutes) or two (reserved, minutes); newer layouts with several timers are left alone.
        let minutes = matches!(data.len(), 1 | 2).then(|| data[data.len() - 1]);
        self.auto_off_data = data;
        self.headset.update(|h| h.auto_off = minutes);
        Ok(())
    }

    fn apply(&mut self, setting: Setting, value: u8) -> Result<()> {
        let refuse = |message: &str| Err(Error::Player(message.into()));
        if self.on != Some(true) {
            return refuse("Turn the headset on first.");
        }
        let Some(features) = self.features else { return refuse("The headset hasn't been read yet.") };
        let (feature, params) = match setting {
            Setting::Sidetone => {
                let value = value.min(100);
                let params = if self.sidetone_len == 4 { vec![0x01, 0xFF, value] } else { vec![0x01, value] };
                (features.sidetone, params)
            }
            Setting::AutoOff => {
                let mut params = self.auto_off_data.clone();
                if !matches!(params.len(), 1 | 2) {
                    return refuse("This headset's auto-off timer can't be changed here.");
                }
                *params.last_mut().unwrap() = value;
                (features.auto_off, params)
            }
        };
        let Some(index) = feature else { return refuse("The headset doesn't offer this.") };
        match self.ask(index, 1, &params) {
            Ok(_) => {}
            Err(Fail::Refused) => return refuse("The headset refused that."),
            Err(Fail::Silent) => return refuse("The headset didn't answer."),
            Err(Fail::Gone(e)) => return Err(e.into()),
        }
        log::info!("headset: {setting:?} set to {value}");
        // Read it back, so the screen shows what the headset took.
        let _ = match setting {
            Setting::Sidetone => self.read_sidetone(),
            Setting::AutoOff => self.read_auto_off(),
        };
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_come_from_the_page_by_their_fixture_names() {
        let settings: Vec<Setting> = serde_json::from_value(ipc_fixture!("headset-settings")).unwrap();
        assert!(matches!(settings[..], [Setting::Sidetone, Setting::AutoOff]));
    }
}
