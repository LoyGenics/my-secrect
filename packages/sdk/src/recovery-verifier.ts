/**
 * @my-secrect/sdk — the Ed25519 key behind the server-side recovery
 * verifier (specs/recovery-protocol.md, "Recovery verifier key").
 *
 * The 32-byte recovery key is also the input of the vault's recovery KEK
 * (SHA-256(recovery key), apps/desktop/src/vault.ts). The verifier key must
 * never be that same secret used in another role, so its seed is derived
 * with domain separation:
 *
 *   seed = HKDF-SHA-256(IKM = recovery key, salt = 32 zero bytes,
 *                       info = "my-secrect/recovery-verifier/v1", L = 32)
 *   (publicKey, privateKey) = crypto_sign_seed_keypair(seed)
 *
 * HKDF is crypto-adapters' libsodium-HMAC implementation (RFC 5869); the
 * server only ever receives the public key and signatures.
 *
 * LEGACY v0 (before this change): seed = the recovery key itself. Existing
 * v0 verifiers keep working for recovery SIGN-IN only (the client tries v1,
 * then v0 — legacyRecoveryVerifierKeyPair); registering always uses v1, and
 * re-registering replaces every older verifier. Remove v0 once the server
 * reports no active 'v0-raw-recovery-key' verifiers.
 *
 * Callers must zero-fill `privateKey` after use.
 */
import sodium from 'libsodium-wrappers-sumo';
import { hkdfSha256, sodiumReady } from '../../crypto-adapters/src/index';

export const RECOVERY_VERIFIER_INFO = 'my-secrect/recovery-verifier/v1';
/** Sent with POST /v1/recovery/verifiers; the server stores it per verifier. */
export const RECOVERY_VERIFIER_DERIVATION = 'v1-hkdf-sha256';
export const LEGACY_RECOVERY_VERIFIER_DERIVATION = 'v0-raw-recovery-key';

export interface RecoveryVerifierKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

function assertRecoveryKey(recoveryKey: Uint8Array): void {
  if (recoveryKey.length !== 32) throw new Error('recovery key must be 32 bytes');
}

/** v1 verifier key pair: the only derivation used to REGISTER a verifier. */
export async function recoveryVerifierKeyPair(recoveryKey: Uint8Array): Promise<RecoveryVerifierKeyPair> {
  assertRecoveryKey(recoveryKey);
  const seed = await hkdfSha256(recoveryKey, RECOVERY_VERIFIER_INFO, 32);
  try {
    await sodiumReady;
    const kp = sodium.crypto_sign_seed_keypair(seed);
    return { publicKey: kp.publicKey, privateKey: kp.privateKey };
  } finally {
    seed.fill(0);
  }
}

/** LEGACY v0 key pair (seed = recovery key). Sign-in fallback only — never
 *  use it to register a verifier. */
export async function legacyRecoveryVerifierKeyPair(recoveryKey: Uint8Array): Promise<RecoveryVerifierKeyPair> {
  assertRecoveryKey(recoveryKey);
  await sodiumReady;
  const kp = sodium.crypto_sign_seed_keypair(recoveryKey);
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}
