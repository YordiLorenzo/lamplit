// The COM interface below keeps Windows' method names, and the `interface` macro's code transmutes references.
#![allow(non_snake_case, clippy::transmute_ptr_to_ptr)]

// Core Audio: the sound devices, the default one's volume and mute, and which device is the default. Windows has no
// public call for that last one, so it goes through IPolicyConfig, the undocumented interface Windows' own sound
// settings use (as SoundSwitch, EarTrumpet and Sunshine do), one call per role (games, media, calls).

use super::com;
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{
    DEVICE_STATE_ACTIVE, DigitalAudioDisplayDevice, EDataFlow, ERole, IMMDevice, IMMDeviceEnumerator,
    MMDeviceEnumerator, PKEY_AudioEndpoint_FormFactor, eCapture, eCommunications, eConsole, eMultimedia, eRender,
};
use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance, CoTaskMemFree, STGM_READ};
use windows::core::{GUID, HRESULT, IUnknown, IUnknown_Vtbl, PCWSTR, Result, interface};

#[derive(Clone, Copy)]
pub enum Flow {
    Output,
    /// Microphones.
    Input,
}

impl Flow {
    fn data_flow(self) -> EDataFlow {
        match self {
            Flow::Output => eRender,
            Flow::Input => eCapture,
        }
    }
}

/// An active sound device.
pub struct Endpoint {
    pub id: String,
    /// What Windows calls it, e.g. "Speakers (PRO X 2 LIGHTSPEED)".
    pub name: String,
    /// It is the default device (for games and media).
    pub default: bool,
    /// It plays through a screen's HDMI or DisplayPort link: a TV or a monitor.
    pub display: bool,
}

/// Windows' own interface behind "Choose your output device" (Windows 7 and later layout). Method names and order
/// are the COM vtable's.
#[interface("f8679f50-850a-41cf-9c72-430f290290c8")]
unsafe trait IPolicyConfig: IUnknown {
    fn GetMixFormat(&self, device: PCWSTR, format: *mut *mut core::ffi::c_void) -> HRESULT;
    fn GetDeviceFormat(&self, device: PCWSTR, default: i32, format: *mut *mut core::ffi::c_void) -> HRESULT;
    fn ResetDeviceFormat(&self, device: PCWSTR) -> HRESULT;
    fn SetDeviceFormat(&self, device: PCWSTR, endpoint: *mut core::ffi::c_void, mix: *mut core::ffi::c_void)
    -> HRESULT;
    fn GetProcessingPeriod(
        &self,
        device: PCWSTR,
        default: i32,
        default_period: *mut i64,
        min_period: *mut i64,
    ) -> HRESULT;
    fn SetProcessingPeriod(&self, device: PCWSTR, period: *mut i64) -> HRESULT;
    fn GetShareMode(&self, device: PCWSTR, mode: *mut core::ffi::c_void) -> HRESULT;
    fn SetShareMode(&self, device: PCWSTR, mode: *mut core::ffi::c_void) -> HRESULT;
    fn GetPropertyValue(&self, device: PCWSTR, key: *const core::ffi::c_void, value: *mut core::ffi::c_void)
    -> HRESULT;
    fn SetPropertyValue(&self, device: PCWSTR, key: *const core::ffi::c_void, value: *mut core::ffi::c_void)
    -> HRESULT;
    fn SetDefaultEndpoint(&self, device: PCWSTR, role: ERole) -> HRESULT;
    fn SetEndpointVisibility(&self, device: PCWSTR, visible: i32) -> HRESULT;
}

const CLSID_POLICY_CONFIG: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

fn enumerator() -> Result<IMMDeviceEnumerator> {
    com::initialize();
    // SAFETY: creates a COM object on a thread that has COM; no outer object.
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
}

/// The device's id, from the string Windows allocates for it.
fn id_of(device: &IMMDevice) -> Result<String> {
    // SAFETY: GetId hands over a NUL-terminated string allocated with CoTaskMemAlloc; it is copied, then freed once.
    unsafe {
        let id = device.GetId()?;
        let text = id.to_string().unwrap_or_default();
        CoTaskMemFree(Some(id.0.cast()));
        Ok(text)
    }
}

