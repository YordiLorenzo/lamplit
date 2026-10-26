// A launched game's session as seen from polling its processes once a second: when it has really started, when
// it is a launcher stub handing over, when it has ended, and how long it ran. watch.rs does the polling.

use std::time::{Duration, Instant};

const START_TIMEOUT: Duration = Duration::from_mins(3);
const ANNOUNCE_AFTER: Duration = Duration::from_millis(1500);
const GONE_FOR: Duration = Duration::from_secs(5);
/// A game that exits sooner than this was a stub handing over to its launcher (Rockstar, some EA titles).
pub const STUB_RUN: Duration = Duration::from_secs(20);
/// The longest time between two polls that counts as play. Polls come about once a second, so a longer gap means
/// the PC was asleep with the game open.
const MAX_POLL_GAP: Duration = Duration::from_secs(5);
/// How often play time is saved while a game runs, which is what a crash or a power cut can lose.
const SAVE_PLAY_EVERY: Duration = Duration::from_mins(1);

/// Counts how long a game runs: the time between two polls that both saw it.
#[derive(Default)]
pub struct PlayClock {
    last_seen: Option<Instant>,
    unsaved: Duration,
}

impl PlayClock {
    /// One poll. Returns the whole seconds to save: every SAVE_PLAY_EVERY while the game runs, and the rest once it
    /// doesn't.
    pub fn poll(&mut self, running: bool, now: Instant) -> Option<u64> {
        let last_seen = self.last_seen.take();
        if running {
            if let Some(last) = last_seen {
                self.unsaved += (now - last).min(MAX_POLL_GAP);
            }
            self.last_seen = Some(now);
            if self.unsaved < SAVE_PLAY_EVERY {
                return None;
            }
        }
        let seconds = self.unsaved.as_secs();
        // While it runs, the part of a second carries over to the next save.
        self.unsaved = if running { Duration::new(0, self.unsaved.subsec_nanos()) } else { Duration::ZERO };
        (seconds > 0).then_some(seconds)
    }
}

/// What one poll of the game's processes means.
#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    /// Seen for ANNOUNCE_AFTER: Lamplit steps aside.
    Started,
    /// Gone again within STUB_RUN of starting: a launcher stub handing over (Rockstar, some EA titles) or a
    /// crash at start. Lamplit comes back showing "Starting…" and keeps waiting; Circle cancels.
    Restarting,
    /// Closed after a real session, or never came back after Restarting.
    Ended,
    /// Nothing from the game ran within START_TIMEOUT. Lamplit keeps waiting (the player can cancel), as Playnite
    /// does: the store app may be showing a sign-in, update or licence prompt.
    TimedOut,
}

pub struct Tracker {
    deadline: Instant,
    first_seen: Option<Instant>,
    last_seen: Instant,
    /// Lamplit has stepped aside for this game (Started, not undone by Restarting).
    started: bool,
    ever_started: bool,
}

impl Tracker {
    pub fn new(now: Instant) -> Self {
        Tracker { deadline: now + START_TIMEOUT, first_seen: None, last_seen: now, started: false, ever_started: false }
    }

    /// The store is still busy (downloading an update first): keep waiting at least START_TIMEOUT from now.
    pub fn hold_off_timeout(&mut self, now: Instant) {
        self.deadline = self.deadline.max(now + START_TIMEOUT);
    }

    /// Still waiting for the game: a new launch or a cancel ends this watcher.
    pub fn waiting(&self) -> bool {
        !self.started
    }

