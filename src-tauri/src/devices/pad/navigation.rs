// A controller's buttons as navigation: a press is one step, a held direction repeats (slowly, then faster), and a
// held home button, or View and Menu held together, brings Lamplit to the front once. Every kind of controller is
// read into the same Input first: the face buttons by where they sit, so Cross and A are both south.

use std::time::{Duration, Instant};

const HOME_HOLD: Duration = Duration::from_millis(600);
/// View and Menu held together, for controllers whose home button Lamplit can't read: an Xbox controller's belongs
/// to Windows. A second, so a quick press of both in a game doesn't bring Lamplit forward.
const CHORD_HOLD: Duration = Duration::from_secs(1);
const REPEAT_DELAY: Duration = Duration::from_millis(380);
const REPEAT_EVERY: Duration = Duration::from_millis(110);
/// After this many repeats, a held direction goes faster.
const SLOW_REPEATS: u32 = 5;
const REPEAT_FAST: Duration = Duration::from_millis(70);
/// How far a stick must lean before it counts as a direction, as a share of its full travel.
const STICK_LEAN: f32 = 70.0 / 128.0;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[cfg_attr(test, derive(strum::VariantArray))]
pub enum Dir {
    Up,
    Down,
    Left,
    Right,
}

impl Dir {
    pub fn action(self) -> &'static str {
        match self {
            Dir::Up => "up",
            Dir::Down => "down",
            Dir::Left => "left",
            Dir::Right => "right",
        }
    }

    /// The direction of a d-pad read as four buttons, up, down, left and right. A diagonal is sideways, as on the
    /// DualSense.
    pub fn of_dpad([up, down, left, right]: [bool; 4]) -> Option<Dir> {
        if left {
            Some(Dir::Left)
        } else if right {
            Some(Dir::Right)
        } else if up {
            Some(Dir::Up)
        } else if down {
            Some(Dir::Down)
        } else {
            None
        }
    }

    /// The direction a stick leans in: `x` and `y` from -1 to 1, `y` positive towards the player.
    pub fn of_stick(x: f32, y: f32) -> Option<Dir> {
        if x.abs().max(y.abs()) < STICK_LEAN {
            None
        } else if x.abs() > y.abs() {
            Some(if x > 0.0 { Dir::Right } else { Dir::Left })
        } else {
            Some(if y > 0.0 { Dir::Down } else { Dir::Up })
        }
    }
}

/// What a controller's buttons say, whatever the controller: the d-pad or else the left stick as one direction, the
/// face buttons by position (south is Cross or A), the shoulders, and the two middle buttons (Menu is Options or
/// Start, View is Create or Back).
#[derive(Default, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Input {
    pub dir: Option<Dir>,
    pub south: bool,
    pub east: bool,
    pub west: bool,
    pub north: bool,
    pub l1: bool,
    pub r1: bool,
    pub menu: bool,
    pub view: bool,
    /// PS on a DualSense; false where Lamplit can't read one.
    pub home: bool,
}

