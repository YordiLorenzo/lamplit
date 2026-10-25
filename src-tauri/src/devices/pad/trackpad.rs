// The DualSense touchpad as a mouse, for store apps and Windows dialogs on the TV (gestures.rs has the gestures).
// Windows gets ordinary mouse input (SendInput), as Steam's and DS4Windows' trackpad modes give it; a virtual HID
// mouse would need a kernel driver. Off unless the player switches it on in Settings, and never over a full-screen
// game: a game sees the mouse and switches its button prompts to keyboard and mouse.

use super::gestures::{Act, Button, Gestures, Touch};
use crate::launch::window;
use crate::prefs;
use crate::win;
use tauri::AppHandle;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MOUSE_EVENT_FLAGS, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL,
};

/// One controller's touchpad as the mouse.
#[derive(Default)]
pub struct Trackpad(Gestures);

impl Trackpad {
    /// Moves the mouse for one touchpad report.
    pub fn update(&mut self, touch: Touch, app: &AppHandle) {
        let on = prefs::get(app).touchpad_mouse;
        for act in self.0.update(touch, on, game_in_front) {
            send(&act);
        }
    }
}

/// A controller that goes away mid-drag (cable pulled, battery flat) would leave Windows holding the button down
/// until the next real click.
impl Drop for Trackpad {
    fn drop(&mut self) {
        if let Some(act) = self.0.let_go() {
            send(&act);
        }
    }
}

/// A full-screen app other than Lamplit is in front: a game, or a video. Windows reports Lamplit's own full-screen
/// window too, so this is false while Lamplit is in front.
fn game_in_front() -> bool {
    !window::lamplit_in_front() && win::window::full_screen_app_in_front()
}

fn send(act: &Act) {
    let (flags, dx, dy, data): (MOUSE_EVENT_FLAGS, i32, i32, i32) = match *act {
        Act::Move(dx, dy) => (MOUSEEVENTF_MOVE, dx, dy, 0),
        Act::Wheel(delta) => (MOUSEEVENTF_WHEEL, 0, 0, delta),
        Act::Down(Button::Left) => (MOUSEEVENTF_LEFTDOWN, 0, 0, 0),
        Act::Up(Button::Left) => (MOUSEEVENTF_LEFTUP, 0, 0, 0),
        Act::Down(Button::Right) => (MOUSEEVENTF_RIGHTDOWN, 0, 0, 0),
        Act::Up(Button::Right) => (MOUSEEVENTF_RIGHTUP, 0, 0, 0),
    };
    win::input::mouse(flags, dx, dy, data);
}
