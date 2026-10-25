// The hardware around the player: controllers (pad), the headset, the PC's sound devices, and accessories.rs, which
// ties them together for the Settings screen and moves the sound to wherever the player listens.

pub mod accessories;
pub mod audio;
pub mod headset;
pub mod pad;

use serde::Serialize;

/// A controller's or headset's battery.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[cfg_attr(test, derive(strum::VariantArray))]
#[serde(rename_all = "kebab-case")]
pub enum Charge {
    /// Running on its battery.
    Battery,
    Charging,
    Full,
    /// On a cable but not charging (too warm, too cold, or a fault).
    NotCharging,
}
