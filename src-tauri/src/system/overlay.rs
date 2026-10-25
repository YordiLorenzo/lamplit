// In-game overlays Lamplit switches from the sofa. For now NVIDIA's statistics overlay (FPS, frame time, GPU and CPU
// load), which works in every game whatever its store. NVIDIA has no API for it, so Lamplit presses the overlay's own
// hotkey and reads the state back from the overlay's log.

use crate::error::{Error, Result};
use crate::files::local_app_data;
use crate::win;
use parking_lot::Mutex;
use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Alt+R, NVIDIA's default for the statistics overlay.
const DEFAULT_HOTKEY: [u16; 2] = [0x12, 0x52];

#[derive(Clone, Serialize)]
pub struct Overlays {
    /// NVIDIA's overlay is installed: it keeps a log.
    pub nvidia_overlay: bool,
    /// Whether its statistics show. None when the overlay isn't installed, or when its log doesn't say (yet, or no
    /// longer: only the end of the log is read). The player can still switch it, and the log then says again.
    pub nvidia_stats: Option<bool>,
}

pub fn state() -> Overlays {
    Overlays { nvidia_overlay: log_path().is_file(), nvidia_stats: nvidia_stats() }
}

fn overlay_dir() -> PathBuf {
    local_app_data().join(r"NVIDIA Corporation\NVIDIA Overlay")
}

fn log_path() -> PathBuf {
    overlay_dir().join("console.log")
}

/// Whether the statistics overlay shows, from the last megabyte of the overlay's log.
fn nvidia_stats() -> Option<bool> {
    let mut file = std::fs::File::open(log_path()).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(1 << 20))).ok()?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).ok()?;
    stats_showing(&String::from_utf8_lossy(&tail))
}

/// The statistics hotkey the player set in the overlay, else Alt+R.
fn hotkey() -> Vec<u16> {
    std::fs::read_to_string(overlay_dir().join("ShareSettings.json"))
        .ok()
        .and_then(|settings| stats_hotkey(&settings))
        .unwrap_or_else(|| DEFAULT_HOTKEY.to_vec())
}

/// One switch at a time: a second switch must read the state before it only once the first one's change is in the
/// log, or it would take that change for its own answer.
static SWITCHING: Mutex<()> = Mutex::new(());

/// Presses the statistics hotkey and returns the state NVIDIA logged afterwards: the new one as soon as it shows in
/// the log, or whatever the log says after 2 s.
pub fn toggle_nvidia_stats() -> Result<Option<bool>> {
    let _one_at_a_time = SWITCHING.lock();
    let before = nvidia_stats();
    if !win::input::press_keys(&hotkey()) {
        return Err(Error::Player("Windows didn't take the key presses.".into()));
    }
    // The overlay logs the switch within a few hundred milliseconds, later while it starts or the GPU is busy.
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        std::thread::sleep(Duration::from_millis(100));
        let now = nvidia_stats();
        if now != before || Instant::now() >= deadline {
            return Ok(now);
        }
    }
}

/// The overlay logs `togglePerfOverlay, oldState: <bool>` on every switch and `isPerfOverlayVisible: <bool>` when it
/// starts; the latest of either is the current state.
fn stats_showing(log: &str) -> Option<bool> {
    log.lines().rev().find_map(|line| {
        let flag = |marker: &str| line.split_once(marker).map(|(_, rest)| rest.trim_start().starts_with("true"));
        flag("isPerfOverlayVisible:").or_else(|| flag("togglePerfOverlay, oldState:").map(|old| !old))
    })
}

/// The statistics hotkey from ShareSettings.json, as virtual-key codes; None when the file names none.
fn stats_hotkey(settings: &str) -> Option<Vec<u16>> {
    let v: serde_json::Value = serde_json::from_str(settings).ok()?;
    let keys = v["settings"]["shortcuts"]["PMOCOverlay"]
        .as_array()?
        .iter()
        .map(|k| k.as_u64().map(|k| k as u16))
        .collect::<Option<Vec<_>>>()?;
    (!keys.is_empty()).then_some(keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlays_reach_the_page_as_in_their_fixture() {
        assert_eq!(
            serde_json::to_value(Overlays { nvidia_overlay: true, nvidia_stats: Some(false) }).unwrap(),
            ipc_fixture!("overlays")
        );
    }

    #[test]
    fn reads_the_latest_stats_state() {
        let log = "15:05:49 PerfMonService  registerDisplayNotifications, isPerfOverlayVisible: true \n\
                   15:05:54 PerfMonService  togglePerfOverlay, oldState: true forceOperation: undefined \n\
                   15:05:54 PerfMonService  stopPerfTracking: 1 true \n";
        assert_eq!(stats_showing(log), Some(false));
        assert_eq!(stats_showing("x togglePerfOverlay, oldState: false forceOperation: undefined"), Some(true));
        assert_eq!(stats_showing("nothing here"), None);
    }

    #[test]
    fn reads_the_hotkey() {
        assert_eq!(stats_hotkey(r#"{"settings":{"shortcuts":{"PMOCOverlay":[18,90]}}}"#), Some(vec![0x12, 0x5A]));
        assert_eq!(stats_hotkey(r#"{"settings":{"shortcuts":{"PMOCOverlay":[]}}}"#), None);
        assert_eq!(stats_hotkey(r#"{"settings":{"shortcuts":{"PMOCOverlay":["x"]}}}"#), None);
        assert_eq!(stats_hotkey("{}"), None);
    }
}
