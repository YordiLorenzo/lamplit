// Steam's settings, changed the way its own settings page does it: through `SteamClient.Settings.SetSetting` in
// Steam's browser. That needs Steam's DevTools port, which Steam opens when started with `-cef-enable-debugging` or
// when the file `.cef-enable-remote-debugging` is in its folder (also when Steam starts by itself). Any program on
// the PC can control Steam through that port while it is open, so Lamplit opens it both ways only while the player
// has switched that on in Settings (`Prefs::steam_devtools`). A port the player opened some other way is used too.

use super::settings::{self, GUIDE_BUTTON_FOCUSES_STEAM};
use crate::data;
use crate::error::{Error, Result};
use crate::files::write_atomic;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
use std::path::PathBuf;
use std::time::Duration;
use tungstenite::Message;

const PORT: SocketAddr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 8080));

/// The WebSocket address of Steam's SharedJSContext; a new one each time Steam starts.
fn shared_context() -> Result<String> {
    let targets: Value = ureq::get(format!("http://{PORT}/json"))
        .config()
        .timeout_global(Some(Duration::from_secs(3)))
        // A proxy set in the environment would get this request instead of Steam: it makes no exception for loopback.
        .proxy(None)
        .build()
        .call()
        .and_then(|mut r| r.body_mut().read_json())
        .map_err(|e| Error::Internal(format!("Steam's DevTools port isn't open ({e})")))?;
    targets
        .as_array()
        .and_then(|t| t.iter().find(|t| t["title"] == "SharedJSContext"))
        .and_then(|t| t["webSocketDebuggerUrl"].as_str())
        .map(String::from)
        .ok_or_else(|| Error::Internal("Steam's SharedJSContext isn't there yet".into()))
}

/// Runs JavaScript in Steam's SharedJSContext and returns its value.
fn evaluate(expression: &str) -> Result<Value> {
    let url = shared_context()?;
    // Deadlines go on the socket before the WebSocket handshake, so a port that stops answering can't hang Lamplit.
    let tcp = TcpStream::connect_timeout(&PORT, Duration::from_secs(3))?;
    tcp.set_read_timeout(Some(Duration::from_secs(5)))?;
    tcp.set_write_timeout(Some(Duration::from_secs(5)))?;
    let (mut socket, _) = tungstenite::client(url.as_str(), tcp)
        .map_err(|e| Error::Internal(format!("Steam's DevTools refused the connection: {e}")))?;
    let request =
        json!({ "id": 1, "method": "Runtime.evaluate", "params": { "expression": expression, "returnByValue": true } });
    socket.send(Message::text(request.to_string()))?;
    loop {
        let Message::Text(text) = socket.read()? else { continue };
        let v: Value = serde_json::from_str(&text)?;
        if v["id"] != 1 {
            continue;
        }
        let _ = socket.close(None);
        if let Some(error) = v.get("error") {
            return Err(Error::Internal(format!("DevTools refused it: {error}")));
        }
        // A script that throws still answers, with exceptionDetails instead of a value.
        if let Some(e) = v["result"].get("exceptionDetails") {
            let what = e["exception"]["description"].as_str().or(e["text"].as_str()).unwrap_or("an error");
            return Err(Error::Internal(format!("Steam's script failed: {what}")));
        }
        return Ok(v["result"]["result"]["value"].clone());
    }
}

/// Current values of client settings, by their names in Steam's settings store.
pub fn read_settings(names: &[&str]) -> Result<Vec<Option<bool>>> {
    let list = serde_json::to_string(names)?;
    let v = evaluate(&format!(
        "(function(){{var s=settingsStore.m_ClientSettings;return {list}.map(function(k){{return s[k];}});}})()"
    ))?;
    let Some(values) = v.as_array().filter(|a| a.len() == names.len()) else {
        return Err(Error::Internal("Steam's settings store answered something else".into()));
    };
    Ok(values.iter().map(Value::as_bool).collect())
}

/// Hands the settings to Steam. A script error comes back as an Err; SetSetting's own answer isn't read.
pub fn write_settings(fields: &[(u32, bool)]) -> Result<()> {
    evaluate(&format!("void SteamClient.Settings.SetSetting('{}')", settings::message(fields)))?;
    Ok(())
}

/// What `upkeep` has done for the Steam that runs now.
#[derive(Default)]
pub struct Upkeep {
    /// The last failure, logged once rather than on every round.
    failure: Option<String>,
}

/// Called every 10 seconds: while the Guide button pref is on, the PS button stops opening Big
/// Picture. Steam's settings only answer once it is up and signed in, so a failed try is made again next time. While
/// the port is closed and the player lets Lamplit open it (`open_port`, the pref), it is opened for Steam's next start.
pub fn upkeep(state: &mut Upkeep, open_port: bool, guide: bool) {
    // The caller holds restore::CHANGES, so these prefs cannot change during an upkeep pass.
    let outcome = match shared_context() {
        Ok(_) if !guide => Ok(()),
        Ok(_) => guide_button_off().map_err(|e| format!("couldn't check the PS button setting yet: {e}")),
        Err(_) => {
            if open_port {
                set_flag(true).map_err(|e| format!("couldn't open its DevTools port: {e}"))
            } else {
                Ok(())
            }
        }
    };
    let failure = outcome.err();
    if let Some(f) = failure.as_ref().filter(|f| state.failure.as_ref() != Some(f)) {
        log::info!("steam: {f}");
    }
    state.failure = failure;
}

