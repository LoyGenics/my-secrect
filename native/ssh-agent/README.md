# SSH agent — separate integration, not a text field holding a private key

Planned: agent protocol (ssh-agent / OpenSSH) backed by vault-stored keys,
with per-use confirmation. Keys never leave the vault in plaintext except
into the agent's protected memory for signing.
