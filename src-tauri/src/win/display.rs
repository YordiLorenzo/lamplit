// The screen: its mode, and Windows HDR ("Use HDR" in Settings > Display).

use serde::{Deserialize, Serialize};
use windows::Win32::Devices::Display::{
    DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_DEVICE_INFO_TYPE, DISPLAYCONFIG_MODE_INFO,
    DISPLAYCONFIG_MODE_INFO_TYPE_SOURCE, DISPLAYCONFIG_PATH_INFO, DisplayConfigGetDeviceInfo,
    DisplayConfigSetDeviceInfo, GetDisplayConfigBufferSizes, QDC_ONLY_ACTIVE_PATHS, QueryDisplayConfig,
};
use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, LUID, WIN32_ERROR};
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

/// A screen as Windows' display configuration knows it: the graphics adapter, and the output on it. The adapter's
/// id holds until Windows restarts.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Screen {
    adapter: (u32, i32),
    output: u32,
}

/// The screen whose top left corner is at `left`, `top` on the desktop, as `window::monitor` gives it.
pub fn screen_at(left: i32, top: i32) -> Option<Screen> {
    // A screen that comes or goes between the two calls changes how many entries there are: ask again.
    for _ in 0..3 {
        let (mut path_count, mut mode_count) = (0, 0);
        // SAFETY: both counts are places for the answer.
        unsafe { GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &raw mut path_count, &raw mut mode_count) }
            .ok()
            .ok()?;
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
        // SAFETY: each array holds as many entries as its count says, and the call writes no more than that.
        let read = unsafe {
            QueryDisplayConfig(
                QDC_ONLY_ACTIVE_PATHS,
                &raw mut path_count,
                paths.as_mut_ptr(),
                &raw mut mode_count,
                modes.as_mut_ptr(),
                None,
            )
        };
        if read == ERROR_INSUFFICIENT_BUFFER {
            continue;
        }
        read.ok().ok()?;
        paths.truncate(path_count as usize);
        let at = |p: &DISPLAYCONFIG_PATH_INFO| {
            // SAFETY: without QDC_VIRTUAL_MODE_AWARE the union holds the index of the path's source mode.
            let mode = modes.get(unsafe { p.sourceInfo.Anonymous.modeInfoIdx } as usize)?;
            if mode.infoType != DISPLAYCONFIG_MODE_INFO_TYPE_SOURCE {
                return None;
            }
            // SAFETY: the union of a source mode holds its sourceMode.
            let corner = unsafe { mode.Anonymous.sourceMode.position };
            Some((corner.x, corner.y))
        };
        return paths.iter().find(|p| at(p) == Some((left, top))).map(|p| Screen {
            adapter: (p.targetInfo.adapterId.LowPart, p.targetInfo.adapterId.HighPart),
            output: p.targetInfo.id,
        });
    }
    None
}

/// DISPLAYCONFIG_DEVICE_INFO_TYPE values the windows crate doesn't name yet (Windows 11 24H2 added them).
const GET_ADVANCED_COLOR_INFO: i32 = 9;
const SET_ADVANCED_COLOR_STATE: i32 = 10;
const GET_ADVANCED_COLOR_INFO_2: i32 = 15;
const SET_HDR_STATE: i32 = 16;

/// A request about one screen: the header, a field of flags, and `N` more 32-bit fields Lamplit doesn't read. Each
/// request Lamplit sends is this shape: the flags come right after the header in all four.
#[repr(C)]
struct Request<const N: usize> {
    header: DISPLAYCONFIG_DEVICE_INFO_HEADER,
    flags: u32,
    rest: [u32; N],
}

impl<const N: usize> Request<N> {
    fn new(kind: i32, screen: Screen, flags: u32) -> Self {
        let header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
            r#type: DISPLAYCONFIG_DEVICE_INFO_TYPE(kind),
            size: size_of::<Self>() as u32,
            adapterId: LUID { LowPart: screen.adapter.0, HighPart: screen.adapter.1 },
            id: screen.output,
        };
        Request { header, flags, rest: [0; N] }
    }

    /// Windows' answer to the request; false when it has none (an older Windows, or the screen has gone).
    fn ask(&mut self) -> bool {
        // SAFETY: the header starts the request, and its size field is the size of the whole request.
        unsafe { DisplayConfigGetDeviceInfo(&raw mut self.header) == 0 }
    }

    fn send(&self) -> windows::core::Result<()> {
        // SAFETY: as in `ask`; Windows only reads the request.
        WIN32_ERROR(unsafe { DisplayConfigSetDeviceInfo(&raw const self.header) } as u32).ok()
    }
}

struct HdrState {
    supported: bool,
    on: bool,
    /// Windows 11 24H2 or later: HDR has its own switch.
    own_switch: bool,
}

fn hdr_state(screen: Screen) -> Option<HdrState> {
    // Since 24H2 Windows tells HDR apart from wide colour on an SDR screen (Auto color management), which the older
    // request counts as advanced colour too. DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO_2: bit 4 HDR supported, bit 5 on.
    let mut info = Request::<3>::new(GET_ADVANCED_COLOR_INFO_2, screen, 0);
    if info.ask() {
        return Some(HdrState { supported: info.flags & 1 << 4 != 0, on: info.flags & 1 << 5 != 0, own_switch: true });
    }
    // DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO: bit 0 supported, bit 1 on.
    let mut info = Request::<2>::new(GET_ADVANCED_COLOR_INFO, screen, 0);
    if !info.ask() {
        return None;
    }
    Some(HdrState { supported: info.flags & 1 != 0, on: info.flags & 2 != 0, own_switch: false })
}

/// Whether Windows HDR is on for the screen. None when the screen can't show HDR, or has gone.
pub fn hdr(screen: Screen) -> Option<bool> {
    hdr_state(screen).filter(|s| s.supported).map(|s| s.on)
}

/// Switches Windows HDR on or off for the screen, as Settings > Display > Use HDR does. The screen goes dark for a
/// moment while it changes.
pub fn set_hdr(screen: Screen, on: bool) -> windows::core::Result<()> {
    let own_switch = hdr_state(screen).is_some_and(|s| s.own_switch);
    let kind = if own_switch { SET_HDR_STATE } else { SET_ADVANCED_COLOR_STATE };
    // Both requests: bit 0 on.
    Request::<0>::new(kind, screen, u32::from(on)).send()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_are_the_size_windows_expects() {
        // DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO_2, DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO, and the two set requests.
        assert_eq!([size_of::<Request<3>>(), size_of::<Request<2>>(), size_of::<Request<0>>()], [36, 32, 24]);
    }
}
