// The DualSense touchpad's gestures, as mouse actions: one finger moves the pointer, pressing the pad clicks (left
// half: left button, right half: right button), two fingers scroll. trackpad.rs hands the actions to Windows.

/// The touchpad's state in one report: up to two touch points (x 0 to 1919, y 0 to 1079) and whether it is pressed.
#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct Touch {
    pub points: [Option<(u16, u16)>; 2],
    pub pressed: bool,
}

/// Pointer pixels per touchpad unit at slow speed; faster swipes go further (the pad is 1920 units wide).
const SPEED: f32 = 1.2;
/// Touchpad units of two-finger travel per wheel notch.
const NOTCH: f32 = 40.0;
/// While the pad is pressed, finger movement smaller than this is the press itself, not a move.
const PRESS_JITTER: i32 = 8;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Button {
    Left,
    Right,
}

/// What a report turns into.
#[derive(PartialEq, Debug)]
pub enum Act {
    Move(i32, i32),
    /// Wheel movement, 120 per notch, positive away from the player.
    Wheel(i32),
    Down(Button),
    Up(Button),
}

/// One controller's touchpad, fed every input report.
#[derive(Default)]
pub struct Gestures {
    last: Touch,
    /// Decided when a touch begins: the mouse may act (no full-screen game in front).
    allowed: bool,
    held: Option<Button>,
    carry: Carry,
}

/// Fractions of a pixel and of a wheel notch carried to the next report.
#[derive(Default)]
struct Carry {
    x: f32,
    y: f32,
    wheel: f32,
}

impl Gestures {
    /// What this report means given the last one. With the setting off (`on` false) it only lets go of a held
    /// button. `game_in_front` is asked when a touch begins: over a full-screen game the mouse does nothing.
    pub fn update(&mut self, touch: Touch, on: bool, game_in_front: impl FnOnce() -> bool) -> Vec<Act> {
        if !on {
            self.last = touch;
            return self.let_go().into_iter().collect();
        }
        if self.last == Touch::default() && touch != Touch::default() {
            self.allowed = !game_in_front();
        }
        self.step(touch)
    }

    /// Lets go of the button the pad holds down, if any.
    pub fn let_go(&mut self) -> Option<Act> {
        self.held.take().map(Act::Up)
    }

