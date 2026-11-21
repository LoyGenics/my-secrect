fn main() {
    // Declaring an app ACL manifest makes Tauri check EVERY app command
    // against the capabilities (without it, app commands are allowed by
    // default). Only these three commands exist; `capabilities/default.json`
    // grants exactly `allow-kv-snapshot`, `allow-kv-commit` and
    // `allow-google-sign-in`.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["kv_snapshot", "kv_commit", "google_sign_in"]),
        ),
    )
    .expect("failed to run tauri-build");
}
