// Steam's settings, changed the way its own settings page does it: through `SteamClient.Settings.SetSetting` in
// Steam's browser. That needs Steam's DevTools port, which Steam opens when started with `-cef-enable-debugging` or
// when the file `.cef-enable-remote-debugging` is in its folder (also when Steam starts by itself). Any program on
// the PC can control Steam through that port while it is open, so Lamplit opens it both ways only while the player
// has switched that on in Settings (`Prefs::steam_devtools`). A port the player opened some other way is used too.

use super::settings::{self, GUIDE_BUTTON_FOCUSES_STEAM};
use crate::error::{Error, Result};
use parking_lot::Mutex;
use serde_json::{Value, json};
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
    /// The Steam session whose PS button setting is checked.
    session: Option<String>,
    /// The last failure, logged once rather than on every round.
    failure: Option<String>,
}

/// The flag file (see `flag_file`) follows the pref: the Settings switch changes both, and upkeep puts the file back
/// while the pref is on. Both hold this lock, so upkeep can't put the file back between the switch taking it away and
/// saving Off.
static FLAG: Mutex<()> = Mutex::new(());

/// Called every 10 seconds: once per Steam session, however Steam was started, the PS button stops opening Big
/// Picture. Steam's settings only answer once it is up and signed in, so a failed try is made again next time. While
/// the port is closed and the player lets Lamplit open it (`open_port`, the pref), it is opened for Steam's next start.
pub fn upkeep(state: &mut Upkeep, open_port: impl Fn() -> bool) {
    let outcome = match shared_context() {
        Ok(session) if state.session.as_ref() == Some(&session) => return,
        Ok(session) => guide_button_off()
            .map(|()| state.session = Some(session))
            .map_err(|e| format!("couldn't check the PS button setting yet: {e}")),
        Err(_) => {
            // The pref is read only now, under the lock: the probe above can take seconds, and the Settings switch
            // may have turned the port off meanwhile.
            let _flag = FLAG.lock();
            if open_port() {
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
    if read_settings(&[GUIDE_BUTTON_FOCUSES_STEAM.name])?.first() == Some(&Some(false)) {
        return Ok(());
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
    let _flag = FLAG.lock();
    set_flag(open)?;
    save()
}

/// Puts the flag file in Steam's folder (`open`) or takes it away.
fn set_flag(open: bool) -> std::io::Result<()> {
    let Some(flag) = flag_file() else { return Ok(()) };
    if open && !flag.exists() {
        std::fs::File::create(&flag)?;
        log::info!("steam: its DevTools port opens from its next start ({})", flag.display());
    } else if !open && flag.exists() {
        std::fs::remove_file(&flag)?;
        log::info!("steam: its DevTools port stays closed from its next start");
    }
    Ok(())
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
