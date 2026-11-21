fn main() {
    // Declaring an app ACL manifest makes Tauri check EVERY app command
    // against the capabilities (without it, app commands are allowed by
    // default). Only these four commands exist; `capabilities/default.json`
    // grants exactly `allow-kv-snapshot`, `allow-kv-commit`,
    // `allow-google-sign-in` and `allow-google-sign-in-cancel`.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["kv_snapshot", "kv_commit", "google_sign_in", "google_sign_in_cancel"]),
        ),
    )
    .expect("failed to run tauri-build");
}