/// The PS button opens Big Picture while this is on (Steam's default).
fn guide_button_off() -> Result<()> {
    let before = read_settings(&[GUIDE_BUTTON_FOCUSES_STEAM.name])?[0].unwrap_or(true);
    if !before {
        return Ok(());
    }
    let mut saved = saved()?;
    if saved.guide.is_none() {
        saved.guide = Some(before);
        data::save(RECORD_FILE, &saved)?;
    }
    write_settings(&[(GUIDE_BUTTON_FOCUSES_STEAM.field, false)])?;
    log::info!("steam: the PS button no longer focuses Steam");
    Ok(())
}

/// Steam opens its DevTools port whenever this file is in its folder, also when it starts by itself at sign-in, which
/// Lamplit's start flag doesn't cover. Steam lets the player write to its folder.
fn flag_file() -> Option<PathBuf> {
    super::path().filter(|p| p.join("steam.exe").is_file()).map(|dir| dir.join(".cef-enable-remote-debugging"))
}

/// The Settings switch: Steam's next start opens its port (`open`) or doesn't, then `save` stores the pref. When the
/// flag file can't change, the pref isn't saved, so the switch never says Off while the port still opens. A Steam that
/// runs now keeps its port as it is until it restarts.
pub fn open_from_next_start(open: bool, save: impl FnOnce() -> Result<()>) -> Result<()> {
    if open {
        resume_changes()?;
    }
    set_flag(open)?;
    save()
}

/// Puts the flag file in Steam's folder (`open`) or takes it away.
fn set_flag(open: bool) -> Result<()> {
    let Some(flag) = flag_file() else { return Ok(()) };
    let before = read_flag(&flag)?;
    if open == before.is_some() {
        return Ok(());
    }
    let mut saved = saved()?;
    if let std::collections::btree_map::Entry::Vacant(entry) = saved.flags.entry(flag.clone()) {
        entry.insert(before);
        data::save(RECORD_FILE, &saved)?;
    }
    if open {
        // create_new cannot truncate a flag another program created after the read.
        std::fs::OpenOptions::new().write(true).create_new(true).open(&flag)?;
        log::info!("steam: its DevTools port opens from its next start ({})", flag.display());
    } else {
        std::fs::remove_file(&flag)?;
        log::info!("steam: its DevTools port stays closed from its next start");
    }
    Ok(())
}

const RECORD_FILE: &str = "steam-saved.json";

#[derive(Default, Serialize, Deserialize)]
struct Saved {
    guide: Option<bool>,
    /// The full path keeps a flag recoverable even when Steam moves before restoration.
    flags: BTreeMap<PathBuf, Option<Vec<u8>>>,
    /// A 0.3 pref says Lamplit opened the port, but that release didn't save the flag's previous state.
    unrecorded_flag: Option<PathBuf>,
    restoring: bool,
}

fn saved() -> Result<Saved> {
    Ok(data::load(RECORD_FILE)?.unwrap_or_default())
}

