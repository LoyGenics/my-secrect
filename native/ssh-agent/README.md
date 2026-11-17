# SSH agent — separate integration, not a text field holding a private key

Planned: agent protocol (ssh-agent / OpenSSH) backed by vault-stored keys,
with per-use confirmation. Keys never leave the vault in plaintext except
into the agent's protected memory for signing.

## Status — SCAFFOLD, NOT USABLE (Phase F, 17 Nov 2026)

**Do not point `SSH_AUTH_SOCK` at this binary expecting real SSH auth.**
Nothing here has ever been compiled or run (`cargo test` / `cargo run`
have not executed on the Mac).

| File | State |
|---|---|
| `src/protocol.rs` | **Real, complete.** Agent wire framing: length-prefixed messages, big-endian fields, bounds-checked parsing, identities-answer / failure encoding, unit tests for parse + round-trip + malformed input. |
| `src/main.rs` | **Real socket server, no keys.** Unix socket listener (0600 perms, 1 MiB message cap, thread per client). Answers `REQUEST_IDENTITIES` with an **empty** list and every signing request with `SSH_AGENT_FAILURE`. |
| Key loading | **Not implemented.** No `ssh_key` item (`packages/core` `ItemType`) is read, decrypted, or offered. |
| Signing (Ed25519) | **Not implemented.** `native/crypto-core` exposes KDF/AEAD/stream/HKDF only — it has no signing API yet. This crate must not hand-roll crypto or add a second crypto stack. |
| Per-use confirmation | **Not implemented.** Until the user confirms each signature, this agent must never hold a real key. |

## Build / test (Terminal on the Mac)

```sh
cd native/ssh-agent
cargo test    # protocol unit tests (framing, parse, malformed input)
cargo run -- /tmp/my-secrect-agent.sock
# in another Terminal: SSH_AUTH_SOCK=/tmp/my-secrect-agent.sock ssh-add -l
#   -> "The agent has no identities." (honest empty answer)
#   -> any signing attempt fails with SSH_AGENT_FAILURE (not implemented)
```

Socket path: argv[1], else `$MY_SECRECT_AGENT_SOCK`, else
`/tmp/my-secrect-agent.sock`. A stale socket file is removed on start.
The agent never logs key material — it has none — and never writes
anything to disk except the socket file itself.

## What remains, in order

1. Add an Ed25519 signing API to `native/crypto-core` (libsodium
   `crypto_sign`), with test vectors — the audited-boundary rule says all
   crypto goes through crypto-core.
2. Load `ssh_key` items: after vault unlock, decrypt one item's private
   key into the agent's protected memory only (never to disk, never
   logged), and offer its public blob in `REQUEST_IDENTITIES`.
3. Per-use confirmation: prompt (Tauri dialog / macOS notification +
   approval) for each `SIGN_REQUEST`, showing the key comment and the
   data's fingerprint; sign only on approval.
4. Lifetime rules: lock/wipe keys on vault lock, on agent exit, and on
   idle timeout; `ssh-add -D` equivalent removes them from memory.
5. Then test against real `ssh` to a test host — never against a
   production host first.
