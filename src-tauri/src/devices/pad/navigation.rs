// A controller's buttons as navigation: a press is one step, a held direction repeats (slowly, then faster), and a
// held PS button brings Lamplit to the front once.

use super::dualsense::Input;
use std::time::{Duration, Instant};

const PS_HOLD: Duration = Duration::from_millis(600);
const REPEAT_DELAY: Duration = Duration::from_millis(380);
const REPEAT_EVERY: Duration = Duration::from_millis(110);
/// After this many repeats, a held direction goes faster.
const SLOW_REPEATS: u32 = 5;
const REPEAT_FAST: Duration = Duration::from_millis(70);

#[derive(Debug, PartialEq)]
pub enum Action {
    /// A step for the page: "up", "ok", "back" and so on.
    Nav(&'static str),
    /// PS was held: bring Lamplit to the front.
    Summon,
}

/// Whether a button is down in a report.
type Button = fn(&Input) -> bool;

/// The buttons that are a step for the page when pressed, with that step. PS isn't one: holding it summons Lamplit.
const BUTTON_STEPS: [(Button, &str); 6] = [
    (|i| i.cross, "ok"),
    (|i| i.circle, "back"),
    (|i| i.options, "menu"),
    (|i| i.triangle, "triangle"),
    (|i| i.l1, "l1"),
    (|i| i.r1, "r1"),
];

/// One controller's buttons, fed every input report.
#[derive(Default)]
pub struct Navigation {
    last: Input,
    next_repeat: Option<Instant>,
    repeats: u32,
    ps_down: Option<Instant>,
    ps_fired: bool,
}

impl Navigation {
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
        if input.ps && !prev.ps {
            self.ps_down = Some(now);
            self.ps_fired = false;
        } else if !input.ps {
            self.ps_down = None;
        }
        actions
    }

    /// What holding brings by `now`, between reports: a repeated direction, the PS hold.
    pub fn tick(&mut self, now: Instant) -> Vec<Action> {
        let mut actions = Vec::new();
        if let (Some(dir), Some(at)) = (self.last.dir, self.next_repeat)
            && now >= at
        {
            actions.push(Action::Nav(dir.action()));
            self.repeats += 1;
            self.next_repeat = Some(now + if self.repeats > SLOW_REPEATS { REPEAT_FAST } else { REPEAT_EVERY });
        }
        if let Some(down) = self.ps_down
            && !self.ps_fired
            && now - down >= PS_HOLD
        {
            self.ps_fired = true;
            actions.push(Action::Summon);
        }
        actions
    }
}

#[cfg(test)]
mod tests {
    use super::super::dualsense::Dir;
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
        let cross = Input { cross: true, r1: true, ..Input::default() };
        assert_eq!(nav.update(cross, t), vec![Action::Nav("ok"), Action::Nav("r1")]);
        assert!(nav.update(cross, t + ms(4)).is_empty());
        assert!(nav.tick(t + ms(1000)).is_empty());
    }

    #[test]
    fn every_step_is_one_the_page_knows() {
        let dirs = <Dir as strum::VariantArray>::VARIANTS.iter().map(|d| d.action());
        let steps: Vec<&str> = dirs.chain(BUTTON_STEPS.map(|(_, step)| step)).collect();
        assert_eq!(serde_json::to_value(steps).unwrap(), ipc_fixture!("values")["pad"]);
    }

    #[test]
    fn holding_ps_summons_once() {
        let (mut nav, t) = (Navigation::default(), Instant::now());
        let ps = Input { ps: true, ..Input::default() };
        assert!(nav.update(ps, t).is_empty());
        assert!(nav.tick(t + ms(599)).is_empty());
        assert_eq!(nav.tick(t + ms(600)), vec![Action::Summon]);
        assert!(nav.tick(t + ms(1500)).is_empty());
        // A short press summons nothing.
        nav.update(Input::default(), t + ms(1600));
        nav.update(ps, t + ms(1700));
        nav.update(Input::default(), t + ms(1800));
        assert!(nav.tick(t + ms(3000)).is_empty());
    }
}
