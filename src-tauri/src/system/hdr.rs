// Windows HDR for a game: on or off while it runs, as the player chose in its menu, and back to how it was once
// Lamplit stops watching the game. What it was is kept in hdr-saved.json until it is back, so Restore Lamplit's
// changes can still put it back after a crash.

use crate::data;
use crate::error::{Error, Result};
use crate::launch::window::lamplit_screen;
use crate::win::display::{self, Screen};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

const FILE: &str = "hdr-saved.json";
/// A launch and the game's menu can both change HDR: one at a time.
static RECORD: Mutex<()> = Mutex::new(());

/// HDR for one game, chosen in its menu.
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(strum::VariantArray))]
#[serde(rename_all = "snake_case")]
pub enum Hdr {
    /// Lamplit leaves HDR as it is.
    #[default]
    AsItWas,
    On,
    Off,
}

impl Hdr {
    pub fn parse(name: &str) -> Result<Self> {
        match name {
            "as_it_was" => Ok(Self::AsItWas),
            "on" => Ok(Self::On),
            "off" => Ok(Self::Off),
            _ => Err(Error::Player("Choose As it was, On or Off for HDR.".into())),
        }
    }

    /// HDR on or off while the game runs; None to leave it.
    pub fn wanted(self) -> Option<bool> {
        match self {
            Hdr::AsItWas => None,
            Hdr::On => Some(true),
            Hdr::Off => Some(false),
        }
    }
}

/// What Lamplit changed, and for which game.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
struct Saved {
    screen: Screen,
    /// HDR as it was before Lamplit changed it.
    before: bool,
    /// HDR as Lamplit set it.
    set: bool,
    game: String,
}

/// The record after HDR is `now` on `screen` and the game `id` wants it `on`: what was there before Lamplit's first
/// change stays the state to go back to, and when that is what the game wants, nothing is left to put back.
fn next_record(saved: Option<Saved>, screen: Screen, now: bool, on: bool, id: &str) -> Option<Saved> {
    let before = saved.map_or(now, |s| s.before);
    (before != on).then(|| Saved { screen, before, set: on, game: id.into() })
}

/// The state to put back, when HDR is `now` on the record's screen: none when the player switched HDR in Windows
/// meanwhile, as that is their choice.
fn to_put_back(saved: &Saved, now: Option<bool>) -> Option<bool> {
    (now == Some(saved.set)).then_some(saved.before)
}

fn load() -> Result<Option<Saved>> {
    data::load(FILE)
}

fn save(saved: Option<&Saved>) -> Result<()> {
    match saved {
        Some(saved) => data::save(FILE, saved),
        None => data::remove(FILE).map_err(Into::into),
    }
}

/// The screen Lamplit is on.
fn lamplit_display() -> Option<Screen> {
    lamplit_screen().and_then(|r| display::screen_at(r.left, r.top))
}

/// Lamplit's screen can show HDR.
pub fn supported() -> bool {
    lamplit_display().and_then(display::hdr).is_some()
}

/// HDR as `choice` wants it for game `id`, on Lamplit's screen: switched, or put back for As it was. False when the
/// screen can't show HDR.
pub fn apply(id: &str, choice: Hdr) -> Result<bool> {
    match choice.wanted() {
        Some(on) => set_for(id, on),
        None => put_back(id).map(|_| true),
    }
}

/// Switches HDR on or off for game `id` on Lamplit's screen, saving first how it was. False when the screen can't show
/// HDR.
fn set_for(id: &str, on: bool) -> Result<bool> {
    let _record = RECORD.lock();
    // A record whose screen has gone (Windows restarted since) has nothing left to put back.
    let saved = load()?.filter(|s| display::hdr(s.screen).is_some());
    let screen = saved.as_ref().map(|s| s.screen).or_else(lamplit_display);
    let Some((screen, now)) = screen.and_then(|s| display::hdr(s).map(|now| (s, now))) else {
        return Ok(false);
    };
    // Saved before the switch: should Lamplit stop before it puts HDR back, Restore Lamplit's changes still can.
    save(next_record(saved, screen, now, on, id).as_ref())?;
    if now != on {
        display::set_hdr(screen, on)?;
        log::info!("{id}: HDR switched {}", if on { "on" } else { "off" });
    }
    Ok(true)
}

/// HDR back to how it was, if Lamplit changed it for game `id`. Returns the state put back.
pub fn put_back(id: &str) -> Result<Option<bool>> {
    let _record = RECORD.lock();
    match load()? {
        Some(saved) if saved.game == id => undo(&saved),
        _ => Ok(None),
    }
}

/// Puts back the record's state, then forgets the record. Kept when Windows refused, to try again.
fn undo(saved: &Saved) -> Result<Option<bool>> {
    let back = to_put_back(saved, display::hdr(saved.screen));
    if let Some(on) = back {
        display::set_hdr(saved.screen, on)?;
        log::info!("{}: HDR back {}", saved.game, if on { "on" } else { "off" });
    }
    save(None)?;
    Ok(back)
}

/// Restore Lamplit's changes: HDR back to how it was before Lamplit changed it for a game.
pub fn restore() -> Result<String> {
    let _record = RECORD.lock();
    let Some(saved) = load()? else { return Ok("Lamplit hasn't changed HDR.".into()) };
    Ok(match undo(&saved)? {
        Some(true) => "HDR is on again.",
        Some(false) => "HDR is off again.",
        None => "HDR was switched in Windows since, so it stays as it is.",
    }
    .into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen() -> Screen {
        serde_json::from_value(serde_json::json!({ "adapter": [1, 0], "output": 4352 })).unwrap()
    }

    #[test]
    fn the_page_s_names_are_the_choices() {
        let choices = <Hdr as strum::VariantArray>::VARIANTS;
        assert_eq!(serde_json::to_value(choices).unwrap(), ipc_fixture!("values")["hdr"]);
        for &choice in choices {
            assert_eq!(Hdr::parse(serde_json::to_value(choice).unwrap().as_str().unwrap()).unwrap(), choice);
        }
        assert!(Hdr::parse("auto").is_err());
    }

    #[test]
    fn the_state_from_before_the_first_change_is_the_one_put_back() {
        // HDR off, the game wants it on.
        let first = next_record(None, screen(), false, true, "a").unwrap();
        assert_eq!((first.before, first.set, first.game.as_str()), (false, true, "a"));
        // The next game wants it off while it is still on: what it was before Lamplit stays.
        let second = next_record(Some(first.clone()), screen(), true, false, "b");
        assert_eq!(second, None, "off is how it was: nothing left to put back");
        let third = next_record(Some(first), screen(), true, true, "b").unwrap();
        assert_eq!((third.before, third.game.as_str()), (false, "b"), "the record follows the game now watched");
        // Already as the game wants it: nothing to put back.
        assert_eq!(next_record(None, screen(), true, true, "a"), None);
    }

    #[test]
    fn hdr_the_player_switched_in_windows_stays() {
        let saved = Saved { screen: screen(), before: false, set: true, game: "a".into() };
        assert_eq!(to_put_back(&saved, Some(true)), Some(false));
        assert_eq!(to_put_back(&saved, Some(false)), None, "switched off in Windows meanwhile");
        assert_eq!(to_put_back(&saved, None), None, "the screen has gone");
    }
}
