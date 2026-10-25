// The screen.

use windows::Win32::Graphics::Gdi::{DEVMODEW, ENUM_CURRENT_SETTINGS, EnumDisplaySettingsW};
use windows::core::PCWSTR;

pub struct Mode {
    pub width: u32,
    pub height: u32,
    pub hz: u32,
}

/// The main screen's mode now.
pub fn current_mode() -> Option<Mode> {
    let mut mode = DEVMODEW { dmSize: size_of::<DEVMODEW>() as u16, ..Default::default() };
    // SAFETY: a null device name means the main screen, and `mode` is a DEVMODEW whose size field is set as required.
    let ok = unsafe { EnumDisplaySettingsW(PCWSTR::null(), ENUM_CURRENT_SETTINGS, &raw mut mode) }.as_bool();
    ok.then_some(Mode { width: mode.dmPelsWidth, height: mode.dmPelsHeight, hz: mode.dmDisplayFrequency })
}
