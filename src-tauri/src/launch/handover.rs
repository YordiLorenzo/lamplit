// When Lamplit hands the screen over to a game it has started, judged from the windows that opened since Play and the
// game's own. The game is up once a window of the game's processes covers the screen and draws (answers Windows) for
// a moment: a small splash, a store app's window (also one that opens maximised) or the desktop in between don't
// count. Any other window that stays may need the player (a launcher with a Play button, a sign-in, a licence
// question), so the starting screen points at it, and the player decides. Once the game has run a while with only
// windows of its own that don't cover the screen, the front one gets the screen: a launcher, or a game that runs in a
// window.

use crate::win::window::Rect;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

/// How long a window of the game's must cover the screen and answer before it gets the screen: long enough to tell a
/// window that is up from one that blinks while the game sets its screen mode.
const UP_FOR: Duration = Duration::from_millis(500);
/// A window that stays this long, other than the game's over the screen, may need the player.
const NEEDS_YOU_AFTER: Duration = Duration::from_secs(5);
/// The game has run this long with only windows of its own that don't cover the screen: the front one gets it.
const SETTLE: Duration = Duration::from_secs(12);
/// A window covering this much of the screen covers it: a full-screen or borderless game's does, a splash doesn't.
const COVERS: f64 = 0.9;