#[derive(Debug, PartialEq)]
pub enum Action {
    /// A step for the page: "up", "ok", "back" and so on.
    Nav(&'static str),
    /// A button let go after Lamplit saw it pressed: "ok-up". The dock's Close game asks for Cross to be held.
    Release(&'static str),
    /// Home, or View and Menu, was held: bring Lamplit to the front.
    Summon,
}

/// Whether a button is down in a report.
type Button = fn(&Input) -> bool;

/// The buttons that are a step for the page when pressed, with that step. Home and View aren't: they summon Lamplit.
const BUTTON_STEPS: [(Button, &str); 7] = [
    (|i| i.south, "ok"),
    (|i| i.east, "back"),
    (|i| i.menu, "menu"),
    (|i| i.north, "triangle"),
    (|i| i.l1, "l1"),
    (|i| i.r1, "r1"),
    (|i| i.west, "square"),
];

/// The buttons whose letting go is a step too, with that step: the dock asks for Cross to be held to close a game.
const RELEASE_STEPS: [(Button, &str); 1] = [(|i| i.south, "ok-up")];

/// One controller's buttons, fed every input report.
#[derive(Default)]
pub struct Navigation {
    last: Input,
    /// The buttons of RELEASE_STEPS whose press was a step, by their place there; one held since reading began wasn't.
    pressed: [bool; RELEASE_STEPS.len()],
    next_repeat: Option<Instant>,
    repeats: u32,
    home: Hold,
    chord: Hold,
}

/// A button (or two together) that does something once held long enough.
#[derive(Default)]
struct Hold {
    since: Option<Instant>,
}

impl Hold {
    fn update(&mut self, down: bool, was: bool, now: Instant) {
        if down && !was {
            self.since = Some(now);
        } else if !down {
            self.since = None;
        }
    }

    /// True once, when it has been held for `long`: that takes the hold, so the next one needs a new press.
    fn held(&mut self, long: Duration, now: Instant) -> bool {
        self.since.take_if(|since| now - *since >= long).is_some()
    }
}

impl Navigation {
    /// Starts from what the controller says when Lamplit first reads it: a button already down then, or a stick
    /// that rests off centre (a wheel's pedal, say), isn't a press.
    pub fn starting_from(input: Input) -> Self {
        Navigation { last: input, ..Navigation::default() }
    }

    /// What a report means given the last one: the buttons just pressed and a new direction.
    pub fn update(&mut self, input: Input, now: Instant) -> Vec<Action> {
        let prev = std::mem::replace(&mut self.last, input);
        let mut actions = Vec::new();
        if input.dir != prev.dir {
            self.repeats = 0;
            self.next_repeat = input.dir.map(|d| {
                actions.push(Action::Nav(d.action()));
                now + REPEAT_DELAY
            });
        }
        let pressed = BUTTON_STEPS.iter().filter(|(down, _)| down(&input) && !down(&prev));
        actions.extend(pressed.map(|&(_, step)| Action::Nav(step)));
        for (&(down, step), pressed) in RELEASE_STEPS.iter().zip(&mut self.pressed) {
            if down(&input) && !down(&prev) {
                *pressed = true;
            } else if !down(&input) && std::mem::take(pressed) {
                actions.push(Action::Release(step));
            }
        }
        self.home.update(input.home, prev.home, now);
        self.chord.update(input.view && input.menu, prev.view && prev.menu, now);
        actions
    }

    /// What holding brings by `now`, between reports: a repeated direction, a summon.
    pub fn tick(&mut self, now: Instant) -> Vec<Action> {
        let mut actions = Vec::new();
        if let (Some(dir), Some(at)) = (self.last.dir, self.next_repeat)
            && now >= at
        {
            actions.push(Action::Nav(dir.action()));
            self.repeats += 1;
            self.next_repeat = Some(now + if self.repeats > SLOW_REPEATS { REPEAT_FAST } else { REPEAT_EVERY });
        }
        // Both are asked: with `||` a chord held along with home would summon again on the next tick.
        let (home, chord) = (self.home.held(HOME_HOLD, now), self.chord.held(CHORD_HOLD, now));
        if home || chord {
            actions.push(Action::Summon);
        }
        actions
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn a_held_direction_repeats_then_speeds_up() {
        let (mut nav, t) = (Navigation::default(), Instant::now());
        let right = Input { dir: Some(Dir::Right), ..Input::default() };
        assert_eq!(nav.update(right, t), vec![Action::Nav("right")]);
        // The same report again is no new step.
        assert!(nav.update(right, t + ms(100)).is_empty());
        assert!(nav.tick(t + ms(379)).is_empty());
        assert_eq!(nav.tick(t + ms(380)), vec![Action::Nav("right")]);
        assert!(nav.tick(t + ms(489)).is_empty());
        let mut at = t + ms(490);
        for _ in 0..4 {
            assert_eq!(nav.tick(at), vec![Action::Nav("right")]);
            at += REPEAT_EVERY;
        }
        // The sixth repeat comes after the slow step; from then on the fast one.
        assert_eq!(nav.tick(at), vec![Action::Nav("right")]);
        assert!(nav.tick(at + ms(69)).is_empty());
        assert_eq!(nav.tick(at + ms(70)), vec![Action::Nav("right")]);
    }

    #[test]
    fn a_new_direction_starts_over() {
        let (mut nav, t) = (Navigation::default(), Instant::now());
        nav.update(Input { dir: Some(Dir::Right), ..Input::default() }, t);
        assert_eq!(nav.tick(t + ms(380)), vec![Action::Nav("right")]);
        assert_eq!(
            nav.update(Input { dir: Some(Dir::Down), ..Input::default() }, t + ms(400)),
            vec![Action::Nav("down")]
        );
        assert!(nav.tick(t + ms(500)).is_empty());
        assert_eq!(nav.tick(t + ms(780)), vec![Action::Nav("down")]);
        // Let go: no more repeats.
        assert!(nav.update(Input::default(), t + ms(800)).is_empty());
        assert!(nav.tick(t + ms(2000)).is_empty());
    }

    #[test]
    fn buttons_step_once_per_press() {
        let (mut nav, t) = (Navigation::default(), Instant::now());
        let south = Input { south: true, r1: true, ..Input::default() };
        assert_eq!(nav.update(south, t), vec![Action::Nav("ok"), Action::Nav("r1")]);
        assert!(nav.update(south, t + ms(4)).is_empty());
        assert!(nav.tick(t + ms(1000)).is_empty());
    }

    #[test]
    fn face_buttons_step_by_where_they_sit() {
        let (mut nav, t) = (Navigation::default(), Instant::now());
        let all = Input { south: true, east: true, west: true, north: true, ..Input::default() };
        let steps = [Action::Nav("ok"), Action::Nav("back"), Action::Nav("triangle"), Action::Nav("square")];
        assert_eq!(nav.update(all, t), steps);
        // View alone is no step; letting go of Cross is one, for the dock.
        assert_eq!(nav.update(Input { view: true, ..Input::default() }, t + ms(10)), vec![Action::Release("ok-up")]);
    }

    #[test]
    fn every_step_is_one_the_page_knows() {
        let dirs = <Dir as strum::VariantArray>::VARIANTS.iter().map(|d| d.action());
        let steps: Vec<&str> = dirs.chain(BUTTON_STEPS.map(|(_, step)| step)).collect();
        assert_eq!(serde_json::to_value(steps).unwrap(), ipc_fixture!("values")["pad"]);
        let releases = RELEASE_STEPS.map(|(_, step)| step);
        assert_eq!(serde_json::to_value(releases).unwrap(), ipc_fixture!("values")["dock_release"]);
    }

    #[test]
    fn letting_go_of_cross_is_a_step_once_it_was_pressed() {
        let (mut nav, t) = (Navigation::default(), Instant::now());
        let cross = Input { south: true, ..Input::default() };
        assert_eq!(nav.update(cross, t), vec![Action::Nav("ok")]);
        assert!(nav.update(cross, t + ms(300)).is_empty());
        assert_eq!(nav.update(Input::default(), t + ms(900)), vec![Action::Release("ok-up")]);
        assert!(nav.update(Input::default(), t + ms(950)).is_empty());
        // Held since reading began: no press, so no letting go either.
        let mut nav = Navigation::starting_from(cross);
        assert!(nav.update(Input::default(), t).is_empty());
    }

    #[test]
    fn holding_home_summons_once() {
        let (mut nav, t) = (Navigation::default(), Instant::now());
        let home = Input { home: true, ..Input::default() };
        assert!(nav.update(home, t).is_empty());
        assert!(nav.tick(t + ms(599)).is_empty());
        assert_eq!(nav.tick(t + ms(600)), vec![Action::Summon]);
        assert!(nav.tick(t + ms(1500)).is_empty());
        // A short press summons nothing.
        nav.update(Input::default(), t + ms(1600));
        nav.update(home, t + ms(1700));
        nav.update(Input::default(), t + ms(1800));
        assert!(nav.tick(t + ms(3000)).is_empty());
    }

    #[test]
    fn holding_view_and_menu_summons_once() {
        let (mut nav, t) = (Navigation::default(), Instant::now());
        let both = Input { view: true, menu: true, ..Input::default() };
        // Menu is still a step on its own: pressed first, it opens the game's details.
        assert_eq!(nav.update(Input { menu: true, ..Input::default() }, t), vec![Action::Nav("menu")]);
        assert!(nav.update(both, t + ms(50)).is_empty());
        assert!(nav.tick(t + ms(1049)).is_empty());
        assert_eq!(nav.tick(t + ms(1050)), vec![Action::Summon]);
        assert!(nav.tick(t + ms(3000)).is_empty());
        // Letting go of one of them starts over.
        nav.update(Input { view: true, ..Input::default() }, t + ms(3100));
        nav.update(both, t + ms(3200));
        assert!(nav.tick(t + ms(4100)).is_empty());
        assert_eq!(nav.tick(t + ms(4200)), vec![Action::Summon]);
        // View alone, held, summons nothing.
        let mut nav = Navigation::default();
        nav.update(Input { view: true, ..Input::default() }, t);
        assert!(nav.tick(t + ms(5000)).is_empty());
    }

    #[test]
    fn what_is_held_when_reading_starts_is_no_press() {
        let (t, held) = (Instant::now(), Input { south: true, view: true, menu: true, ..Input::default() });
        let mut nav = Navigation::starting_from(held);
        assert!(nav.update(held, t).is_empty());
        assert!(nav.tick(t + ms(5000)).is_empty());
        assert!(nav.update(Input::default(), t + ms(5100)).is_empty());
        // Pressed again, they are.
        assert_eq!(nav.update(held, t + ms(5200)), vec![Action::Nav("ok"), Action::Nav("menu")]);
        // A stick resting off centre isn't a direction until it moves.
        let left = Input { dir: Some(Dir::Left), ..Input::default() };
        let mut nav = Navigation::starting_from(left);
        assert!(nav.update(left, t).is_empty());
        assert!(nav.tick(t + ms(2000)).is_empty());
    }

    #[test]
    fn a_stick_leans_past_its_dead_zone() {
        assert_eq!(Dir::of_stick(0.5, 0.0), None);
        assert_eq!(Dir::of_stick(0.6, 0.2), Some(Dir::Right));
        assert_eq!(Dir::of_stick(-0.2, -0.9), Some(Dir::Up));
        assert_eq!(Dir::of_stick(0.0, 1.0), Some(Dir::Down));
        assert_eq!(Dir::of_stick(-1.0, 0.0), Some(Dir::Left));
    }
}
