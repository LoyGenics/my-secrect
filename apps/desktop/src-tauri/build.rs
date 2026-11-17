fn main() {
    // Declaring an app ACL manifest makes Tauri check EVERY app command
    // against the capabilities (without it, app commands are allowed by
    // default). Only these two commands exist; `capabilities/default.json`
    // grants exactly `allow-kv-snapshot` and `allow-kv-commit`.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["kv_snapshot", "kv_commit"]),
        ),
    )
    .expect("failed to run tauri-build");
}
