// A local plain-text report. Only the fields listed here leave their source structs, so a future device name or
// saved folder in one of those structs cannot quietly become part of the report.

use crate::devices::{accessories, audio};
use crate::error::{Error, Result};
use crate::library::{Game, Library};
use crate::{commands, data, prefs, stores, win};
use regex::{Captures, Regex, RegexBuilder};
use serde_json::json;
use std::fs::OpenOptions;
use std::io::{ErrorKind, Write};
use std::path::Path;
use std::sync::LazyLock;
use tauri::{AppHandle, Manager};
use time::{OffsetDateTime, macros::format_description};

pub fn preview(app: &AppHandle) -> Result<String> {
    let games = app.state::<Library>().games().ok_or_else(|| {
        Error::Player("Lamplit is still looking for games. Try Save a report when it has finished.".into())
    })?;
    let username = win::report::username()?;
    let accessories = accessories::state(app);
    let sound = audio::state();
    let redactor = Redactor::new(&username, &games, &accessories, sound.as_ref().ok())?;
    let log = match std::fs::read_to_string(data::data_dir().join("lamplit.log")) {
        Ok(log) => warning_lines(&log, &redactor),
        Err(e) if e.kind() == ErrorKind::NotFound => "lamplit.log is not present.".into(),
        Err(_) => "lamplit.log could not be read.".into(),
    };
    let details = Details {
        version: env!("CARGO_PKG_VERSION"),
        windows: win::report::windows_version()
            .unwrap_or_else(|_| "Unavailable: Windows version could not be read".into()),
        display: commands::display_mode(),
        screens: win::report::screens(),
        accessories,
        sound: sound.ok(),
        stores: stores::status_all(),
        games,
        prefs: prefs::get(app),
        log,
    };
    Ok(details.text())
}

struct Details<'a> {
    version: &'a str,
    windows: String,
    display: Option<String>,
    screens: i32,
    accessories: accessories::Accessories,
    sound: Option<audio::Sound>,
    stores: Vec<stores::Status>,
    games: Vec<Game>,
    prefs: prefs::Prefs,
    log: String,
}

impl Details<'_> {
    fn text(&self) -> String {
        let mut lines = vec![
            "Lamplit report".into(),
            format!("Lamplit: {}", self.version),
            self.windows.clone(),
            format!("Screen: {}", self.display.as_deref().unwrap_or("Unknown")),
            format!("Screens: {}", self.screens),
            String::new(),
            format!("Controllers: {}", self.accessories.controllers.len()),
        ];
        for (i, pad) in self.accessories.controllers.iter().enumerate() {
            lines.push(format!(
                "Controller {}: kind={}, connection={}, battery={}",
                i + 1,
                json!(pad.kind),
                json!(pad.connection),
                serde_json::to_string(&pad.battery).expect("battery fields are numbers and enums")
            ));
        }
        let h = &self.accessories.headset;
        lines.push(format!(
            "Headset (PRO X 2): receiver={}, on={}, battery={}, charge={}, sidetone={}, auto_off={}",
            h.receiver,
            json!(h.on),
            json!(h.battery),
            json!(h.charge),
            json!(h.sidetone),
            json!(h.auto_off)
        ));
        if let Some(sound) = &self.sound {
            let default = sound.outputs.iter().find(|d| d.default).map(|d| d.kind);
            lines.push(format!("Sound outputs: {}; default kind: {}", sound.outputs.len(), json!(default)));
        } else {
            lines.push("Sound outputs: unavailable (Windows could not read sound devices)".into());
        }
        lines.extend([String::new(), "Stores (account is the sign-in state Lamplit can detect):".into()]);
        for store in &self.stores {
            let count = self.games.iter().filter(|g| g.store == Some(store.store)).count();
            lines.push(format!(
                "{}: installed={}, running={}, account={}, games={count}",
                store.store.key(),
                store.installed,
                store.running,
                json!(store.account)
            ));
        }
        lines.extend([
            String::new(),
            format!("Games found: {}", self.games.len()),
            format!("Added by hand: {}", self.games.iter().filter(|g| g.manual).count()),
            format!("Hidden: {}", self.games.iter().filter(|g| g.hidden).count()),
            format!("Favourites: {}", self.games.iter().filter(|g| g.favourite).count()),
            String::new(),
            "Prefs:".into(),
        ]);
        let p = &self.prefs;
        lines.push(format!("sound_follows: {}", p.sound_follows));
        lines.push(format!("touchpad_mouse: {}", p.touchpad_mouse));
        lines.push(format!("steam_devtools: {}", p.steam_devtools));
        lines.push(format!("online_art: {}", p.online_art));
        lines.push(format!("screensaver_minutes: {}", p.screensaver_minutes));
        lines.push(format!("dock: {}", p.dock));
        lines.extend([
            String::new(),
            "Last 50 warnings and errors (names and folders removed):".into(),
            self.log.clone(),
        ]);
        lines.join("\n") + "\n"
    }
}

