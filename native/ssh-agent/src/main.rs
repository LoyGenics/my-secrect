//! my-secrect SSH agent — SCAFFOLD, NOT USABLE. Read README.md first.
//!
//! What this binary really does today:
//! - Listens on a Unix socket (path from argv[1], `MY_SECRECT_AGENT_SOCK`,
//!   or `/tmp/my-secrect-agent.sock`), one thread per client, with the
//!   real agent wire protocol (`protocol.rs`: length-prefixed messages).
//! - Answers `SSH_AGENTC_REQUEST_IDENTITIES` with an EMPTY list (no keys
//!   are loaded — that is the honest state, not a bug to hide).
//! - Answers every signing request with `SSH_AGENT_FAILURE` and a stderr
//!   note saying signing is not implemented.
//!
//! What it does NOT do (and must not be used for):
//! - No keys are loaded from the vault. No `ssh_key` item (`packages/core`
//!   `ItemType::ssh_key`) is read, decrypted, or offered.
//! - No signing. Ed25519 signing needs a signing API in
//!   `native/crypto-core` first (it currently exposes KDF/AEAD/stream/HKDF
//!   only) — this crate must not hand-roll crypto or add a second stack.
//! - No per-use confirmation. Until a confirmation step exists (prompt the
//!   user for each signature), this agent must never hold a real key.
//!
//! Do NOT point `SSH_AUTH_SOCK` at this socket expecting real SSH auth.
//! It exists so the protocol framing can be tested (`cargo test`) and the
//! socket lifecycle exercised — nothing more.

mod protocol;

use protocol::{
    encode_failure, encode_identities_answer, parse_request, AgentRequest, MAX_MESSAGE_LEN,
};
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::thread;

fn socket_path() -> PathBuf {
    if let Some(arg) = env::args().nth(1) {
        return PathBuf::from(arg);
    }
    if let Some(from_env) = env::var_os("MY_SECRECT_AGENT_SOCK") {
        return PathBuf::from(from_env);
    }
    PathBuf::from("/tmp/my-secrect-agent.sock")
}

fn handle_client(mut stream: UnixStream) {
    loop {
        // Read one framed message: 4-byte big-endian length, then payload.
        let mut len_buf = [0u8; 4];
        if stream.read_exact(&mut len_buf).is_err() {
            return; // client disconnected (or socket error) — done.
        }
        let len = u32::from_be_bytes(len_buf) as usize;
        if len == 0 || len > MAX_MESSAGE_LEN {
            eprintln!("my-secrect ssh-agent: rejecting message of {len} bytes (limit {MAX_MESSAGE_LEN})");
            return;
        }
        let mut msg = vec![0u8; len];
        if stream.read_exact(&mut msg).is_err() {
            return;
        }
        let reply = match parse_request(&msg) {
            Ok(AgentRequest::RequestIdentities) => {
                // Honest empty answer: no keys are loaded in this scaffold.
                encode_identities_answer(&[])
            }
            Ok(AgentRequest::SignRequest { .. }) => {
                eprintln!("my-secrect ssh-agent: signing NOT IMPLEMENTED (no Ed25519 signing API in crypto-core yet); replying SSH_AGENT_FAILURE");
                encode_failure()
            }
            Ok(AgentRequest::Unknown(t)) => {
                eprintln!("my-secrect ssh-agent: unknown request type {t}; replying SSH_AGENT_FAILURE");
                encode_failure()
            }
            Err(e) => {
                eprintln!("my-secrect ssh-agent: malformed request ({e}); closing connection");
                return;
            }
        };
        if stream.write_all(&reply).is_err() {
            return;
        }
    }
}

fn main() -> io::Result<()> {
    let path = socket_path();
    // A previous run (or a crash) may have left a stale socket file behind;
    // remove it so bind() succeeds. The socket is recreated on every start.
    if path.exists() {
        fs::remove_file(&path)?;
    }
    let listener = UnixListener::bind(&path)?;
    // Only this user may talk to the agent socket. 0600, set explicitly —
    // never rely on the process umask.
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    eprintln!(
        "my-secrect ssh-agent listening on {} (SCAFFOLD: no keys loaded, signing not implemented — see README.md)",
        path.display()
    );
    for conn in listener.incoming() {
        match conn {
            Ok(stream) => {
                thread::spawn(move || handle_client(stream));
            }
            Err(e) => eprintln!("my-secrect ssh-agent: accept error: {e}"),
        }
    }
    Ok(())
}
