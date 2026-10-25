// Lamplit logs through the `log` crate into its data folder, one file per process so two processes never write or
// rotate the same file: the app writes lamplit.log through tauri-plugin-log (which also takes the page's lines), the
// supervisor and `--setup` write supervisor.log and setup.log through fern.

use crate::APP;
use crate::data::data_dir;
use log::{LevelFilter, Record};
use std::fmt::Arguments;
use tauri_plugin_log::fern::{self, FormatCallback};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};
use time::OffsetDateTime;
use time::macros::format_description;

/// The app's log: lamplit.log, plus the one before it once it reaches 2 MB.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let file = TargetKind::Folder { path: data_dir().clone(), file_name: Some(APP.into()) };
    let builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(file))
        .max_file_size(2_000_000)
        .rotation_strategy(RotationStrategy::KeepSome(1))
        .level(LevelFilter::Info)
        .format(format);
    // Debug builds also show the log in the terminal and in the page's devtools console.
    #[cfg(debug_assertions)]
    let builder = builder.target(Target::new(TargetKind::Stdout)).target(Target::new(TargetKind::Webview));
    builder.build()
}

/// Logs to `<name>.log` in the data folder, for the processes that run without Tauri.
pub fn to_file(name: &str) {
    let Ok(file) = fern::log_file(data_dir().join(format!("{name}.log"))) else { return };
    let _ = fern::Dispatch::new().level(LevelFilter::Info).format(format).chain(file).apply();
}

/// "2026-10-25 21:04:05.123 INFO  message". Lamplit's own lines name their subject in the message; lines from
/// libraries and from the page also show where they come from.
fn format(out: FormatCallback, message: &Arguments, record: &Record) {
    let now = OffsetDateTime::now_local().unwrap_or_else(|_| OffsetDateTime::now_utc());
    let stamp = now
        .format(format_description!("[year]-[month]-[day] [hour]:[minute]:[second].[subsecond digits:3]"))
        .unwrap_or_default();
    let (level, target) = (record.level(), record.target());
    if target.starts_with(APP) {
        out.finish(format_args!("{stamp} {level:<5} {message}"));
    } else {
        out.finish(format_args!("{stamp} {level:<5} [{target}] {message}"));
    }
}
