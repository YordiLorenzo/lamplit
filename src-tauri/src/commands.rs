// The commands the page calls, named <area>_<action>. Each one hands over to the module that does the work.
//
// A plain command runs on the main thread, where waiting freezes the window and controller navigation. So any
// command that touches the disk, the registry, COM, HID, a socket or the process list is async and does its work
// in `blocking`, on Tauri's thread pool for blocking work.

use crate::devices::headset::{self, Headset};
use crate::devices::pad::{self, Controllers};
use crate::devices::{accessories, audio};
use crate::dock;
use crate::error::{Error, Result};
use crate::launch::{self, Launcher};
use crate::library::{self, ArtChoice, Game, Library};
use crate::prefs::{self, Prefs, ScreensaverStyle};
use crate::stores::steam::devtools;
use crate::stores::{self, Store};
use crate::system::{overlay, power, quiet, setup};
use crate::win;
use tauri::{AppHandle, Manager, State};

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T> {
    Ok(tauri::async_runtime::spawn_blocking(work).await?)
}

/// None until the first scan has finished.
#[tauri::command]
pub fn library_games(library: State<Library>) -> Option<Vec<Game>> {
    library.games()
}

#[tauri::command]
pub fn library_rescan(app: AppHandle) {
    library::rescan(&app);
}

/// Returns every game, with the change.
#[tauri::command]
pub async fn library_set_favourite(app: AppHandle, id: String, on: bool) -> Result<Vec<Game>> {
    blocking(move || library::set_favourite(&app, &id, on)).await?
}

/// Returns every game, with the change.
#[tauri::command]
pub async fn library_set_hidden(app: AppHandle, id: String, on: bool) -> Result<Vec<Game>> {
    blocking(move || library::set_hidden(&app, &id, on)).await?
}

/// What Steam's store has for `query`, for Change art. Goes online.
#[tauri::command]
pub async fn library_art_search(app: AppHandle, query: String) -> Result<Vec<library::Candidate>> {
    blocking(move || library::art_candidates(&app, &query)).await?
}

/// The art the player chose for a game; None for Lamplit's own match. Returns every game, with the change.
#[tauri::command]
pub async fn library_set_art(app: AppHandle, id: String, choice: Option<ArtChoice>) -> Result<Vec<Game>> {
    blocking(move || library::set_art(&app, &id, choice)).await?
}

/// The installed programs that aren't in the library, for Add a game.
#[tauri::command]
pub async fn library_programs(app: AppHandle) -> Result<Vec<library::Program>> {
    blocking(move || library::programs(&app)).await
}

/// A folder's subfolders and exes, or the drives with no path, for Add a game.
#[tauri::command]
pub async fn library_browse(path: Option<String>) -> Result<library::Folder> {
    blocking(move || library::browse(path.as_deref())).await?
}

/// Adds the game an exe starts, with the name the player gave it. Returns its id and every game.
#[tauri::command]
pub async fn library_add_game(app: AppHandle, exe: String, name: String) -> Result<library::Added> {
    blocking(move || library::add_game(&app, &exe, &name)).await?
}

/// Takes a game added by hand out of the library. Returns every game.
#[tauri::command]
pub async fn library_remove_game(app: AppHandle, id: String) -> Result<Vec<Game>> {
    blocking(move || library::remove_game(&app, &id)).await?
}

/// Starts the launch checks; the page follows them through `launch-step` and `play` events.
#[tauri::command]
pub fn launch_start(app: AppHandle, library: State<Library>, id: String) -> Result<()> {
    // The page's list can be older than the last scan, which may have dropped the game.
    let game = library.game(&id).ok_or_else(|| Error::Player("That game isn't installed any more.".into()))?;
    launch::start(&app, game);
    Ok(())
}

#[tauri::command]
pub fn launch_anyway(launcher: State<Launcher>) {
    launcher.go_anyway();
}

#[tauri::command]
pub fn launch_cancel(app: AppHandle, launcher: State<Launcher>) {
    launcher.cancel(&app);
}

/// Shows the player what the launch may be waiting for: a window that opened, else the store app `store`.
#[tauri::command]
pub async fn launch_show(app: AppHandle, store: Option<Store>) -> Result<()> {
    blocking(move || launch::show_waiting(&app, store)).await?
}

#[tauri::command]
pub async fn launch_resume(app: AppHandle) -> Result<()> {
    blocking(move || launch::resume(&app)).await
}

#[tauri::command]
pub fn launch_running(launcher: State<Launcher>) -> Option<String> {
    launcher.running_id()
}

#[tauri::command]
pub async fn stores_status() -> Result<Vec<stores::Status>> {
    blocking(stores::status_all).await
}

/// Shows a store app so the player can sign in or deal with an update.
#[tauri::command]
pub async fn stores_open(app: AppHandle, store: Store) -> Result<()> {
    blocking(move || launch::show_store(&app, store).inspect_err(|e| log::warn!("can't show {}: {e}", store.name())))
        .await?
}

#[tauri::command]
pub async fn overlay_state() -> Result<overlay::Overlays> {
    blocking(overlay::state).await
}

#[tauri::command]
pub async fn overlay_toggle_stats() -> Result<Option<bool>> {
    blocking(|| overlay::toggle_nvidia_stats().inspect(|on| log::info!("NVIDIA statistics overlay now {on:?}"))).await?
}

#[tauri::command]
pub async fn quiet_state() -> Result<quiet::Report> {
    blocking(quiet::state).await
}

#[tauri::command]
pub async fn quiet_set(on: bool) -> Result<quiet::Report> {
    blocking(move || quiet::set(on)).await
}

#[tauri::command]
pub async fn setup_state() -> Result<setup::Status> {
    blocking(setup::status).await
}