/// A window, as one look at it found it.
#[derive(Clone, Copy, Debug)]
pub struct Seen {
    pub id: isize,
    /// One of the processes the watcher counts as the game's runs it.
    pub game: bool,
    /// Its process runs from the game's folders: the game's, or a helper of the game's such as Xbox's licence
    /// question.
    pub own: bool,
    pub covers: bool,
    /// It answered Windows, so its thread reads its messages and draws.
    pub answers: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Next {
    Wait,
    /// Point the player at this window: it may need them. `own`: it is the game's or a helper's of the game's.
    Hint {
        id: isize,
        own: bool,
    },
    /// The screen goes to this window.
    HandOver(isize),
}

/// What the looks at the windows have found so far.
#[derive(Default)]
pub struct Handover {
    first_seen: HashMap<isize, Instant>,
    covering_since: HashMap<isize, Instant>,
    hinted: HashSet<isize>,
    running_since: Option<Instant>,
}

impl Handover {
    /// One look at the windows, front first. `game_runs`: the game's processes run.
    pub fn poll(&mut self, windows: &[Seen], game_runs: bool, now: Instant) -> Next {
        // The game's window over the screen, which gets it once it draws.
        let over = |w: &Seen| w.game && w.covers;
        let up = |w: &Seen| over(w) && w.answers;
        self.first_seen.retain(|id, _| windows.iter().any(|w| w.id == *id));
        self.covering_since.retain(|id, _| windows.iter().any(|w| w.id == *id && up(w)));
        self.running_since = if game_runs { Some(self.running_since.unwrap_or(now)) } else { None };
        for w in windows {
            self.first_seen.entry(w.id).or_insert(now);
            if up(w) && now - *self.covering_since.entry(w.id).or_insert(now) >= UP_FOR {
                return Next::HandOver(w.id);
            }
        }
        if self.running_since.is_some_and(|t| now - t >= SETTLE)
            && let Some(w) = windows.iter().find(|w| w.game)
        {
            return Next::HandOver(w.id);
        }
        let waiting = windows
            .iter()
            .find(|w| !over(w) && !self.hinted.contains(&w.id) && now - self.first_seen[&w.id] >= NEEDS_YOU_AFTER);
        if let Some(w) = waiting {
            self.hinted.insert(w.id);
            return Next::Hint { id: w.id, own: w.own };
        }
        Next::Wait
    }
}

/// Whether a window at `window` covers the screen `screen`.
pub fn covers(window: Rect, screen: Rect) -> bool {
    let area = |r: Rect| f64::from((r.right - r.left).max(0)) * f64::from((r.bottom - r.top).max(0));
    let inside = Rect {
        left: window.left.max(screen.left),
        top: window.top.max(screen.top),
        right: window.right.min(screen.right),
        bottom: window.bottom.min(screen.bottom),
    };
    area(screen) > 0.0 && area(inside) >= area(screen) * COVERS
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPLASH: isize = 1;
    const GAME: isize = 2;
    const STEAM: isize = 3;

    fn seen(id: isize, game: bool, covers: bool) -> Seen {
        Seen { id, game, own: game, covers, answers: true }
    }

    /// Looks every 250 ms from `from` to `to` seconds with the windows `windows` gives for each moment, as the watcher
    /// does until it hands the screen over, and returns what it found, with when.
    fn run(
        h: &mut Handover,
        t0: Instant,
        (from, to): (f64, f64),
        mut windows: impl FnMut(f64) -> (Vec<Seen>, bool),
    ) -> Vec<(f64, Next)> {
        let mut found = Vec::new();
        let mut t = from;
        while t <= to {
            let (w, runs) = windows(t);
            let next = h.poll(&w, runs, t0 + Duration::from_secs_f64(t));
            let over = matches!(next, Next::HandOver(_));
            if next != Next::Wait {
                found.push((t, next));
            }
            if over {
                break;
            }
            t += 0.25;
        }
        found
    }

    #[test]
    fn a_splash_then_a_gap_then_the_game_over_the_whole_screen() {
        // As Call of Duty started on 2026-10-27: a splash, a moment with no window, then the game over the screen.
        let (t0, mut h) = (Instant::now(), Handover::default());
        let found = run(&mut h, t0, (0.0, 8.0), |t| {
            let windows = if t < 2.5 {
                vec![seen(SPLASH, true, false)]
            } else if t < 3.5 {
                vec![]
            } else {
                vec![seen(GAME, true, true)]
            };
            (windows, true)
        });
        assert_eq!(found, [(4.0, Next::HandOver(GAME))]);
    }

    #[test]
    fn a_window_that_covers_the_screen_but_doesnt_draw_yet_waits() {
        let (t0, mut h) = (Instant::now(), Handover::default());
        let found = run(&mut h, t0, (0.0, 3.0), |t| (vec![Seen { answers: t >= 2.0, ..seen(GAME, true, true) }], true));
        assert_eq!(found, [(2.5, Next::HandOver(GAME))]);
    }

    #[test]
    fn a_window_that_waits_for_the_player_is_pointed_at_then_gets_the_screen() {
        // A launcher with a Play button, or a licence question, of the game's own.
        let (t0, mut h) = (Instant::now(), Handover::default());
        let found = run(&mut h, t0, (0.0, 14.0), |t| (vec![seen(SPLASH, true, false)], t >= 1.0));
        assert_eq!(found, [(5.0, Next::Hint { id: SPLASH, own: true }), (13.0, Next::HandOver(SPLASH))]);
    }

    #[test]
    fn another_programs_window_is_only_pointed_at() {
        // A store app's window that stays: Lamplit points at it, but it gets the screen only when the player asks.
        let (t0, mut h) = (Instant::now(), Handover::default());
        let found = run(&mut h, t0, (0.0, 30.0), |_| (vec![seen(STEAM, false, false)], false));
        assert_eq!(found, [(5.0, Next::Hint { id: STEAM, own: false })]);
    }

    #[test]
    fn a_store_app_opening_over_the_screen_is_pointed_at_not_handed_the_screen() {
        // The store app opens maximised while the game shows a small splash; then the game covers the screen.
        let (t0, mut h) = (Instant::now(), Handover::default());
        let found = run(&mut h, t0, (0.0, 10.0), |t| {
            let mut windows = vec![seen(STEAM, false, true)];
            if t < 2.5 {
                windows.push(seen(SPLASH, true, false));
            } else if t >= 6.0 {
                windows.insert(0, seen(GAME, true, true));
            }
            (windows, true)
        });
        assert_eq!(found, [(5.0, Next::Hint { id: STEAM, own: false }), (6.5, Next::HandOver(GAME))]);
    }

    #[test]
    fn a_window_that_blinks_over_the_screen_starts_again() {
        // The game sets its screen mode: its window covers the screen, then for a moment doesn't, then does again.
        let (t0, mut h) = (Instant::now(), Handover::default());
        let found = run(&mut h, t0, (0.0, 2.0), |t| (vec![seen(GAME, true, !(0.25..0.5).contains(&t))], true));
        assert_eq!(found, [(1.0, Next::HandOver(GAME))]);
    }

    #[test]
    fn covering_the_screen() {
        let screen = Rect { left: 0, top: 0, right: 3840, bottom: 2160 };
        assert!(covers(screen, screen));
        // A borderless window a little larger than the screen, as some games make.
        assert!(covers(Rect { left: -8, top: -8, right: 3848, bottom: 2168 }, screen));
        // A splash in the middle, and a window on another monitor.
        assert!(!covers(Rect { left: 1600, top: 900, right: 2240, bottom: 1260 }, screen));
        assert!(!covers(Rect { left: 3840, top: 0, right: 7680, bottom: 2160 }, screen));
        assert!(!covers(screen, Rect::default()));
    }
}