    pub fn poll(&mut self, running: bool, now: Instant) -> Option<Step> {
        if running {
            self.last_seen = now;
            let since = *self.first_seen.get_or_insert(now);
            if !self.started && now - since >= ANNOUNCE_AFTER {
                self.started = true;
                self.ever_started = true;
                return Some(Step::Started);
            }
            return None;
        }
        if let Some(since) = self.first_seen {
            if now - self.last_seen < GONE_FOR {
                return None;
            }
            self.first_seen = None;
            if self.last_seen - since < STUB_RUN {
                self.deadline = now + START_TIMEOUT;
                // Only worth telling when Lamplit had already stepped aside.
                return std::mem::take(&mut self.started).then_some(Step::Restarting);
            }
            return Some(Step::Ended);
        }
        if now > self.deadline {
            if self.ever_started {
                return Some(Step::Ended);
            }
            self.deadline = now + START_TIMEOUT;
            return Some(Step::TimedOut);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feeds one poll per second (`true` while a game process runs) and, like the watcher, stops at Ended or
    /// TimedOut. Returns the steps with their second.
    fn run(tracker: &mut Tracker, start: Instant, from: u64, polls: &[bool]) -> Vec<(u64, Step)> {
        let mut steps = Vec::new();
        for (i, &running) in polls.iter().enumerate() {
            let t = from + i as u64;
            if let Some(step) = tracker.poll(running, start + Duration::from_secs(t)) {
                let last = matches!(step, Step::Ended | Step::TimedOut);
                steps.push((t, step));
                if last {
                    break;
                }
            }
        }
        steps
    }

    fn secs(n: usize, running: bool) -> Vec<bool> {
        vec![running; n]
    }

    #[test]
    fn game_starts_and_closes() {
        let t0 = Instant::now();
        let mut tr = Tracker::new(t0);
        let polls = [secs(10, false), secs(60, true), secs(10, false)].concat();
        assert_eq!(run(&mut tr, t0, 1, &polls), vec![(13, Step::Started), (75, Step::Ended)]);
    }

    #[test]
    fn nothing_starts_then_it_does() {
        // No game for over 3 minutes: a reminder, then Lamplit keeps waiting and still sees the game start.
        let t0 = Instant::now();
        let mut tr = Tracker::new(t0);
        let mut steps = Vec::new();
        for t in 1..=400u64 {
            if let Some(s) = tr.poll(t > 300, t0 + Duration::from_secs(t)) {
                steps.push((t, s));
            }
        }
        assert_eq!(steps, vec![(181, Step::TimedOut), (303, Step::Started)]);
    }

    #[test]
    fn a_steam_download_holds_off_the_timeout() {
        let t0 = Instant::now();
        let mut tr = Tracker::new(t0);
        let at = |s| t0 + Duration::from_secs(s);
        tr.hold_off_timeout(at(170));
        assert_eq!(tr.poll(false, at(181)), None);
        assert_eq!(tr.poll(false, at(351)), Some(Step::TimedOut));
    }

    #[test]
    fn launcher_stub_hands_over_to_the_game() {
        // The stub runs 4 s, the launcher takes 40 s, then the game runs a minute.
        let t0 = Instant::now();
        let mut tr = Tracker::new(t0);
        let polls = [secs(4, true), secs(40, false), secs(60, true), secs(10, false)].concat();
        assert_eq!(
            run(&mut tr, t0, 1, &polls),
            vec![(3, Step::Started), (9, Step::Restarting), (47, Step::Started), (109, Step::Ended)]
        );
        assert!(!tr.waiting());
    }

    #[test]
    fn blink_shorter_than_announce_is_silent() {
        let t0 = Instant::now();
        let mut tr = Tracker::new(t0);
        let polls = [secs(1, true), secs(30, false), secs(30, true)].concat();
        assert_eq!(run(&mut tr, t0, 1, &polls), vec![(34, Step::Started)]);
    }

    #[test]
    fn crash_at_start_comes_back_then_gives_up() {
        let t0 = Instant::now();
        let mut tr = Tracker::new(t0);
        let polls = [secs(10, true), secs(200, false)].concat();
        assert_eq!(run(&mut tr, t0, 1, &polls), vec![(3, Step::Started), (15, Step::Restarting), (196, Step::Ended)]);
        assert!(tr.waiting());
    }

    #[test]
    fn play_time_is_saved_every_minute_and_when_the_game_stops() {
        let t0 = Instant::now();
        let mut clock = PlayClock::default();
        let mut saved = Vec::new();
        // Polls 1.5 s apart: 150 s of play, then the game is gone, then a poll with nothing to save.
        for (i, running) in [vec![true; 101], vec![false; 2]].concat().into_iter().enumerate() {
            if let Some(s) = clock.poll(running, t0 + Duration::from_millis(1500 * i as u64)) {
                saved.push((i, s));
            }
        }
        assert_eq!(saved, vec![(40, 60), (80, 60), (101, 30)]);
    }

    #[test]
    fn a_pc_asleep_with_the_game_open_isnt_play() {
        let t0 = Instant::now();
        let at = |s| t0 + Duration::from_secs(s);
        let mut clock = PlayClock::default();
        for s in 0..=10 {
            assert_eq!(clock.poll(true, at(s)), None);
        }
        // Eight hours asleep: the gap counts as one poll's worth at most.
        assert_eq!(clock.poll(true, at(8 * 3600)), None);
        assert_eq!(clock.poll(false, at(8 * 3600 + 1)), Some(15));
    }

    #[test]
    fn short_gaps_dont_end_the_game() {
        // A game restarting its own process (settings change) is gone for 3 s.
        let t0 = Instant::now();
        let mut tr = Tracker::new(t0);
        let polls = [secs(30, true), secs(3, false), secs(30, true), secs(6, false)].concat();
        assert_eq!(run(&mut tr, t0, 1, &polls), vec![(3, Step::Started), (68, Step::Ended)]);
    }
}
