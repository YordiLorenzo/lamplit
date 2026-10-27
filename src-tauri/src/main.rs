// Release builds have no console window; debug builds keep one for the log.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// lamplit.exe is three kinds of process: the supervisor (started at sign-in, it restarts the app after a crash),
// the app itself (`--app`), and first-time setup (`--setup`, elevated).

mod supervisor;

use std::process::ExitCode;

fn main() -> ExitCode {
    std::panic::set_hook(Box::new(|info| log::error!("panic: {info}")));
    if std::env::args().any(|a| a == lamplit_lib::SETUP_FLAG) {
        return setup();
    }
    if std::env::args().any(|a| a == supervisor::CHILD_FLAG) {
        // Ending with success also ends this process's supervisor.
        if !lamplit_lib::already_running("app") {
            lamplit_lib::run();
        }
        return ExitCode::SUCCESS;
    }
    lamplit_lib::log_to_file("supervisor");
    if lamplit_lib::already_running("supervisor") {
        log::info!("Lamplit is already running; brought it forward");
        return ExitCode::SUCCESS;
    }
    supervisor::run();
    ExitCode::SUCCESS
}

fn setup() -> ExitCode {
    lamplit_lib::log_to_file("setup");
    // Started from a terminal, the lines show there; started from Lamplit's settings, only in setup.log.
    lamplit_lib::attach_parent_console();
    let args: Vec<String> = std::env::args().collect();
    let for_user = args.iter().position(|a| a == lamplit_lib::SETUP_FOR_FLAG).and_then(|i| args.get(i + 1)).cloned();
    match lamplit_lib::setup(for_user) {
        Ok(done) => {
            for line in done {
                println!("{line}");
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            log::error!("setup failed: {e}");
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

    #[test]
    fn closing_the_home_window_closes_the_dock_too() {
        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        let main = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default()).build().unwrap();
        WebviewWindowBuilder::new(&app, lamplit_lib::DOCK_LABEL, WebviewUrl::default()).build().unwrap();
        // The mock runtime handles one message a second and ends once no window is left. A dock still open after a
        // few seconds would keep it going for good, so the test closes every window itself then, and fails.
        let left_open = Arc::new(AtomicBool::new(false));
        let (flag, mut seconds) = (left_open.clone(), 0);
        app.run_return(move |app, event| {
            // Only a running app hears that a window is about to close, as with Alt+F4.
            if let RunEvent::Ready = event {
                main.close().unwrap();
            }
            lamplit_lib::close_with_main(app, &event);
            if let RunEvent::MainEventsCleared = event {
                seconds += 1;
                if seconds == 4 {
                    flag.store(true, Ordering::SeqCst);
                    app.webview_windows().values().for_each(|w| drop(w.destroy()));
                }
            }
        });
        assert!(!left_open.load(Ordering::SeqCst), "the dock kept the app running after the home window closed");
    }
}
