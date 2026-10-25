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
