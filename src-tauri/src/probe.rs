// The frame probe (ui/probe.js), for measuring how smoothly the pages draw on a real PC. Only a build with debug
// assertions has it, such as the optimized measurement build (CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS=true): there
// every page is told so before its own scripts run, and main.js and dock/main.js then load the probe. A release build
// tells the pages nothing, so they never load it.

use tauri::{Builder, Wry};

/// What every page hears first in a build with debug assertions.
const SCRIPT: &str = "window.__LAMPLIT_PROBE__ = true;";

/// The app with the probe's script in a build with debug assertions, and as it was in any other.
pub fn with(app: Builder<Wry>) -> Builder<Wry> {
    if cfg!(debug_assertions) {
        app.plugin(tauri::plugin::Builder::<Wry>::new("probe").js_init_script(SCRIPT).build())
    } else {
        app
    }
}
