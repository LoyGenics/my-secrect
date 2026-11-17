//! End-to-end check of the desktop app: the REAL frontend (`apps/desktop/dist`,
//! embedded) in the REAL app (`my_secrect_lib::builder`: SQLCipher store, key
//! in the OS credential store, capabilities/ACL), driven through its UI by
//! `e2e_driver.js`, across real process restarts.
//!
//! Opt-in, because it opens windows and writes a test item into the login
//! Keychain (removed at the end):
//!
//! ```sh
//! npm --workspace apps/desktop run build      # dist/ with the vault.ts integration
//! cd apps/desktop/src-tauri
//! MY_SECRECT_E2E=1 cargo test --features custom-protocol --test e2e_app
//! ```
//!
//! Each phase runs in a fresh child process (= an app restart). It uses a
//! temporary data directory and a random keychain service, never the real
//! app's `vault.db` or key.
//!
//! 1. `create`: onboarding through the UI, load example data; the rows
//!    reach SQLCipher, nothing in localStorage; non-granted commands are
//!    rejected by the ACL.
//! 2. `unlock`: restart: lock screen (vault found), wrong passphrase
//!    rejected, right one shows the items.
//! 3. `seed-legacy`: new empty store; put the vault from (1) into
//!    localStorage, reload: migrated verbatim, localStorage copy removed,
//!    lock screen on first render.
//! 4. `unlock`: restart on the migrated store; items unlock.
//! 5. `expect-alert`: delete store (1)'s keychain item: the app refuses to
//!    start (visible alert, no vault UI), creates no new key, leaves
//!    vault.db byte-identical, writes no localStorage.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::Value;
use tauri::webview::PageLoadEvent;
use tauri::Manager;

const PASSPHRASE: &str = "e2e correct horse battery staple";
const DRIVER: &str = include_str!("e2e_driver.js");
const RESULT_PREFIX: &str = "E2E-RESULT ";

fn main() {
    if std::env::var("MY_SECRECT_E2E").as_deref() != Ok("1") {
        println!("e2e_app: skipped (set MY_SECRECT_E2E=1; see the file header)");
        return;
    }
    if !cfg!(feature = "custom-protocol") {
        eprintln!("e2e_app: build with `--features custom-protocol` so the built frontend is embedded");
        std::process::exit(1);
    }
    match std::env::var("E2E_PHASE") {
        Ok(phase) => run_phase(&phase),
        Err(_) => orchestrate(),
    }
}

/// Child process: run the app with the driver until it reports.
fn run_phase(phase: &str) {
    let data_dir = PathBuf::from(std::env::var("E2E_DATA_DIR").expect("E2E_DATA_DIR"));
    let service = std::env::var("E2E_SERVICE").expect("E2E_SERVICE");
    let seed: Value = match std::env::var("E2E_SEED_FILE") {
        Ok(path) => serde_json::from_slice(&std::fs::read(path).expect("seed file")).expect("seed json"),
        Err(_) => Value::Null,
    };
    let config = serde_json::json!({ "phase": phase, "passphrase": PASSPHRASE, "seed": seed });
    let script = format!("window.__MY_SECRECT_E2E__ = {config};\n{DRIVER}");

    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(240));
        eprintln!("e2e_app: phase timed out");
        std::process::exit(3);
    });

    let hook: my_secrect_lib::WindowHook = Box::new(move |window| {
        window
            .on_page_load(move |w, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    w.eval(script.clone()).expect("eval driver");
                }
            })
            .on_document_title_changed(|w, title| {
                if let Some(json) = title.strip_prefix(RESULT_PREFIX) {
                    println!("{RESULT_PREFIX}{json}");
                    w.app_handle().exit(0);
                }
            })
    });
    my_secrect_lib::builder(my_secrect_lib::Options {
        data_dir: Some(data_dir),
        keychain_service: Some(service),
        window_hook: Some(hook),
    })
    .run(my_secrect_lib::context())
    .expect("run app");
}

struct Run {
    service: String,
    dir: PathBuf,
}

impl Run {
    fn new(root: &Path, name: &str) -> Self {
        let mut n = [0u8; 8];
        getrandom::fill(&mut n).unwrap();
        let suffix: String = n.iter().map(|b| format!("{b:02x}")).collect();
        Run {
            service: format!("com.loygenics.my-secrect.e2e.{name}.{suffix}"),
            dir: root.join(name),
        }
    }

    fn phase(&self, phase: &str, seed_file: Option<&Path>) -> Value {
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.env("MY_SECRECT_E2E", "1")
            .env("E2E_PHASE", phase)
            .env("E2E_DATA_DIR", &self.dir)
            .env("E2E_SERVICE", &self.service)
            .stdout(Stdio::piped());
        if let Some(seed) = seed_file {
            cmd.env("E2E_SEED_FILE", seed);
        }
        let mut child = cmd.spawn().expect("spawn phase");
        let mut out = String::new();
        child.stdout.take().unwrap().read_to_string(&mut out).unwrap();
        let status = child.wait().unwrap();
        let line = out
            .lines()
            .find_map(|l| l.strip_prefix(RESULT_PREFIX))
            .unwrap_or_else(|| panic!("phase {phase}: no result (exit {status}); stdout: {out}"));
        let result: Value = serde_json::from_str(line)
            .unwrap_or_else(|e| panic!("phase {phase}: unparsable result ({e}): {line}"));
        assert!(status.success(), "phase {phase} exited with {status}");
        assert_eq!(result["ok"], true, "phase {phase} failed: {result}");
        result
    }

