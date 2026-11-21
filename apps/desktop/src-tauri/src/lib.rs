//! my-secrect desktop shell (Tauri v2 + the React app in `apps/desktop/src/`).
//!
//! The frontend's `StorageBackend` (see `apps/desktop/src/storage/`) is
//! backed here by an SQLCipher database whose random 256-bit key lives in
//! the OS credential store (`keychain.rs`, `store.rs`).
//!
//! IPC surface, nothing else is reachable from the webview:
//! - command `kv_snapshot`  — every stored pair + generation (async read);
//! - command `kv_commit`    — atomic batch of set/remove ops, compare-and-swap
//!   on the generation;
//! - command `google_sign_in` — "Continue with Google" in the system browser
//!   (loopback + PKCE, `google_oauth.rs`); returns only the ID token;
//!   `google_sign_in_cancel` stops its loopback listener;
//! - protocol `vaultkv://localhost/snapshot` — the same snapshot, but
//!   readable with a synchronous XHR. The frontend storage contract is
//!   synchronous (`getItem` returns a value, not a promise) and the vault
//!   reads it during the very first render, so the cache must be filled
//!   before React mounts; Tauri commands are async-only. The handler is
//!   read-only, GET-only, and answers only the `main` webview from the app's
//!   own origins.
//!
//! Capabilities (`capabilities/default.json`) grant exactly
//! `allow-kv-snapshot`, `allow-kv-commit` and `allow-google-sign-in`; `build.rs` declares an app ACL
//! manifest, so every other app or core/plugin command is rejected.

pub mod google_oauth;
pub mod keychain;
pub mod store;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, State, UriSchemeContext, WebviewWindowBuilder, Wry};

use crate::store::{KvOp, KvStore, Snapshot};

/// Label of the only window (from `tauri.conf.json`).
pub const MAIN_WINDOW: &str = "main";
/// Custom URI scheme serving the startup snapshot.
pub const SNAPSHOT_SCHEME: &str = "vaultkv";

/// Opened store, or the reason it could not be opened (reported to the
/// frontend on every call — no retry, no fallback).
pub struct VaultStore(Mutex<Result<KvStore, String>>);

impl VaultStore {
    fn with<T>(&self, f: impl FnOnce(&mut KvStore) -> Result<T, store::StoreError>) -> Result<T, String> {
        let mut guard = self
            .0
            .lock()
            .map_err(|_| "vault storage is unavailable after an internal error; restart the app".to_string())?;
        match guard.as_mut() {
            Ok(store) => f(store).map_err(|e| e.to_string()),
            Err(reason) => Err(reason.clone()),
        }
    }

    pub fn snapshot(&self) -> Result<Snapshot, String> {
        self.with(|s| s.snapshot())
    }
}

#[tauri::command]
async fn kv_snapshot(store: State<'_, VaultStore>) -> Result<Snapshot, String> {
    store.snapshot()
}

#[tauri::command]
async fn kv_commit(
    store: State<'_, VaultStore>,
    expected_generation: u64,
    ops: Vec<KvOp>,
) -> Result<u64, String> {
    store.with(|s| s.commit(expected_generation, &ops))
}

/// Origins the app's own pages are served from. Remote content (if a page
/// ever navigated away) never matches.
fn allowed_origins(app: &AppHandle) -> Vec<String> {
    let mut origins = vec![
        "tauri://localhost".to_string(),
        "http://tauri.localhost".to_string(),
        "https://tauri.localhost".to_string(),
    ];
    if cfg!(debug_assertions) {
        if let Some(url) = &app.config().build.dev_url {
            let mut o = format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default());
            if let Some(port) = url.port() {
                o.push_str(&format!(":{port}"));
            }
            origins.push(o);
        }
    }
    origins
}

fn json_response(status: StatusCode, origin: Option<&str>, body: Vec<u8>) -> Response<Vec<u8>> {
    let mut b = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::VARY, "Origin");
    if let Some(o) = origin {
        b = b.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, o);
    }
    b.body(body).expect("static response parts are valid")
}

fn error_body(message: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "error": message })).unwrap_or_default()
}

fn snapshot_protocol(ctx: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let origin_ok = origin
        .as_deref()
        .is_some_and(|o| allowed_origins(ctx.app_handle()).iter().any(|a| a == o));
    if ctx.webview_label() != MAIN_WINDOW
        || !origin_ok
        || request.method() != Method::GET
        || request.uri().path() != "/snapshot"
    {
        return json_response(StatusCode::FORBIDDEN, None, error_body("forbidden"));
    }
    let origin = origin.as_deref();
    match ctx.app_handle().state::<VaultStore>().snapshot() {
        Ok(snap) => match serde_json::to_vec(&snap) {
            Ok(body) => json_response(StatusCode::OK, origin, body),
            Err(e) => json_response(StatusCode::INTERNAL_SERVER_ERROR, origin, error_body(&e.to_string())),
        },
        Err(reason) => json_response(StatusCode::SERVICE_UNAVAILABLE, origin, error_body(&reason)),
    }
}

/// Hook to adjust the main window before it is built (the e2e harness uses
/// it to drive the real UI; the app itself passes none).
pub type WindowHook = Box<
    dyn for<'a> FnOnce(WebviewWindowBuilder<'a, Wry, AppHandle>) -> WebviewWindowBuilder<'a, Wry, AppHandle>
        + Send,
>;

#[derive(Default)]
pub struct Options {
    /// Directory holding `vault.db`. `None` = the OS app-data directory
    /// (`~/Library/Application Support/com.loygenics.my-secrect` on macOS).
    pub data_dir: Option<PathBuf>,
    /// Credential-store service of the database key. `None` = app identifier.
    pub keychain_service: Option<String>,
    pub window_hook: Option<WindowHook>,
}

pub fn builder(options: Options) -> tauri::Builder<Wry> {
    let Options { data_dir, keychain_service, window_hook } = options;
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![kv_snapshot, kv_commit, google_oauth::google_sign_in, google_oauth::google_sign_in_cancel])
        .register_uri_scheme_protocol(SNAPSHOT_SCHEME, snapshot_protocol)
        .setup(move |app| {
            let handle = app.handle().clone();
            let data_dir = match data_dir {
                Some(dir) => dir,
                None => handle.path().app_data_dir()?,
            };
            let service = keychain_service.unwrap_or_else(|| handle.config().identifier.clone());
            let store = keychain::open_vault_store(&data_dir, &service).map_err(|e| {
                // Fail closed: the frontend shows this message and refuses to
                // run; nothing falls back to localStorage.
                eprintln!("my-secrect: vault storage unavailable: {e}");
                e.to_string()
            });
            app.manage(VaultStore(Mutex::new(store)));

            let config = handle
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == MAIN_WINDOW)
                .cloned()
                .ok_or("tauri.conf.json has no `main` window")?;
            let mut window = WebviewWindowBuilder::from_config(&handle, &config)?;
            if let Some(hook) = window_hook {
                window = hook(window);
            }
            window.build()?;
            Ok(())
        })
}

pub fn context() -> tauri::Context<Wry> {
    tauri::generate_context!()
}

pub fn run() {
    builder(Options::default())
        .run(context())
        .expect("error while running tauri application");
}
