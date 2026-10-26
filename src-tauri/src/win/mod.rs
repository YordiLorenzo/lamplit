// Every call into Windows that Rust can't check (Win32 functions and COM interfaces) sits here, behind a safe
// function. This is the only module allowed `unsafe` code, and each unsafe block says why it is sound.

pub mod audio;
pub mod bluetooth;
mod com;
pub mod display;
pub mod drives;
pub mod input;
pub mod power;
pub mod process;
pub mod region;
pub mod shell;
pub mod task;
pub mod token;
pub mod trust;
pub mod window;
