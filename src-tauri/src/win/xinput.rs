// XInput (xinput1_4.dll): Xbox controllers, and the many others that work like one. Read only: Lamplit never calls
// XInputSetState (rumble) or XInputEnable, and XInput has no way to take a controller from another program.

use std::sync::OnceLock;
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::LibraryLoader::{GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW};
use windows::Win32::UI::Input::XboxController::{
    BATTERY_DEVTYPE_GAMEPAD, XINPUT_BATTERY_INFORMATION, XINPUT_CAPABILITIES, XINPUT_FLAG, XINPUT_GAMEPAD,
    XINPUT_STATE, XInputGetBatteryInformation, XInputGetCapabilities, XInputGetState,
};
use windows::core::{PCSTR, w};

/// XInput's four players.
pub const SLOTS: u32 = 4;

/// The buttons and sticks of the controller in `slot`, or None when there is none.
pub fn state(slot: u32) -> Option<XINPUT_GAMEPAD> {
    let mut state = XINPUT_STATE::default();
    // SAFETY: state is a valid XINPUT_STATE for the call to fill in.
    let result = unsafe { XInputGetState(slot, &raw mut state) };
    (result == ERROR_SUCCESS.0).then_some(state.Gamepad)
}

pub fn capabilities(slot: u32) -> Option<XINPUT_CAPABILITIES> {
    let mut caps = XINPUT_CAPABILITIES::default();
    // SAFETY: caps is a valid XINPUT_CAPABILITIES for the call to fill in; no flags asks about any kind of device.
    let result = unsafe { XInputGetCapabilities(slot, XINPUT_FLAG(0), &raw mut caps) };
    (result == ERROR_SUCCESS.0).then_some(caps)
}

pub fn battery(slot: u32) -> Option<XINPUT_BATTERY_INFORMATION> {
    let mut info = XINPUT_BATTERY_INFORMATION::default();
    // SAFETY: info is a valid XINPUT_BATTERY_INFORMATION for the call to fill in.
    let result = unsafe { XInputGetBatteryInformation(slot, BATTERY_DEVTYPE_GAMEPAD, &raw mut info) };
    (result == ERROR_SUCCESS.0).then_some(info)
}

/// XINPUT_CAPABILITIES followed by the controller's USB ids, as XInputGetCapabilitiesEx fills it in.
#[repr(C)]
#[derive(Default)]
struct CapabilitiesEx {
    capabilities: XINPUT_CAPABILITIES,
    vendor: u16,
    product: u16,
    version: u16,
    unknown1: u16,
    unknown2: u32,
}

type GetCapabilitiesEx = unsafe extern "system" fn(u32, u32, u32, *mut CapabilitiesEx) -> u32;

/// The USB vendor and product id of the controller in `slot`, which is how Lamplit tells Steam Input's virtual
/// controllers apart. XInput documents no way to ask; XInputGetCapabilitiesEx, exported by ordinal 108 only, answers.
/// SDL reads it the same way. None when this Windows doesn't have it, or there is no controller in `slot`.
pub fn ids(slot: u32) -> Option<(u16, u16)> {
    static GET: OnceLock<Option<GetCapabilitiesEx>> = OnceLock::new();
    let get = (*GET.get_or_init(|| {
        // SAFETY: the name is a valid wide string; only System32 is searched, so no other xinput1_4.dll is loaded.
        // The library stays loaded for as long as Lamplit runs (it is already, for XInputGetState).
        let dll = unsafe { LoadLibraryExW(w!("xinput1_4.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32) }.ok()?;
        // SAFETY: an ordinal in place of a name is how GetProcAddress takes one (MAKEINTRESOURCEA).
        let address = unsafe { GetProcAddress(dll, PCSTR(std::ptr::without_provenance(108))) }?;
        // SAFETY: ordinal 108 of xinput1_4.dll is XInputGetCapabilitiesEx, which has this signature.
        Some(unsafe { std::mem::transmute::<unsafe extern "system" fn() -> isize, GetCapabilitiesEx>(address) })
    }))?;
    let mut caps = CapabilitiesEx::default();
    // SAFETY: caps is a valid CapabilitiesEx for the call to fill in; the first argument must be 1.
    let result = unsafe { get(1, slot, 0, &raw mut caps) };
    (result == ERROR_SUCCESS.0).then_some((caps.vendor, caps.product))
}
