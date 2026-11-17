//! my-secrect desktop entry point. Everything lives in `lib.rs` so the
//! storage layer and the e2e harness (`tests/e2e_app.rs`) share it.

// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    my_secrect_lib::run()
}
