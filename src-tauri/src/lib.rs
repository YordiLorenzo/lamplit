// Lamplit, a console-style home screen for Windows PCs on a TV. `run` starts the app; main.rs decides which of
// Lamplit's processes this one is (the supervisor, the app or first-time setup).

/// A payload's JSON as the page's tests use it (tests/ipc/<name>.json), for the tests that pin what Rust sends and
/// takes to the same shape. Read at build time: the test binary runs on a Windows PC that may not have the repository.
#[cfg(test)]
macro_rules! ipc_fixture {
    ($name:literal) => {
        serde_json::from_str::<serde_json::Value>(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../tests/ipc/",
            $name,
            ".json"
        )))
        .unwrap()
    };
}

// The features, one folder each.
mod devices;
mod dock;
mod launch;
mod library;
mod stores;
mod system;

// What the features share: the commands and events the page sees, errors, files, the data folder, the player's prefs
// and the log.
mod commands;
mod data;
mod error;
mod events;
mod files;
mod logging;
mod prefs;

// The calls into Windows, the one place with unsafe code.
#[allow(unsafe_code)]
mod win;

use std::ops::ControlFlow;
use std::time::Duration;
use tauri::Manager;

/// The name of the data folder, the logs, the logon tasks and the single-instance locks.
const APP: &str = env!("CARGO_PKG_NAME");
/// The main window's title (tauri.conf.json), which a second Lamplit finds the first one by.
const TITLE: &str = "Lamplit";

pub use error::Error;
// For main.rs's test of closing the home window: Tauri's window code needs Common Controls 6, which the app manifest
// asks for, and only the exe's test binary carries that manifest.
pub use dock::{LABEL as DOCK_LABEL, on_close_request};
pub use logging::to_file as log_to_file;
pub use system::setup::{FLAG as SETUP_FLAG, FOR_FLAG as SETUP_FOR_FLAG, run as setup};
pub use win::process::attach_parent_console;

/// True when another Lamplit already runs (the one started at sign-in, say, when the player starts a second by hand);
/// that one is brought forward. Otherwise this process holds the claim for as long as it runs. The supervisor and the
/// app each claim their own `part`: the supervisor can end on its own (from Task Manager) while the app runs on, and
/// a second app would open the controllers and the headset's receiver beside the first.
#[must_use]
pub fn already_running(part: &str) -> bool {
    match win::process::claim(&format!("Local\\{APP}-{part}")) {
        Ok(true) => return false,
        Ok(false) => {}
        // A Lamplit started as administrator holds a lock that a normal start may not open.
        Err(e) => log::warn!("can't open the single-instance lock, so another Lamplit holds it: {e}"),
    }
    if let Some(window) = first_lamplit_window() {
        win::window::restore(window);
    }
    true
}

/// The running Lamplit's window: titled TITLE, and run from this same exe. A title alone could also be an Explorer
/// window open on Lamplit's folder.
fn first_lamplit_window() -> Option<win::window::HWND> {
    let exe = files::folder_key(&std::env::current_exe().ok()?);
    let mut found = None;
    win::window::for_each_window(|w| {
        let same_exe =
            || win::process::exe_path(win::window::process_id(w)).is_some_and(|p| files::folder_key(&p) == exe);
        if win::window::title(w) == TITLE && same_exe() {
            found = Some(w);
            return ControlFlow::Break(());
        }
        ControlFlow::Continue(())
    });
    found
}

/// Starts the app: its window, the threads that watch controllers, the headset and Steam, and the commands the page
/// calls. Returns when the window closes.
///
/// # Panics
///
/// When Tauri can't start (WebView2 missing, for one).
pub fn run() {
    tauri::Builder::default()
        .plugin(logging::plugin())
        .manage(library::Library::default())
        .manage(launch::Launcher::default())
        .manage(devices::pad::Controllers::default())
        .invoke_handler(tauri::generate_handler![
            commands::library_games,
            commands::library_rescan,
            commands::library_set_favourite,
            commands::library_set_hidden,
            commands::library_art_search,
            commands::library_set_art,
            commands::library_programs,
            commands::library_browse,
            commands::library_add_game,
            commands::library_remove_game,
            commands::launch_start,
            commands::launch_anyway,
            commands::launch_cancel,
            commands::launch_show,
            commands::launch_resume,
            commands::launch_running,
            commands::stores_status,
            commands::stores_open,
            commands::overlay_state,
            commands::overlay_toggle_stats,
            commands::quiet_state,
            commands::quiet_set,
            commands::setup_state,
            commands::setup_start,
            commands::sound_state,
            commands::sound_set_default,
            commands::sound_change_volume,
            commands::sound_set_mute,
            commands::accessories_state,
            commands::headset_set,
            commands::controller_turn_off,
            commands::controller_kind,
            commands::prefs_state,
            commands::prefs_set_sound_follows,
            commands::prefs_set_touchpad_mouse,
            commands::prefs_set_steam_devtools,
            commands::prefs_set_online_art,
            commands::prefs_set_screensaver_minutes,
            commands::prefs_set_screensaver_style,
            commands::prefs_set_dock,
            commands::power_sleep,
            commands::power_restart,
            commands::power_shut_down,
            commands::display_mode,
            commands::dock_state,
            commands::dock_resume,
            commands::dock_home,
            commands::dock_glass,
            commands::dock_close_game,
        ])
        .setup(|app| {
            log::info!("Lamplit {} starting", env!("CARGO_PKG_VERSION"));
            launch::window::remember_lamplit(app.handle())?;
            app.manage(prefs::load());
            app.manage(library::UserData::load());
            library::scan(app.handle());
            // The headset before the controllers: a controller's thread reads the headset's state.
            devices::headset::start(app.handle().clone());
            devices::pad::start(app.handle().clone());
            dock::start(app.handle());
            upkeep(app.handle().clone());
            stores::steam::guard_big_picture();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Lamplit failed to start")
        .run(|app, event| {
            if dock::on_close_request(app, &event) {
                dock::fold(app, true);
            }
        });
}

/// Every 10 s: Steam kept in line whenever it runs, and quiet-mode changes that had to wait (for Steam to start, or
/// for Ubisoft Connect to close). Both are a refused localhost connection or a small file read when there is
/// nothing to do.
fn upkeep(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut steam = stores::steam::devtools::Upkeep::default();
        loop {
            stores::steam::devtools::upkeep(&mut steam, || prefs::get(&app).steam_devtools);
            system::quiet::catch_up();
            std::thread::sleep(Duration::from_secs(10));
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_window_has_the_title_a_second_lamplit_looks_for() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["app"]["windows"][0]["title"], super::TITLE);
    }
}