fn read_flag(flag: &std::path::Path) -> Result<Option<Vec<u8>>> {
    match std::fs::read(flag) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Starts a persistent restore. Old releases did not record the Guide setting or the flag's original contents.
pub fn begin_restore(opened_port: bool) -> Result<()> {
    let mut saved = saved()?;
    if opened_port
        && let Some(flag) = flag_file()
        && !saved.flags.contains_key(&flag)
        && read_flag(&flag)?.is_some()
    {
        saved.unrecorded_flag = Some(flag);
    }
    saved.restoring = true;
    data::save(RECORD_FILE, &saved)
}

/// An explicit opt-in supersedes a pending restore, but its originals remain available for the next restore.
pub fn resume_changes() -> Result<()> {
    let Some(mut saved): Option<Saved> = data::load(RECORD_FILE)? else { return Ok(()) };
    saved.restoring = false;
    data::save(RECORD_FILE, &saved)
}

pub fn restoring() -> Result<bool> {
    Ok(saved()?.restoring)
}

fn keep_or_remove(saved: &Saved) -> Result<()> {
    if saved.guide.is_none() && saved.flags.is_empty() && saved.unrecorded_flag.is_none() {
        match data::remove(RECORD_FILE) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    } else {
        data::save(RECORD_FILE, saved)
    }
}

/// Leaves the original recorded until Steam has answered with the restored value.
pub fn restore_guide() -> Result<String> {
    let mut saved = saved()?;
    let Some(before) = saved.guide else {
        return Ok("No saved change. Earlier versions did not save this setting; check Guide Button Focuses Steam in Steam's Controller settings.".into());
    };
    let restore = || -> Result<()> {
        write_settings(&[(GUIDE_BUTTON_FOCUSES_STEAM.field, before)])?;
        if read_settings(&[GUIDE_BUTTON_FOCUSES_STEAM.name])?[0].unwrap_or(true) != before {
            return Err(Error::Internal("Steam hasn't applied its Guide button setting yet".into()));
        }
        Ok(())
    };
    if let Err(e) = restore() {
        log::warn!("Steam Guide button restore: {e}");
        return Err(Error::Player(restore_note()));
    }
    saved.guide = None;
    // Keep the restore marker until the port has had its turn too.
    data::save(RECORD_FILE, &saved)?;
    Ok("Guide button setting restored.".into())
}

/// The flag waits until Steam's settings are restored, so its next start can still finish the restore.
pub fn restore_port(steam_toasts_pending: bool) -> Result<String> {
    let mut saved = saved()?;
    if steam_toasts_pending || saved.guide.is_some() {
        return Err(Error::Player(
            "Restore Steam's settings first. Its DevTools flag is kept until they are back.".into(),
        ));
    }
    let mut failures = Vec::new();
    if let Some(flag) = &saved.unrecorded_flag {
        if read_flag(flag)?.is_some() {
            failures.push("An earlier Lamplit version did not save the DevTools flag's original state. If Lamplit created .cef-enable-remote-debugging in Steam's folder, delete it, then try again.".into());
        } else {
            saved.unrecorded_flag = None;
        }
    }
    failures.extend(restore_flags(&mut saved.flags));
    keep_or_remove(&saved)?;
    if !failures.is_empty() {
        return Err(Error::Player(failures.join(" ")));
    }
    Ok("DevTools flag restored. Restart Steam to apply it.".into())
}

/// A failed write must retain that file's original, even when other files are restored successfully.
fn restore_flags(flags: &mut BTreeMap<PathBuf, Option<Vec<u8>>>) -> Vec<String> {
    let mut failures = Vec::new();
    flags.retain(|flag, before| {
        let result = match before {
            Some(bytes) => write_atomic(flag, bytes),
            None => {
                std::fs::remove_file(flag).or_else(|e| if e.kind() == ErrorKind::NotFound { Ok(()) } else { Err(e) })
            }
        };
        if let Err(e) = result {
            failures.push(format!("Couldn't restore {}: {e}", flag.display()));
            true
        } else {
            false
        }
    });
    failures
}

pub fn restore_note() -> String {
    if super::running() {
        "Steam must be signed in with its DevTools port open. Restart Steam with -cef-enable-debugging, then try again."
            .into()
    } else {
        "Open Steam with its DevTools port, then try again.".into()
    }
}

/// For the player when Steam runs with its port closed, so its settings can't change: what opens it.
pub fn closed_port_note() -> Option<String> {
    if shared_context().is_ok() || !super::running() {
        return None;
    }
    Some(if flag_file().is_some_and(|f| f.exists()) {
        "Steam's pop-up settings change once Steam restarts and opens its DevTools port.".into()
    } else {
        "Steam's pop-ups need Steam's DevTools port: switch it on under Stores, then restart Steam.".into()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn original_guide_and_flag_contents_survive_a_pending_restore() {
        let file = PathBuf::from(r"C:\Steam\.cef-enable-remote-debugging");
        for before in [None, Some(Vec::new()), Some(b"player's flag".to_vec())] {
            let saved = Saved {
                guide: Some(true),
                flags: BTreeMap::from([(file.clone(), before.clone())]),
                restoring: true,
                ..Saved::default()
            };
            let restored: Saved = serde_json::from_slice(&serde_json::to_vec(&saved).unwrap()).unwrap();
            assert_eq!(restored.guide, Some(true));
            assert_eq!(restored.flags.get(&file), Some(&before));
            assert!(restored.restoring);
        }
        assert!(serde_json::from_str::<Saved>("broken").is_err());
    }

    #[test]
    fn restores_flag_bytes_and_absence_but_keeps_failed_originals() {
        let dir = std::env::temp_dir().join(format!("lamplit-test-steam-restore-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (removed, kept, blocked) = (dir.join("removed"), dir.join("kept"), dir.join("blocked"));
        std::fs::write(&removed, []).unwrap();
        // A directory at a file's path is a real failed write, not a mocked success.
        std::fs::create_dir_all(&blocked).unwrap();
        let mut flags = BTreeMap::from([
            (removed.clone(), None),
            (kept.clone(), Some(b"original".to_vec())),
            (blocked.clone(), Some(b"still needed".to_vec())),
        ]);
        let failures = restore_flags(&mut flags);
        assert!(!removed.exists());
        assert_eq!(std::fs::read(&kept).unwrap(), b"original");
        assert_eq!(failures.len(), 1);
        assert_eq!(flags, BTreeMap::from([(blocked.clone(), Some(b"still needed".to_vec()))]));
        std::fs::remove_dir(&blocked).unwrap();
        assert!(restore_flags(&mut flags).is_empty());
        assert!(flags.is_empty());
        assert_eq!(std::fs::read(&blocked).unwrap(), b"still needed");
        std::fs::remove_file(kept).unwrap();
        std::fs::remove_file(blocked).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