/// The active devices in one direction.
pub fn endpoints(flow: Flow) -> Result<Vec<Endpoint>> {
    let en = enumerator()?;
    // SAFETY: COM calls on the enumerator and the devices it returns, which live until this function returns. The
    // property keys are statics.
    unsafe {
        let default_id = en.GetDefaultAudioEndpoint(flow.data_flow(), eConsole).and_then(|d| id_of(&d)).ok();
        let all = en.EnumAudioEndpoints(flow.data_flow(), DEVICE_STATE_ACTIVE)?;
        let mut out = Vec::new();
        for i in 0..all.GetCount()? {
            let device = all.Item(i)?;
            let id = id_of(&device)?;
            let properties = device.OpenPropertyStore(STGM_READ)?;
            let name = properties.GetValue(&PKEY_Device_FriendlyName)?.to_string();
            let form = properties.GetValue(&PKEY_AudioEndpoint_FormFactor).ok().and_then(|v| u32::try_from(&v).ok());
            let display = form == Some(DigitalAudioDisplayDevice.0 as u32);
            out.push(Endpoint { default: default_id.as_deref() == Some(id.as_str()), id, name, display });
        }
        Ok(out)
    }
}

fn volume_control(flow: Flow) -> Result<IAudioEndpointVolume> {
    // SAFETY: COM calls on the enumerator and the default device, which live until the control is made.
    unsafe { enumerator()?.GetDefaultAudioEndpoint(flow.data_flow(), eConsole)?.Activate(CLSCTX_ALL, None) }
}

/// The default output's volume, 0.0 to 1.0.
pub fn volume() -> Result<f32> {
    // SAFETY: a COM call on the volume control just made.
    unsafe { volume_control(Flow::Output)?.GetMasterVolumeLevelScalar() }
}

pub fn set_volume(level: f32) -> Result<()> {
    // SAFETY: a COM call on the volume control just made; the null event context means none.
    unsafe { volume_control(Flow::Output)?.SetMasterVolumeLevelScalar(level, std::ptr::null()) }
}

/// Whether the default device in this direction is muted.
pub fn muted(flow: Flow) -> Result<bool> {
    // SAFETY: a COM call on the volume control just made.
    Ok(unsafe { volume_control(flow)?.GetMute() }?.as_bool())
}

pub fn set_muted(flow: Flow, muted: bool) -> Result<()> {
    // SAFETY: a COM call on the volume control just made; the null event context means none.
    unsafe { volume_control(flow)?.SetMute(muted, std::ptr::null()) }
}

/// Makes the device `id` the default for games, media and calls, as the player's choice in Settings does.
pub fn set_default(id: &str) -> Result<()> {
    set_roles(id, &[eConsole, eMultimedia, eCommunications])
}

/// Makes the device `id` (in direction `flow`) the default for games and media, and for calls only when calls went
/// to the same device as games: a player who keeps calls on a device of their own (a USB headset for chat, say) keeps
/// it there while Lamplit moves the sound to the headset and back.
pub fn move_default(flow: Flow, id: &str) -> Result<()> {
    let en = enumerator()?;
    // SAFETY: COM calls on the enumerator and the devices it returns, which live until this function returns.
    let default = |role| unsafe { en.GetDefaultAudioEndpoint(flow.data_flow(), role) }.and_then(|d| id_of(&d)).ok();
    if default(eCommunications) == default(eConsole) {
        set_roles(id, &[eConsole, eMultimedia, eCommunications])
    } else {
        set_roles(id, &[eConsole, eMultimedia])
    }
}

fn set_roles(id: &str, roles: &[ERole]) -> Result<()> {
    com::initialize();
    // SAFETY: creates a COM object on a thread that has COM; no outer object.
    let policy: IPolicyConfig = unsafe { CoCreateInstance(&CLSID_POLICY_CONFIG, None, CLSCTX_ALL)? };
    let wide: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
    for &role in roles {
        // SAFETY: a COM call on the object just made; the id is NUL-terminated and lives until the call returns.
        unsafe { policy.SetDefaultEndpoint(PCWSTR(wide.as_ptr()), role).ok()? };
    }
    Ok(())
}