/// Saves precisely the preview the player read, even if the log or devices have changed since it opened.
pub fn save(text: &str) -> Result<String> {
    let folder = win::report::downloads()
        .map_err(|_| Error::Player("Windows couldn't find Downloads. The report has not been saved.".into()))?;
    let now = OffsetDateTime::now_local().unwrap_or_else(|_| OffsetDateTime::now_utc());
    let stamp = now.format(format_description!("[year]-[month]-[day] [hour][minute]")).expect("a valid date format");
    write_report(&folder, &stamp, text).map_err(|e| {
        log::warn!("report: couldn't save in Downloads: {e}");
        Error::Player("Couldn't save the report in Downloads. Check there is space and try again.".into())
    })
}

fn write_report(folder: &Path, stamp: &str, text: &str) -> std::io::Result<String> {
    for number in 1.. {
        let suffix = if number == 1 { String::new() } else { format!(" ({number})") };
        let name = format!("Lamplit report {stamp}{suffix}.txt");
        // Two reports in the same minute must not overwrite each other, or a file the player put there.
        match OpenOptions::new().write(true).create_new(true).open(folder.join(&name)) {
            Ok(mut file) => {
                file.write_all(text.as_bytes())?;
                file.sync_all()?;
                return Ok(name);
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}

struct Redactor {
    names: Regex,
    replacements: Vec<String>,
}

impl Redactor {
    fn new(
        username: &str,
        games: &[Game],
        accessories: &accessories::Accessories,
        sound: Option<&audio::Sound>,
    ) -> Result<Self> {
        let mut names = vec![(username.to_string(), "<user>".into())];
        for game in games {
            // Games outside stores use a path as their id. Keep its prefix, never its folder or exe name.
            names.push((game.name.clone(), redact_paths(&game.id)));
        }
        for pad in &accessories.controllers {
            names.push((pad.name.clone(), "<device>".into()));
            names.push((pad.id.clone(), "<device>".into()));
        }
        if let Some(sound) = sound {
            for device in sound.outputs.iter().chain(&sound.inputs) {
                for name in [&device.name, &device.windows_name, &device.id] {
                    names.push((name.clone(), "<device>".into()));
                }
            }
        }
        Self::from_names(names)
    }

    fn from_names(mut names: Vec<(String, String)>) -> Result<Self> {
        names.retain(|(name, _)| !name.is_empty());
        // A title can contain another title or the account name. Take the longest match in one pass, so an id we
        // just inserted is never mistaken for another title.
        names.sort_by_key(|(name, _)| std::cmp::Reverse(name.len()));
        let pattern = names.iter().map(|(name, _)| format!("({})", regex::escape(name))).collect::<Vec<_>>().join("|");
        let names_regex = RegexBuilder::new(&pattern)
            .case_insensitive(true)
            .build()
            .map_err(|e| Error::Internal(format!("report: could not prepare name redaction: {e}")))?;
        Ok(Self { names: names_regex, replacements: names.into_iter().map(|(_, replacement)| replacement).collect() })
    }

    fn line(&self, line: &str) -> String {
        // These messages can refer to a device disconnected since the error. Its old name isn't in audio::state.
        static SOUND: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"(sound: couldn't switch to |can't switch audio to ).*(: )").unwrap());
        static IDS: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(?i)(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}|\{[0-9a-f.-]+\}|\b[0-9a-f]{12}\b").unwrap()
        });
        let line = SOUND.replace_all(line, "${1}<device>${2}");
        let line = redact_paths(&line);
        let line = self.names.replace_all(&line, |captures: &Captures<'_>| {
            let index = captures.iter().skip(1).position(|c| c.is_some()).expect("every match is one name");
            self.replacements[index].as_str()
        });
        IDS.replace_all(&line, "<device>").into_owned()
    }
}