    fn step(&mut self, touch: Touch) -> Vec<Act> {
        let mut acts = Vec::new();
        let last = std::mem::replace(&mut self.last, touch);
        if !self.allowed {
            return self.let_go().into_iter().collect();
        }
        let moved = |i: usize| match (last.points[i], touch.points[i]) {
            (Some(a), Some(b)) => Some((i32::from(b.0) - i32::from(a.0), i32::from(b.1) - i32::from(a.1))),
            _ => None,
        };
        match (moved(0), moved(1)) {
            (Some(a), Some(b)) => {
                // Two fingers: scroll the way a laptop touchpad does (fingers move up, the page follows them up).
                self.carry.wheel += (a.1 + b.1) as f32 / 2.0;
                while self.carry.wheel.abs() >= NOTCH {
                    let up = self.carry.wheel > 0.0;
                    acts.push(Act::Wheel(if up { 120 } else { -120 }));
                    self.carry.wheel -= if up { NOTCH } else { -NOTCH };
                }
            }
            (Some((dx, dy)), None) | (None, Some((dx, dy))) if touch.points.iter().flatten().count() == 1 => {
                let pressing = touch.pressed || self.held.is_some();
                let jitter = pressing && dx.abs().max(dy.abs()) < PRESS_JITTER;
                if !jitter {
                    let gain = SPEED * (1.0 + (dx.abs().max(dy.abs()) as f32 / 15.0).min(2.0));
                    self.carry.x += dx as f32 * gain;
                    self.carry.y += dy as f32 * gain;
                    let (px, py) = (self.carry.x.trunc(), self.carry.y.trunc());
                    self.carry.x -= px;
                    self.carry.y -= py;
                    if px != 0.0 || py != 0.0 {
                        acts.push(Act::Move(px as i32, py as i32));
                    }
                }
            }
            _ => self.carry = Carry::default(),
        }
        if touch.pressed && self.held.is_none() {
            let right = touch.points.iter().flatten().next().is_some_and(|p| p.0 >= 960);
            let button = if right { Button::Right } else { Button::Left };
            self.held = Some(button);
            acts.push(Act::Down(button));
        } else if !touch.pressed
            && let Some(button) = self.held.take()
        {
            acts.push(Act::Up(button));
        }
        acts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pad() -> Gestures {
        Gestures { allowed: true, ..Gestures::default() }
    }

    fn one(x: u16, y: u16, pressed: bool) -> Touch {
        Touch { points: [Some((x, y)), None], pressed }
    }

    #[test]
    fn one_finger_moves_the_pointer() {
        let mut t = pad();
        assert!(t.step(one(500, 500, false)).is_empty());
        let acts = t.step(one(510, 495, false));
        assert!(matches!(acts[..], [Act::Move(dx, dy)] if dx > 10 && dy < -5), "{acts:?}");
        // Lifting the finger and putting it down elsewhere doesn't jump the pointer.
        assert!(t.step(Touch::default()).is_empty());
        assert!(t.step(one(1500, 900, false)).is_empty());
    }

    #[test]
    fn a_press_clicks_without_drifting() {
        let mut t = pad();
        t.step(one(400, 500, false));
        assert_eq!(t.step(one(402, 503, true)), vec![Act::Down(Button::Left)]);
        assert!(t.step(one(404, 505, true)).is_empty());
        assert_eq!(t.step(one(404, 505, false)), vec![Act::Up(Button::Left)]);
        t.step(Touch::default());
        t.step(one(1500, 500, false));
        assert_eq!(t.step(one(1500, 500, true)), vec![Act::Down(Button::Right)]);
    }

    #[test]
    fn a_held_button_can_be_let_go() {
        let mut t = pad();
        t.step(one(400, 500, false));
        t.step(one(400, 500, true));
        assert_eq!(t.let_go(), Some(Act::Up(Button::Left)));
        assert_eq!(t.let_go(), None);
    }

    #[test]
    fn two_fingers_scroll() {
        let mut t = pad();
        let two = |y: u16| Touch { points: [Some((600, y)), Some((1200, y))], pressed: false };
        t.step(two(600));
        assert_eq!(t.step(two(500)), vec![Act::Wheel(-120), Act::Wheel(-120)]);
        assert_eq!(t.step(two(560)), vec![Act::Wheel(120)]);
    }

    #[test]
    fn over_a_game_it_does_nothing_but_let_go() {
        let mut t = pad();
        t.step(one(400, 500, false));
        assert_eq!(t.step(one(400, 500, true)), vec![Act::Down(Button::Left)]);
        t.allowed = false;
        assert_eq!(t.step(one(450, 500, true)), vec![Act::Up(Button::Left)]);
        assert!(t.step(one(500, 500, false)).is_empty());
    }

    #[test]
    fn asks_about_a_game_when_a_touch_begins() {
        let mut t = Gestures::default();
        assert!(t.update(one(400, 500, false), true, || true).is_empty());
        // The same touch goes on: the answer holds, and nobody asks again.
        assert!(t.update(one(450, 500, true), true, || unreachable!()).is_empty());
        t.update(Touch::default(), true, || unreachable!());
        t.update(one(400, 500, false), true, || false);
        assert_eq!(t.update(one(400, 500, true), true, || unreachable!()), vec![Act::Down(Button::Left)]);
        // Switched off with the button held: it is let go.
        assert_eq!(t.update(one(400, 500, true), false, || unreachable!()), vec![Act::Up(Button::Left)]);
    }
}
