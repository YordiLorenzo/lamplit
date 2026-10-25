// Synthetic mouse and keyboard input (SendInput): Windows and the apps take it as coming from a real mouse or keyboard.

use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, MOUSE_EVENT_FLAGS,
    MOUSEINPUT, SendInput, VIRTUAL_KEY,
};

/// One mouse event: `flags` say what (a move by `dx`, `dy`, a wheel turn of `data`, a button going down or up).
pub fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) {
    let mi = MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 };
    send(&[INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi } }]);
}

/// Presses `keys` (virtual-key codes) in order and lets go of them in reverse, like a shortcut. False when Windows
/// didn't take them all.
pub fn press_keys(keys: &[u16]) -> bool {
    let key = |vk: u16, flags: KEYBD_EVENT_FLAGS| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    };
    let inputs: Vec<INPUT> = keys
        .iter()
        .map(|&vk| key(vk, KEYBD_EVENT_FLAGS(0)))
        .chain(keys.iter().rev().map(|&vk| key(vk, KEYEVENTF_KEYUP)))
        .collect();
    send(&inputs) == inputs.len()
}

/// How many of the inputs Windows took.
fn send(inputs: &[INPUT]) -> usize {
    // SAFETY: the inputs are complete INPUT values of the size the call is told.
    unsafe { SendInput(inputs, size_of::<INPUT>() as i32) as usize }
}
