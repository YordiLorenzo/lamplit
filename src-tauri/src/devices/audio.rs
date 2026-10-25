// Sound: which output and microphone Windows uses, their volume and mute, and what kind of device each is (the TV,
// the headset, a controller's headphone jack) with the short name Lamplit shows for it.

use super::headset;
use crate::error::Result;
use crate::win::audio;
use serde::Serialize;

pub use audio::{Flow, move_default, set_default};

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Device {
    pub id: String,
    /// What Windows calls it, e.g. "Speakers (PRO X 2 LIGHTSPEED)".
    pub windows_name: String,
    /// What Lamplit shows, e.g. "PRO X 2 headset".
    pub name: String,
    pub kind: Kind,
    pub default: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Sound {
    pub outputs: Vec<Device>,
    pub inputs: Vec<Device>,
    /// Of the default output, 0 to 100.
    pub volume: Option<u32>,
    pub muted: Option<bool>,
    pub mic_muted: Option<bool>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// A screen's HDMI or DisplayPort sound.
    Tv,
    /// The PRO X 2's receiver.
    Headset,
    /// A controller's headphone jack.
    Controller,
    Other,
}

impl Kind {
    /// The sound follows the player to these (see accessories.rs).
    pub fn follows(self) -> bool {
        matches!(self, Kind::Headset | Kind::Controller)
    }
}

/// The kind of a device, from Windows' name for it and whether it is a screen's (`display`), and the short name
/// Lamplit shows for the TV, the headset and the controller's jack; everything else keeps Windows' name.
pub fn classify(windows_name: &str, display: bool) -> (Kind, String) {
    let lower = windows_name.to_lowercase();
    let inner = windows_name.split_once('(').map_or(windows_name, |(_, rest)| rest.trim_end_matches(')')).trim();
    if lower.contains("wireless controller") || lower.contains("dualsense") {
        (Kind::Controller, "Controller headphone jack".into())
    } else if lower.contains(&headset::SOUND_NAME.to_lowercase()) {
        (Kind::Headset, format!("{} headset", inner.replace(" LIGHTSPEED", "").trim()))
    } else if display {
        let screen = windows_name.split_once(" (").map_or(windows_name, |(name, _)| name).trim();
        (Kind::Tv, format!("TV ({screen})"))
    } else {
        (Kind::Other, windows_name.to_string())
    }
}

fn devices(flow: Flow) -> Result<Vec<Device>> {
    Ok(audio::endpoints(flow)?
        .into_iter()
        // Steam's streaming devices are for Remote Play, never a choice on the TV.
        .filter(|e| !e.name.contains("Steam Streaming"))
        .map(|e| {
            let (kind, name) = classify(&e.name, e.display);
            Device { id: e.id, windows_name: e.name, name, kind, default: e.default }
        })
        .collect())
}

pub fn state() -> Result<Sound> {
    Ok(Sound {
        outputs: devices(Flow::Output)?,
        inputs: devices(Flow::Input)?,
        volume: audio::volume().ok().map(|v| (v * 100.0).round() as u32),
        muted: audio::muted(Flow::Output).ok(),
        mic_muted: audio::muted(Flow::Input).ok(),
    })
}

/// Changes the default output's volume by `delta` percentage points.
pub fn nudge_volume(delta: i32) -> Result<u32> {
    let now = (audio::volume()? * 100.0).round() as i32;
    let next = (now + delta).clamp(0, 100) as u32;
    audio::set_volume(next as f32 / 100.0)?;
    Ok(next)
}

/// Mutes or unmutes the default output (`mic` false) or microphone (`mic` true).
pub fn set_mute(mic: bool, muted: bool) -> Result<()> {
    Ok(audio::set_muted(if mic { Flow::Input } else { Flow::Output }, muted)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sound_reaches_the_page_as_in_its_fixture() {
        let device = |id: &str, windows_name: &str, name: &str, kind| Device {
            id: id.into(),
            windows_name: windows_name.into(),
            name: name.into(),
            kind,
            default: true,
        };
        let sound = Sound {
            outputs: vec![device("{0.0.0.00000000}.{tv}", "TV (NVIDIA High Definition Audio)", "TV", Kind::Tv)],
            inputs: vec![device(
                "{0.0.1.00000000}.{headset}",
                "Microphone (PRO X 2 LIGHTSPEED)",
                "PRO X 2 headset",
                Kind::Headset,
            )],
            volume: Some(45),
            muted: Some(false),
            mic_muted: Some(false),
        };
        assert_eq!(serde_json::to_value(sound).unwrap(), ipc_fixture!("sound"));
    }

    #[test]
    fn short_names() {
        assert_eq!(classify("Speakers (PRO X 2 LIGHTSPEED)", false), (Kind::Headset, "PRO X 2 headset".into()));
        assert_eq!(
            classify("Living Room TV (NVIDIA High Definition Audio)", true),
            (Kind::Tv, "TV (Living Room TV)".into())
        );
        assert_eq!(
            classify("Headphones (Wireless Controller)", false),
            (Kind::Controller, "Controller headphone jack".into())
        );
        assert_eq!(classify("Speakers (Realtek USB Audio)", false).0, Kind::Other);
    }

    #[test]
    fn any_screen_is_the_tv() {
        assert_eq!(classify("LG TV (AMD High Definition Audio Device)", true), (Kind::Tv, "TV (LG TV)".into()));
        assert_eq!(classify("DELL U2720Q (Intel(R) Display Audio)", true).0, Kind::Tv);
        // Another headset is the player's own choice, not one the sound follows.
        let other = "Headset (WH-1000XM4 Hands-Free AG Audio)";
        assert_eq!(classify(other, false), (Kind::Other, other.into()));
    }
}