/// Asks Windows for admin rights once and runs setup in a second lamplit.exe, and returns once the prompt is
/// answered; a `setup` event follows when that process ends.
#[tauri::command]
pub async fn setup_start(app: AppHandle) -> Result<()> {
    blocking(move || setup::start_elevated(app)).await?
}

#[tauri::command]
pub async fn sound_state() -> Result<audio::Sound> {
    blocking(audio::state).await?
}

/// Makes `id` the default output or microphone, and returns the sound state that follows.
#[tauri::command]
pub async fn sound_set_default(id: String) -> Result<audio::Sound> {
    blocking(move || {
        audio::set_default(&id).inspect_err(|e| log::warn!("can't switch audio to {id}: {e}"))?;
        log::info!("audio device switched to {id}");
        audio::state()
    })
    .await?
}

/// Returns the new volume.
#[tauri::command]
pub async fn sound_change_volume(delta: i32) -> Result<u32> {
    blocking(move || audio::nudge_volume(delta)).await?
}

#[tauri::command]
pub async fn sound_set_mute(mic: bool, muted: bool) -> Result<()> {
    blocking(move || audio::set_mute(mic, muted)).await?
}

#[tauri::command]
pub fn accessories_state(app: AppHandle) -> accessories::Accessories {
    accessories::state(&app)
}

/// Waits for the headset to take the setting, and returns what it reads back.
#[tauri::command]
pub async fn headset_set(app: AppHandle, setting: headset::Setting, value: u8) -> Result<headset::Status> {
    blocking(move || {
        let headset = app.state::<Headset>();
        headset.change(setting, value)?;
        Ok(headset.status())
    })
    .await?
}

#[tauri::command]
pub async fn controller_turn_off(app: AppHandle, id: String) -> Result<()> {
    blocking(move || {
        app.state::<Controllers>().turn_off(&id)?;
        log::info!("controller turned off: {id}");
        Ok(())
    })
    .await?
}

/// The kind of controller used last, None before any was; `pad-kind` events follow when it changes.
#[tauri::command]
pub fn controller_kind() -> Option<pad::Kind> {
    pad::last_kind()
}

#[tauri::command]
pub fn prefs_state(app: AppHandle) -> Prefs {
    prefs::get(&app)
}

// Each change returns the prefs that follow.

#[tauri::command]
pub async fn prefs_set_sound_follows(app: AppHandle, on: bool) -> Result<Prefs> {
    blocking(move || accessories::set_sound_follows(&app, on).map(|()| prefs::get(&app))).await?
}

#[tauri::command]
pub async fn prefs_set_touchpad_mouse(app: AppHandle, on: bool) -> Result<Prefs> {
    blocking(move || accessories::set_touchpad_mouse(&app, on).map(|()| prefs::get(&app))).await?
}

/// Steam opens its DevTools port from its next start, or doesn't.
#[tauri::command]
pub async fn prefs_set_steam_devtools(app: AppHandle, on: bool) -> Result<Prefs> {
    blocking(move || {
        devtools::open_from_next_start(on, || prefs::change(&app, |p| p.steam_devtools = on))?;
        Ok(prefs::get(&app))
    })
    .await?
}

#[tauri::command]
pub async fn prefs_set_online_art(app: AppHandle, on: bool) -> Result<Prefs> {
    blocking(move || library::set_online_art(&app, on).map(|()| prefs::get(&app))).await?
}

/// Minutes without input before the screensaver, 0 for never. The page reads the prefs again, so nothing else follows.
#[tauri::command]
pub async fn prefs_set_screensaver_minutes(app: AppHandle, minutes: u32) -> Result<Prefs> {
    blocking(move || prefs::change(&app, |p| p.screensaver_minutes = minutes).map(|()| prefs::get(&app))).await?
}

#[tauri::command]
pub async fn prefs_set_screensaver_style(app: AppHandle, style: ScreensaverStyle) -> Result<Prefs> {
    blocking(move || prefs::change(&app, |p| p.screensaver_style = style).map(|()| prefs::get(&app))).await?
}

/// The dock is switched on or off: off, holding PS over a game brings the home screen.
#[tauri::command]
pub async fn prefs_set_dock(app: AppHandle, on: bool) -> Result<Prefs> {
    blocking(move || dock::set_on(&app, on).map(|()| prefs::get(&app))).await?
}

/// The game the dock is over, None when none runs. Reads every process.
#[tauri::command]
pub async fn dock_state(app: AppHandle) -> Result<Option<dock::GameState>> {
    blocking(move || dock::game_state(&app)).await
}

/// Folds the dock away, back to the game.
#[tauri::command]
pub fn dock_resume(app: AppHandle) {
    dock::fold(&app, true);
}

/// The home screen, in place of the dock.
#[tauri::command]
pub fn dock_home(app: AppHandle) {
    launch::window::summon(&app);
}

/// Asks the running game to close, or with `force` ends it.
#[tauri::command]
pub async fn dock_close_game(app: AppHandle, force: bool) -> Result<()> {
    blocking(move || dock::close_game(&app, force)).await?
}

/// Returns once the PC has woken up again.
#[tauri::command]
pub async fn power_sleep() -> Result<()> {
    blocking(power::sleep).await?
}

/// Returns once Windows has started to restart.
#[tauri::command]
pub async fn power_restart() -> Result<()> {
    blocking(power::restart).await?
}

/// Returns once Windows has started to shut down.
#[tauri::command]
pub async fn power_shut_down() -> Result<()> {
    blocking(power::shut_down).await?
}

/// The screen's mode now, e.g. "3840 × 2160 at 120 Hz".
#[tauri::command]
pub fn display_mode() -> Option<String> {
    win::display::current_mode().map(|m| format!("{} × {} at {} Hz", m.width, m.height, m.hz))
}
