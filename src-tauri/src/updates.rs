// Signed updates stay in memory until no game is starting or running and Lamplit is in front again.

use crate::error::{Error, Result};
use crate::events::{self, Event};
use crate::launch::{Launcher, window};
use crate::prefs;
use parking_lot::Mutex;
use serde::Serialize;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const DAY: u64 = 24 * 60 * 60;

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(strum::VariantArray))]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    #[default]
    Idle,
    Checking,
    Current,
    Available,
    Downloading,
    Ready,
    Installing,
    Error,
}

#[derive(Clone, Default, Serialize)]
pub struct Status {
    pub phase: Phase,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Default)]
struct Pending {
    status: Status,
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct Updates {
    // launch_start holds this until it has counted the launch worker. An install can't pass its last check
    // just before a new launch starts, and a launch can't start after the installer has been chosen.
    pub installing: Mutex<bool>,
    pending: Mutex<Pending>,
}

pub fn state(app: &AppHandle) -> Status {
    app.state::<Updates>().pending.lock().status.clone()
}

fn publish(app: &AppHandle, status: &Status) {
    events::emit(app, Event::Update(status.clone()));
}

fn due(enabled: bool, last: u64, now: u64) -> bool {
    enabled && (last == 0 || now.saturating_sub(last) >= DAY)
}

fn busy(phase: Phase) -> bool {
    matches!(phase, Phase::Checking | Phase::Downloading | Phase::Ready | Phase::Installing)
}

/// Runs on a blocking thread; the plugin's HTTP work uses Tauri's async runtime. Manual checks ignore the switch.
pub fn check(app: &AppHandle, automatic: bool) -> Result<Option<String>> {
    let updates = app.state::<Updates>();
    {
        let mut pending = updates.pending.lock();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        let prefs = prefs::get(app);
        if automatic && (!due(prefs.check_updates, prefs.update_checked_at, now) || busy(pending.status.phase)) {
            return Ok(pending.status.version.clone());
        }
        if busy(pending.status.phase) {
            return Err(Error::Player("An update is already being checked or installed.".into()));
        }
        // Save attempts too: an offline PC mustn't make another automatic request on every restart.
        prefs::change(app, |p| p.update_checked_at = now)?;
        *pending = Pending { status: Status { phase: Phase::Checking, ..Status::default() }, ..Pending::default() };
        publish(app, &pending.status);
    }
    let found = tauri::async_runtime::block_on(async {
        app.updater_builder()
            .timeout(Duration::from_secs(30))
            // Tauri's /R passes --app back to the new exe. Our NSIS post-install hook starts the supervisor instead.
            .restart_after_install(false)
            .build()?
            .check()
            .await
    });
    let mut pending = updates.pending.lock();
    match found {
        Ok(update) => {
            let version = update.as_ref().map(|u| u.version.clone());
            pending.status = Status {
                phase: if update.is_some() { Phase::Available } else { Phase::Current },
                version: version.clone(),
                error: None,
            };
            pending.update = update;
            publish(app, &pending.status);
            Ok(version)
        }
        Err(error) => Err(failed(app, &mut pending, "Couldn't check for updates. Try again.", &error)),
    }
}

/// Only an explicit player action calls this. Download verifies the signature before anything becomes ready.
pub fn install(app: &AppHandle) -> Result<Status> {
    let updates = app.state::<Updates>();
    let update = {
        let mut pending = updates.pending.lock();
        if busy(pending.status.phase) {
            return Err(Error::Player("The update is already being prepared.".into()));
        }
        let mut update = pending.update.clone().ok_or_else(|| Error::Player("Check for an update first.".into()))?;
        update.timeout = Some(Duration::from_mins(5));
        pending.status.phase = Phase::Downloading;
        pending.status.error = None;
        publish(app, &pending.status);
        update
    };
    let downloaded = tauri::async_runtime::block_on(update.download(|_, _| {}, || {}));
    let mut pending = updates.pending.lock();
    match downloaded {
        Ok(bytes) => {
            pending.bytes = Some(bytes);
            pending.status.phase = Phase::Ready;
            publish(app, &pending.status);
            Ok(pending.status.clone())
        }
        Err(error) => Err(failed(app, &mut pending, "Couldn't download or verify the update. Try again.", &error)),
    }
}

fn failed(app: &AppHandle, pending: &mut Pending, message: &str, error: &tauri_plugin_updater::Error) -> Error {
    log::warn!("{message} {error}");
    pending.status.phase = Phase::Error;
    pending.status.error = Some(message.into());
    publish(app, &pending.status);
    Error::Player(message.into())
}

fn may_install(active: bool, running: bool, in_front: bool) -> bool {
    !active && !running && in_front
}

fn install_ready(app: &AppHandle) {
    // Installing ends Lamplit. Never in the middle of Restore Lamplit's changes, and no restore starts once the
    // installer has: the guard lives until the process exits, or until a failed install returns.
    let Some(_restore) = crate::system::restore::CHANGES.try_lock() else { return };
    let updates = app.state::<Updates>();
    let (update, bytes) = {
        let mut installing = updates.installing.lock();
        let mut pending = updates.pending.lock();
        if pending.status.phase != Phase::Ready {
            return;
        }
        let launcher = app.state::<Launcher>();
        if !may_install(launcher.active(), launcher.running_id().is_some(), window::lamplit_in_front()) {
            return;
        }
        let update = pending.update.clone().expect("a ready update has its release metadata");
        let bytes = pending.bytes.take().expect("a ready update has its verified bytes");
        *installing = true;
        pending.status.phase = Phase::Installing;
        publish(app, &pending.status);
        (update, bytes)
    };
    // On Windows the plugin starts NSIS and exits with code 0, so the old supervisor also exits. The install hook
    // ends any surviving supervisor before replacing the exe, then starts the new one after replacing the files.
    if let Err(error) = update.install(bytes) {
        let mut installing = updates.installing.lock();
        failed(app, &mut updates.pending.lock(), "Couldn't start the installer. Try again.", &error);
        *installing = false;
    }
}

/// One check after start, then only watches an update the player chose. No polling GitHub in the waiting loop.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let began = Instant::now();
        let mut checked = false;
        loop {
            install_ready(&app);
            if !checked && began.elapsed() >= Duration::from_secs(10) {
                checked = true;
                if let Err(error) = check(&app, true) {
                    log::warn!("automatic update check: {error}");
                }
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

#[derive(Serialize)]
pub struct News {
    version: String,
    highlights: Vec<String>,
}

/// The changelog is part of the exe. A fresh install and a version without three highlights show no card.
pub fn whats_new(app: &AppHandle) -> Result<Option<News>> {
    let version = env!("CARGO_PKG_VERSION");
    let previous = prefs::get(app).last_version_seen;
    if previous == version {
        return Ok(None);
    }
    prefs::change(app, |p| p.last_version_seen = version.into())?;
    Ok(news(&previous, version, include_str!("../../CHANGELOG.md")))
}

fn news(previous: &str, version: &str, changelog: &str) -> Option<News> {
    if previous.is_empty() || previous == version {
        return None;
    }
    let highlights = highlights(changelog, version);
    (highlights.len() == 3).then(|| News { version: version.into(), highlights })
}

fn highlights(changelog: &str, version: &str) -> Vec<String> {
    let mut in_version = false;
    let mut in_highlights = false;
    let mut result = Vec::new();
    for line in changelog.lines().map(str::trim) {
        if let Some(heading) = line.strip_prefix("## ") {
            if in_version {
                break;
            }
            in_version = heading.split_whitespace().next() == Some(version);
        } else if in_version && line.starts_with("### ") {
            if in_highlights {
                break;
            }
            in_highlights = line == "### Highlights";
        } else if in_highlights && !line.is_empty() {
            let Some(bullet) = line.strip_prefix("- ").filter(|s| !s.is_empty()) else { return Vec::new() };
            result.push(bullet.into());
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHANGELOG: &str = "# Changes\n## 0.4.1 - 2026-11-09\n### Highlights\n\n- Update from the sofa.\n- Return to your game.\n- Choose when to check.\n\n### Fixes\n- Not a highlight.\n## 0.4.0 - 2026-11-08\n- Older release.\n";

    #[test]
    fn highlights_are_only_the_three_bullets_of_this_version() {
        let card = news("0.4.0", "0.4.1", CHANGELOG).unwrap();
        assert_eq!(serde_json::to_value(card).unwrap(), ipc_fixture!("whats-new"));
        assert!(news("", "0.4.1", CHANGELOG).is_none());
        assert!(news("0.4.1", "0.4.1", CHANGELOG).is_none());
        assert!(news("0.3.0", "0.4.0", CHANGELOG).is_none());
        assert!(news("0.4.0", "0.4.1", &CHANGELOG.replace("- Return to your game.\n", "")).is_none());
        assert!(news("0.4.0", "0.4.1", &CHANGELOG.replace("### Fixes", "- Fourth.\n### Fixes")).is_none());
    }

    #[test]
    fn automatic_checks_are_opt_out_and_at_most_daily_even_after_failure() {
        assert!(due(true, 0, DAY));
        assert!(due(true, DAY, DAY * 2));
        assert!(!due(false, 0, DAY));
        assert!(!due(true, DAY, DAY * 2 - 1));
        assert!(!due(true, DAY, DAY - 1));
    }

    #[test]
    fn install_waits_for_both_the_game_and_the_foreground() {
        let mut permitted = Vec::new();
        for starting in [false, true] {
            for running in [false, true] {
                for in_front in [false, true] {
                    if may_install(starting, running, in_front) {
                        permitted.push((starting, running, in_front));
                    }
                }
            }
        }
        assert_eq!(permitted, [(false, false, true)]);
        assert!(busy(Phase::Ready));
        assert!(busy(Phase::Installing));
        assert!(!busy(Phase::Available));
    }

    #[test]
    fn payloads_match_the_page() {
        let status = Status { phase: Phase::Available, version: Some("0.4.1".into()), error: None };
        assert_eq!(serde_json::to_value(status).unwrap(), ipc_fixture!("update"));
        assert_eq!(
            serde_json::to_value(<Phase as strum::VariantArray>::VARIANTS).unwrap(),
            ipc_fixture!("values")["update_phase"]
        );
    }
}
