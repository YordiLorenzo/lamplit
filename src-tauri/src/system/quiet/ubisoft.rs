// Ubisoft Connect's settings.yaml, as far as quiet mode needs it: which notification and overlay switches are on,
// and the file with some of them flipped. Ubisoft Connect rewrites the file when it exits, so it is only changed
// while Ubisoft Connect is closed.

use crate::error::{Error, Result};
use crate::files::{local_app_data, write_atomic};
use crate::stores::{self, ubisoft};
use std::path::PathBuf;

fn path() -> PathBuf {
    local_app_data().join(r"Ubisoft Game Launcher\settings.yaml")
}

/// Covered switches that are still on; None when Ubisoft Connect isn't set up here.
pub fn loud_flags() -> Option<Vec<String>> {
    Some(loud(&std::fs::read_to_string(path()).ok()?))
}

/// Switches the recorded flags (see `loud_flags`) off (`quiet`), or back on.
pub fn apply(quiet: bool, ids: &[String]) -> Result<()> {
    let Ok(text) = std::fs::read_to_string(path()) else { return Ok(()) };
    // By name: `catch_up` asks every 10 s while a change waits.
    if !stores::pids_named(&ubisoft::PROCESSES).is_empty() {
        let verb = if quiet { "quiet it" } else { "restore its settings" };
        return Err(Error::Player(format!("Close Ubisoft Connect so Lamplit can {verb}.")));
    }
    let out = rewrite(&text, quiet, ids);
    write_atomic(&path(), out.as_bytes()).map_err(|e| Error::Player(format!("Couldn't write Ubisoft's settings: {e}")))
}

/// Quiet mode covers every notification switch and the overlay with its "press Shift+F2" hint.
fn covered(section: &str, key: &str) -> bool {
    (section == "notifications" && key.ends_with("Enabled"))
        || (section == "overlay" && matches!(key, "enabled" | "warning_enabled"))
}

/// (section, key, value) of each `key: true|false` line, with the line's index.
fn flags(text: &str) -> Vec<(usize, String, String, bool)> {
    let mut section = String::new();
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        if !line.starts_with(' ') {
            section = line.trim_end_matches(':').trim().to_string();
            continue;
        }
        let Some((key, value)) = line.trim().split_once(':') else { continue };
        match value.trim() {
            "true" => out.push((i, section.clone(), key.trim().to_string(), true)),
            "false" => out.push((i, section.clone(), key.trim().to_string(), false)),
            _ => {}
        }
    }
    out
}

/// Covered switches that are on, as "section.key".
fn loud(text: &str) -> Vec<String> {
    flags(text)
        .into_iter()
        .filter(|(_, s, k, on)| *on && covered(s, k))
        .map(|(_, s, k, _)| format!("{s}.{k}"))
        .collect()
}

/// The file with the switches in `ids` turned off (`quiet`), or back on, keeping its line endings.
fn rewrite(text: &str, quiet: bool, ids: &[String]) -> String {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = text.lines().map(String::from).collect();
    for (i, section, key, value) in flags(text) {
        // Quiet: every recorded switch that is on goes off. Back: every recorded switch that is off goes on.
        if value == quiet && ids.contains(&format!("{section}.{key}")) {
            // The line is rebuilt from its indent, key and new value, so a key with "true" in its name stays as it is.
            let indent = lines[i].len() - lines[i].trim_start().len();
            lines[i] = format!("{}{key}: {}", &lines[i][..indent], !value);
        }
    }
    let mut out = lines.join(newline);
    if text.ends_with('\n') {
        out.push_str(newline);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_covered_flags() {
        let yaml = "misc:\n  enable_auto_wall_posts: true\nnotifications:\n  desktopChatEnabled: true\n  desktopClubActionsEnabled: false\noverlay:\n  enabled: true\n  fps_enabled: false\n";
        assert_eq!(loud(yaml), vec!["notifications.desktopChatEnabled", "overlay.enabled"]);
    }

    #[test]
    fn flips_only_the_recorded_switches() {
        let yaml = "notifications:\r\n  desktopChatEnabled: true\r\n  desktopFriendEnabled: true\r\noverlay:\r\n  enabled: true\r\n";
        let ids = ["notifications.desktopChatEnabled".to_string(), "overlay.enabled".to_string()];
        let quiet = rewrite(yaml, true, &ids);
        assert_eq!(
            quiet,
            "notifications:\r\n  desktopChatEnabled: false\r\n  desktopFriendEnabled: true\r\noverlay:\r\n  enabled: false\r\n"
        );
        assert_eq!(rewrite(&quiet, false, &ids), yaml);
    }

    #[test]
    fn changes_the_value_and_not_the_key() {
        let yaml = "notifications:\n  trueAchievementsEnabled: true\n  falseStartEnabled: false";
        let ids = ["notifications.trueAchievementsEnabled".to_string(), "notifications.falseStartEnabled".to_string()];
        let quiet = rewrite(yaml, true, &ids);
        assert_eq!(quiet, "notifications:\n  trueAchievementsEnabled: false\n  falseStartEnabled: false");
        assert_eq!(
            rewrite(&quiet, false, &ids),
            "notifications:\n  trueAchievementsEnabled: true\n  falseStartEnabled: true"
        );
    }
}