fn redact_paths(text: &str) -> String {
    // Paths printed with Display can have spaces and apostrophes, with no quotes. Consume through them until a
    // character Windows forbids (notably the colon before the error). This may remove extra prose after a path.
    static PATHS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)(?:(?:file:/+|https?://asset\.localhost/)(?:[a-z]:[\\/])?|[a-z]:[\\/]|\\\\|\b[\w.-]+[\\/]|[\\/])[^\r\n":<>|]*"#)
            .unwrap()
    });
    PATHS.replace_all(text, "<folder>").into_owned()
}

fn warning_lines(log: &str, redactor: &Redactor) -> String {
    // Only complete timestamped records, not continuations of panic or library messages with arbitrary content.
    static WARNING: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} (WARN |ERROR) ").unwrap());
    let mut lines = log.lines().rev().filter(|line| WARNING.is_match(line)).take(50).collect::<Vec<_>>();
    lines.reverse();
    if lines.is_empty() {
        "No warning or error lines.".into()
    } else {
        lines.into_iter().map(|line| redactor.line(line)).collect::<Vec<_>>().join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::{headset, pad};
    use crate::library::Launch;

    fn redactor() -> Redactor {
        Redactor::from_names(vec![
            ("Alice".into(), "<user>".into()),
            ("ELDEN RING".into(), "steam:1245620".into()),
            ("ELDEN RING Nightreign".into(), "steam:2622380".into()),
            ("Alice's Adventure".into(), "manual:<folder>".into()),
        ])
        .unwrap()
    }

    #[test]
    fn real_warning_formats_remove_names_and_paths() {
        let redact = redactor();
        for (line, want) in [
            (
                r"launch of ELDEN RING stopped: Can't find D:\Games\ELDEN RING\game.exe",
                "launch of steam:1245620 stopped: Can't find <folder>",
            ),
            (
                r"art: can't make C:\Users\Alice Smith\AppData\Local\lamplit\art: Access is denied. (os error 5)",
                "art: can't make <folder>: Access is denied. (os error 5)",
            ),
            (
                r"manual:d:\alice's games\game.exe: can't save 50 s of play time: disk full",
                "manual:<folder>: can't save 50 s of play time: disk full",
            ),
            (
                r"controller: can't open \\?\hid#vid_054c&pid_0ce6#serial123: Access is denied",
                "controller: can't open <folder>: Access is denied",
            ),
            (
                r"[webview] library_add_game failed: \\server\Alice's share\Game.exe: not available",
                "[webview] library_add_game failed: <folder>: not available",
            ),
            (r#"panic: "C:\\Users\\Alice\\My Games\\Game.exe": invalid"#, r#"panic: "<folder>": invalid"#),
            (
                "ELDEN RING Nightreign hasn't started after 90 s; still waiting",
                "steam:2622380 hasn't started after 90 s; still waiting",
            ),
            (
                "launch of Alice's Adventure stopped: alice cannot open it",
                "launch of manual:<folder> stopped: <user> cannot open it",
            ),
            (
                "sound: couldn't switch to Bob's headphones: Access denied (0x80070005)",
                "sound: couldn't switch to <device>: Access denied (0x80070005)",
            ),
            ("can't switch audio to {0.0.0.00000000}.{aa11-bb22}: failed", "can't switch audio to <device>: failed"),
            ("controller: aa:bb:cc:dd:ee:ff and AABBCCDDEEFF failed", "controller: <device> and <device> failed"),
            (
                "headset: no answer from the headset; trying again when it next turns on",
                "headset: no answer from the headset; trying again when it next turns on",
            ),
        ] {
            let stamp = "2026-10-25 21:04:05.123 WARN  ";
            assert_eq!(redact.line(&format!("{stamp}{line}")), format!("{stamp}{want}"), "{line}");
        }
    }

    #[test]
    fn paths_include_forward_slashes_relative_source_paths_and_asset_urls() {
        for path in [
            "C:/Users/Alice/My Games/game.exe",
            "src/library/art.rs",
            "file:///C:/Users/Alice/game.exe",
            "http://asset.localhost/C%3A%5CUsers%5CAlice%5Cart.jpg",
        ] {
            assert_eq!(redact_paths(path), "<folder>", "{path}");
        }
    }

    #[test]
    fn report_matches_the_preview_fixture_without_device_names_or_identifiers() {
        let mut game = Game::new(
            "steam:1245620".into(),
            "ELDEN RING".into(),
            Some(stores::Store::Steam),
            r"D:\Games\ELDEN RING".into(),
            Launch::Uri(String::new()),
        );
        game.hidden = true;
        game.favourite = true;
        let details = Details {
            version: "0.4.0",
            windows: "Windows 11 25H2, build 26200.6584".into(),
            display: Some("3840 × 2160 at 120 Hz".into()),
            screens: 2,
            accessories: accessories::Accessories {
                headset: headset::Status::default(),
                controllers: vec![pad::Controller {
                    id: "private-id".into(), name: "Alice's controller".into(), kind: pad::Kind::Xbox,
                    connection: pad::Connection::Wireless, battery: None, headphones: None, address: Some(123),
                }],
            },
            sound: Some(audio::Sound {
                outputs: vec![audio::Device { id: "private-id".into(), windows_name: "Alice's TV".into(),
                    name: "Alice's TV".into(), kind: audio::Kind::Tv, default: true }],
                inputs: vec![], volume: None, muted: None, mic_muted: None,
            }),
            stores: vec![stores::Status { store: stores::Store::Steam, name: "Steam", installed: true,
                running: false, account: stores::Account::Remembered }],
            games: vec![game], prefs: prefs::Prefs::default(),
            log: redactor().line(r"2026-10-25 21:04:05.123 WARN  launch of ELDEN RING stopped: D:\Games\ELDEN RING\game.exe: Access denied"),
        };
        let text = details.text();
        assert_eq!(serde_json::to_value(&text).unwrap(), ipc_fixture!("report"));
        for private in ["Alice", "private-id", "ELDEN RING", r"D:\Games"] {
            assert!(!text.contains(private), "{private}");
        }
        let redact = Redactor::new("Alice", &details.games, &details.accessories, details.sound.as_ref()).unwrap();
        assert_eq!(redact.line("Alice's controller and Alice's TV: private-id"), "<device> and <device>: <device>");
    }

    #[test]
    fn selects_only_the_last_50_warnings_and_errors_in_order() {
        let mut log = "not a log record WARN Alice\n2026-10-25 21:04:05.123 INFO  ERROR is just a word\n".to_string();
        for i in 0..55 {
            let level = if i % 2 == 0 { "WARN " } else { "ERROR" };
            log.push_str(&format!("2026-10-25 21:04:05.123 {level} error {i} for Alice\n"));
        }
        let text = warning_lines(&log, &redactor());
        assert_eq!(text.lines().count(), 50);
        assert!(text.lines().next().unwrap().ends_with("error 5 for <user>"));
        assert!(text.lines().last().unwrap().ends_with("error 54 for <user>"));
        assert!(!text.contains("Alice") && !text.contains("INFO") && !text.contains("not a log record"));
        assert_eq!(warning_lines("", &redactor()), "No warning or error lines.");
    }

    #[test]
    fn saving_twice_keeps_both_files_and_the_exact_preview() {
        let folder =
            std::env::temp_dir().join(format!("lamplit-report-{}", OffsetDateTime::now_utc().unix_timestamp_nanos()));
        std::fs::create_dir_all(&folder).unwrap();
        let stamp = "2026-11-09 1530";
        let first = write_report(&folder, stamp, "preview one\n").unwrap();
        assert_eq!(serde_json::to_value(&first).unwrap(), ipc_fixture!("report-saved"));
        let second = write_report(&folder, stamp, "preview two\n").unwrap();
        assert_eq!(second, format!("Lamplit report {stamp} (2).txt"));
        assert_eq!(std::fs::read_to_string(folder.join(&first)).unwrap(), "preview one\n");
        assert_eq!(std::fs::read_to_string(folder.join(&second)).unwrap(), "preview two\n");
        for name in [first, second] {
            std::fs::remove_file(folder.join(name)).unwrap();
        }
        assert!(write_report(&folder.join("absent"), stamp, "preview").is_err());
        std::fs::remove_dir(folder).unwrap();
    }
}
