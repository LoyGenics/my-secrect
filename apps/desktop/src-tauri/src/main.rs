//! my-secrect desktop shell (Tauri v2 + the React app in `apps/desktop/src/`).
//!
//! Status (Phase F, 17 Nov 2026): scaffold only. This file has NEVER been
//! compiled or run on the Mac — no `cargo tauri build` has executed here.
//! It is written to be minimal and buildable in principle (see README.md
//! for the exact Terminal commands and the icons step that must run first).
//!
//! What this shell does today:
//! - Opens the Vite frontend (dev server on <http://localhost:1420>,
//!   production build from `../dist`).
//! - Exposes three read-only commands. They return paths / the version and
//!   touch NO vault data, NO keys, and NO plaintext. They exist so the
//!   future SQLCipher store (see `vault_database_path`) has one agreed
//!   location instead of every caller inventing one.
//!
//! What it deliberately does NOT do yet:
//! - No SQLCipher / encrypted-SQLite store. Storage is still the
//!   localStorage prototype in `apps/desktop/src/vault.ts`.
//! - No Keychain integration, no auto-updater (no signing key, no
//!   endpoint — see README.md), no shell/fs/http plugin access.
//! - No command accepts or returns a passphrase, key, or vault item.

use tauri::Manager;

/// App version from Cargo.toml. No secrets involved.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// OS app-data directory for this app (e.g. `~/Library/Application
/// Support/com.loygenics.my-secrect` on macOS). Used only to locate the
/// future encrypted store; nothing is read or written here yet.
#[tauri::command]
fn vault_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

/// Agreed future location of the SQLCipher database (`vault.db` inside the
/// app-data directory). The file is NOT created, opened, or migrated by
/// this command — it only answers "where will it live" so the storage
/// migration has a single source of truth. The SQLCipher migration itself
/// is still TODO (see README.md).
#[tauri::command]
fn vault_database_path(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("vault.db").to_string_lossy().into_owned())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            app_version,
            vault_data_dir,
            vault_database_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
