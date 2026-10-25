// What Rust tells the page without being asked. Each event has one name (see `Event::name`) and one payload shape.

use crate::library::{Art, Game};
use crate::stores::{self, Store};
use crate::system::setup;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(untagged)]
pub enum Event<'a> {
    /// The library changed: every game.
    Games(&'a [Game]),
    /// Art for one game came in.
    Art { id: &'a str, art: &'a Art },
    /// A controller press for the page while Lamplit is in front: "up", "ok", "back" and so on.
    Pad(&'a str),
    /// A launched game started, stopped, or couldn't be launched.
    Play(Play<'a>),
    /// The PS button brought Lamplit forward; the running game's id, if any.
    Summoned(Option<String>),
    /// One line of the starting screen.
    LaunchStep(LaunchStep<'a>),
    /// Every store app: installed, running, signed in.
    Stores(Vec<stores::Status>),
    /// The headset, a controller or the sound device changed; the page asks for accessories_state and sound_state.
    Accessories,
    /// A short message for the player.
    Notice(String),
    /// Setup started from Settings has ended: whether it is still needed.
    Setup(setup::Status),
}

/// What became of a launched game. `starting`: it closed within `session::STUB_RUN` (20 s) of starting (a launcher
/// handing over to the game, or a crash at start), and Lamplit waits for it to come back.
#[derive(Clone, Serialize)]
#[cfg_attr(test, derive(strum::EnumCount))]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Play<'a> {
    Running { id: &'a str },
    Starting { id: &'a str },
    Ended { id: &'a str },
    Failed { id: &'a str, message: &'a str },
}

#[derive(Clone, Serialize)]
pub struct LaunchStep<'a> {
    /// The game being launched.
    pub id: &'a str,
    /// Which line: "store:steam", "update", "game" and so on. A new step with the same key replaces the line.
    pub key: &'a str,
    pub state: StepState,
    pub label: &'a str,
    /// The store app the line is about, which the page can open.
    pub store: Option<Store>,
}

/// How a line of the starting screen reads; the page picks its icon from this.
#[derive(Clone, Copy, Serialize)]
#[cfg_attr(test, derive(strum::VariantArray))]
#[serde(rename_all = "lowercase")]
pub enum StepState {
    Busy,
    Ok,
    Warn,
    /// The player has to act.
    Block,
    Error,
}

impl Event<'_> {
    fn name(&self) -> &'static str {
        match self {
            Event::Games(_) => "games",
            Event::Art { .. } => "art",
            Event::Pad(_) => "pad",
            Event::Play(_) => "play",
            Event::Summoned(_) => "summoned",
            Event::LaunchStep(_) => "launch-step",
            Event::Stores(_) => "stores",
            Event::Accessories => "accessories",
            Event::Notice(_) => "notice",
            Event::Setup(_) => "setup",
        }
    }
}

pub fn emit(app: &AppHandle, event: Event) {
    // Sending fails only once the page is gone, while Lamplit closes.
    let _ = app.emit(event.name(), event);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn payload(event: &Event) -> Value {
        serde_json::to_value(event).unwrap()
    }

    #[test]
    fn payloads_keep_the_shapes_the_page_reads() {
        let art = Art {
            portrait: Some(r"C:\Users\player\AppData\Local\lamplit\art\70\portrait.jpg".into()),
            hero: Some(r"C:\Users\player\AppData\Local\lamplit\art\70\hero.jpg".into()),
            logo: None,
        };
        assert_eq!(payload(&Event::Art { id: "steam:70", art: &art }), ipc_fixture!("art"));
        let id = "steam:70";
        let plays = [
            Play::Running { id },
            Play::Starting { id },
            Play::Ended { id },
            Play::Failed { id, message: "Steam didn't start." },
        ];
        // One of each: a new state fails here until it is in the list and in play.json.
        assert_eq!(plays.len(), <Play as strum::EnumCount>::COUNT);
        let plays: Vec<Value> = plays.into_iter().map(|p| payload(&Event::Play(p))).collect();
        assert_eq!(Value::Array(plays), ipc_fixture!("play"));
        let label = "Sign in to EA app";
        let step = LaunchStep { id, key: "store:ea", state: StepState::Block, label, store: Some(Store::Ea) };
        assert_eq!(payload(&Event::LaunchStep(step)), ipc_fixture!("launch-step"));
        assert_eq!(payload(&Event::Setup(setup::Status { needed: true })), ipc_fixture!("setup"));
        assert_eq!(payload(&Event::Accessories), Value::Null);
        assert_eq!(payload(&Event::Pad("ok")), json!("ok"));
        assert_eq!(payload(&Event::Summoned(None)), Value::Null);
    }

    #[test]
    fn every_step_state_is_one_the_page_knows() {
        let all = <StepState as strum::VariantArray>::VARIANTS;
        assert_eq!(serde_json::to_value(all).unwrap(), ipc_fixture!("values")["step_state"]);
    }
}
