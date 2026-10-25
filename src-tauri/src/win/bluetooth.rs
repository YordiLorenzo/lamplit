// Bluetooth: dropping a device's link through the PC's Bluetooth radio.

use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows::Win32::Devices::Bluetooth::{
    BLUETOOTH_FIND_RADIO_PARAMS, BluetoothFindFirstRadio, BluetoothFindRadioClose,
};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::IO::DeviceIoControl;
use windows::core::Result;

/// The PC's first Bluetooth radio.
pub fn first_radio() -> Result<OwnedHandle> {
    let params = BLUETOOTH_FIND_RADIO_PARAMS { dwSize: size_of::<BLUETOOTH_FIND_RADIO_PARAMS>() as u32 };
    let mut radio = HANDLE::default();
    // SAFETY: params has its size field set as required, and radio is a valid place for the handle.
    let search = unsafe { BluetoothFindFirstRadio(&raw const params, &raw mut radio) }?;
    // SAFETY: the search handle came from the call above and is closed once; the radio's handle stays open.
    let _ = unsafe { BluetoothFindRadioClose(search) };
    // SAFETY: the radio's handle was just opened for this function, and nothing else owns or closes it.
    Ok(unsafe { OwnedHandle::from_raw_handle(radio.0) })
}

/// Drops the link to the device with this Bluetooth address.
pub fn disconnect(radio: &OwnedHandle, address: u64) -> Result<()> {
    const IOCTL_BTH_DISCONNECT_DEVICE: u32 = 0x0041_000C;
    let mut returned = 0u32;
    // SAFETY: the radio's handle is open for the whole call; the input is the 8-byte address the control code takes,
    // and it gives no output.
    unsafe {
        DeviceIoControl(
            HANDLE(radio.as_raw_handle()),
            IOCTL_BTH_DISCONNECT_DEVICE,
            Some((&raw const address).cast()),
            size_of::<u64>() as u32,
            None,
            0,
            Some(&raw mut returned),
            None,
        )
    }
}