    /// The database file must be SQLCipher ciphertext and the key must be in
    /// the credential store, not next to the file.
    fn check_at_rest(&self) {
        let bytes = std::fs::read(self.dir.join(my_secrect_lib::keychain::DB_FILE)).unwrap();
        assert_ne!(&bytes[..16], b"SQLite format 3\0");
        for needle in ["my-secrect.local-vault.v1", "example-login", "wrapped_master"] {
            assert!(
                !bytes.windows(needle.len()).any(|w| w == needle.as_bytes()),
                "{needle} readable in vault.db"
            );
        }
        let key = my_secrect_lib::keychain::read_key(&self.service).unwrap().expect("key in keychain");
        for entry in std::fs::read_dir(&self.dir).unwrap() {
            let file = std::fs::read(entry.unwrap().path()).unwrap();
            assert!(!file.windows(32).any(|w| w == key.as_bytes()), "raw key found on disk");
        }
    }

    fn cleanup(&self) {
        let _ = my_secrect_lib::keychain::delete_key(&self.service);
    }
}

fn ids(v: &Value) -> Vec<String> {
    v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()
}

fn orchestrate() {
    let root = std::env::temp_dir().join(format!("my-secrect-e2e-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let a = Run::new(&root, "fresh");
    let b = Run::new(&root, "migrated");
    let outcome = std::panic::catch_unwind(|| {
        // 1. create through the UI
        let created = a.phase("create", None);
        let created_ids = ids(&created["storedIds"]);
        println!("create: {} rows committed, generation {}", created_ids.len(), created["generation"]);
        assert!(created_ids.len() >= 12 && created_ids.contains(&"example-login".to_string()));
        assert_eq!(created["storedKeys"], serde_json::json!(["my-secrect.local-vault.v1", "my-secrect.local-vault.v1.keys"]));
        assert_eq!(created["localStorageVaultKeys"], serde_json::json!([]), "vault keys leaked to localStorage");
        for (what, msg) in created["denied"].as_object().unwrap() {
            let msg = msg.as_str().unwrap_or_else(|| panic!("{what} was NOT rejected by the ACL"));
            println!("ACL rejected {what}: {msg}");
        }
        a.check_at_rest();

        // 2. restart -> vault found, unlocks
        let unlocked = a.phase("unlock", None);
        println!("restart+unlock: items visible = {}", unlocked["uiShowsExampleItems"]);
        assert_eq!(unlocked["uiShowsExampleItems"], true);
        assert_eq!(ids(&unlocked["storedIds"]), created_ids);
        assert_eq!(unlocked["localStorageVaultKeys"], serde_json::json!([]));

        // 3. legacy localStorage vault -> migrated into a new, empty store
        // Read store A directly (same binary that created its key, so no
        // keychain prompt): these strings are exactly what vault.ts writes,
        // i.e. what a pre-SQLCipher build kept in localStorage.
        let snapshot = my_secrect_lib::keychain::open_vault_store(&a.dir, &a.service)
            .and_then(|mut s| s.snapshot())
            .expect("read store A");
        let seed_file = root.join("legacy-seed.json");
        std::fs::write(&seed_file, serde_json::to_vec(&snapshot.entries).unwrap()).unwrap();
        let migrated = b.phase("seed-legacy", Some(&seed_file));
        println!(
            "migration: verbatim = {}, lock screen on first render = {}, localStorage left = {}",
            migrated["migratedVerbatim"], migrated["lockScreenOnFirstRender"], migrated["localStorageVaultKeys"]
        );
        assert_eq!(migrated["migratedVerbatim"], true);
        assert_eq!(migrated["lockScreenOnFirstRender"], true);
        assert_eq!(migrated["localStorageVaultKeys"], serde_json::json!([]));
        assert_eq!(ids(&migrated["storedIds"]), created_ids);
        b.check_at_rest();

        // 4. restart on the migrated store
        let after = b.phase("unlock", None);
        assert_eq!(after["uiShowsExampleItems"], true);
        println!("restart+unlock after migration: items visible = {}", after["uiShowsExampleItems"]);

        // 5. key gone from the keychain, vault.db still there -> fail closed
        let db = a.dir.join(my_secrect_lib::keychain::DB_FILE);
        let before = std::fs::read(&db).unwrap();
        my_secrect_lib::keychain::delete_key(&a.service).unwrap();
        let refused = a.phase("expect-alert", None);
        println!("missing key: alert = {}", refused["alert"]);
        let alert = refused["alert"].as_str().unwrap();
        assert!(alert.contains("Refusing to create a new key"), "unexpected alert: {alert}");
        assert_eq!(refused["vaultUiMounted"], false);
        assert_eq!(refused["localStorageVaultKeys"], serde_json::json!([]));
        assert!(my_secrect_lib::keychain::read_key(&a.service).unwrap().is_none(), "a new key was created");
        assert_eq!(std::fs::read(&db).unwrap(), before, "vault.db was modified");
    });
    a.cleanup();
    b.cleanup();
    let _ = std::fs::remove_dir_all(&root);
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
    println!("e2e_app: OK");
}
