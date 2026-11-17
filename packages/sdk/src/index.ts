/**
 * @my-secrect/sdk — the ONE import path apps use for the Rails API + sync.
 *
 *   import { VaultApiClient, SyncClient, createSyncClient } from '@my-secrect/sdk';
 *   // (workspace-relative: '../../sdk/src/index' until package names resolve)
 *
 * The SDK sends ONLY ciphertext + opaque ids. It never sends plaintext
 * titles, tags, types, or relations to the server, and it never logs
 * request bodies (they are ciphertext, but they are still not logged).
 *
 * Sync wiring (Phase C): SyncClient lives in packages/sync and is
 * re-exported here together with VaultApiClient, so apps have a single
 * import path. The import graph is safe: packages/sync only references
 * VaultApiClient as a TYPE (erased at compile time), so there is no
 * runtime cycle back into this module.
 *
 * Apps are NOT wired in by this package (another agent owns apps/) —
 * see README.md for the one-line integration.
 */
import type { PullResponse, PushRequest } from '../../sync/src/index';
import { SyncClient } from '../../sync/src/sync-client';
// NOTE on the import graph: packages/sync/src/sync-client.ts references
// VaultApiClient from this file ONLY as a type (erased at compile time),
// so this value import creates no runtime cycle back into the SDK.

export interface ApiClientConfig { baseUrl: string; getToken: () => Promise<string | null>; }

/** Error thrown for non-2xx API responses. The message keeps the legacy
 *  `API <status> <path>` shape: SyncClient detects 409 conflicts by
 *  matching /409/ in the message, so that shape must not change. */
export class ApiError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string, body?: unknown) {
    super(`API ${status} ${path}${body !== undefined ? `: ${typeof body === 'string' ? body : JSON.stringify(body)}` : ''}`);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
  }
}

export interface SyncPushResult {
  item_id: string;
  revision: number;
  sequence: number;
  deleted_at?: string | null;
}

export interface BlobUploadSessionRequest {
  blob_id: string;
  part_count: number;
  ciphertext_size: number;
  /** Base64 Vault-Key-encrypted manifest (carries the wrapped File Key). Required — see packages/storage. */
  encrypted_manifest: string;
}

export interface BlobUploadSession {
  blob_id: string;
  storage_key: string;
  parts: Array<{ part_number: number; url: string; object_key: string; expires_at: string }>;
}

export interface BlobPartReport {
  part_number: number;
  ciphertext_size: number;
  ciphertext_sha256_b64: string; // SHA-256 of the ciphertext bytes
}

export interface BlobDownloadSession {
  blob_id: string;
  status: string;
  ciphertext_size: number;
  /** Base64 Vault-Key-encrypted manifest — decrypt it, unwrap the File Key, then decrypt chunks. */
  encrypted_manifest: string;
  parts: Array<{ part_number: number; ciphertext_size: number; url: string; expires_at: string }>;
}

export class VaultApiClient {
  constructor(private cfg: ApiClientConfig) {}
  private async req(path: string, init: RequestInit = {}) {
    const token = await this.cfg.getToken();
    const res = await fetch(this.cfg.baseUrl + path, { ...init, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
    if (!res.ok) {
      let body: unknown;
      try { body = await res.json(); } catch { body = undefined; }
      throw new ApiError(res.status, path, body);
    }
    return res.json();
  }
  listVaults() { return this.req('/v1/vaults'); }
  getItem(vaultId: string, itemId: string) { return this.req(`/v1/vaults/${vaultId}/items/${itemId}`); }
  putItem(vaultId: string, itemId: string, body: unknown) { return this.req(`/v1/vaults/${vaultId}/items/${itemId}`, { method: 'PUT', body: JSON.stringify(body) }); }

  /** Pull sync events since `since` (a sequence cursor). Upsert events carry
   *  encrypted_payload + encrypted_item_key; deletes carry tombstone: true. */
  syncPull(vaultId: string, since?: string): Promise<PullResponse> {
    return this.req(`/v1/vaults/${vaultId}/sync${since ? `?since=${encodeURIComponent(since)}` : ''}`);
  }
  /** Push one change. 409 (stale base_revision) throws ApiError with status 409. */
  syncPush(vaultId: string, body: Omit<PushRequest, 'vault_id'>): Promise<SyncPushResult> {
    return this.req(`/v1/vaults/${vaultId}/sync/push`, { method: 'POST', body: JSON.stringify(body) });
  }

  // --- Blobs (chunked encrypted storage; see packages/storage) ---
  createBlobUploadSession(vaultId: string, body: BlobUploadSessionRequest): Promise<BlobUploadSession> {
    return this.req('/v1/blobs/upload-session', { method: 'POST', body: JSON.stringify({ vault_id: vaultId, ...body }) });
  }
  completeBlobUpload(blobId: string, parts: BlobPartReport[]): Promise<{ blob: { id: string; status: string; ciphertext_size: number } }> {
    return this.req(`/v1/blobs/${encodeURIComponent(blobId)}/complete`, { method: 'POST', body: JSON.stringify({ parts }) });
  }
  createBlobDownloadSession(blobId: string): Promise<BlobDownloadSession> {
    return this.req(`/v1/blobs/${encodeURIComponent(blobId)}/download-session`);
  }
}

// --- Sync engine: one import path for apps -------------------------------
// SyncClient drives push + pull against VaultApiClient: push drains the
// persisted offline queue FIFO (a push leaves the queue ONLY on 2xx;
// offline keeps it queued for replay), pull applies AEAD-verified events
// since the saved checkpoint, syncAll() = push then pull.
export { SyncClient } from '../../sync/src/sync-client';
export type { SyncClientOptions, SyncRunResult } from '../../sync/src/sync-client';
export {
  applyRemoteEvents,
  enqueuePush,
  loadQueue,
  removeQueuedPush,
  markQueueAttempt,
  clearQueue,
  loadCheckpoint,
  saveCheckpoint,
  loadConflicts,
  saveConflicts,
  resolveConflictKeepBoth,
  appendConflicts,
  removeQueuedPushEntry,
  wireItemId,
  isUuid,
  detectConflict,
  detectDeleteConflict,
  localStorageSyncStorage,
  memorySyncStorage,
  nextCursor,
} from '../../sync/src/index';
export type {
  SyncEvent,
  PushRequest,
  PullResponse,
  QueuedPush,
  SyncCheckpoint,
  SyncConflict,
  SyncStorage,
  LocalItemState,
  ApplyResult,
  RemoteDecrypt,
} from '../../sync/src/index';

// Re-exported for convenience so apps import types from the SDK, not paths.
export type { VaultItem, EncryptedItem, EncryptedItemVersion } from '../../core/src/types';

export interface CreateSyncClientOptions {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  vaultId: string;
  deviceId: string;
  storage: import('../../sync/src/index').SyncStorage;
  /** Decrypt + AEAD-verify one remote event. Must throw on tag failure. */
  decrypt: import('../../sync/src/index').RemoteDecrypt;
  /** Current local state, keyed by item id. */
  getLocalState: () => Map<string, import('../../sync/src/index').LocalItemState>;
  /** Persist an applied remote item locally (after AEAD verification). */
  saveLocalItem: (item: import('../../core/src/types').VaultItem, revision: number) => void;
  /** Persist a remote tombstone locally. */
  deleteLocalItem: (itemId: string, revision: number) => void;
  onPushed?: import('../../sync/src/sync-client').SyncClientOptions['onPushed'];
  itemMatchesEvent?: import('../../sync/src/sync-client').SyncClientOptions['itemMatchesEvent'];
  maxPullPages?: number;
}

/**
 * One-line sync setup for apps (see README.md). Returns a SyncClient
 * already bound to a VaultApiClient: `client.syncAll()` pushes the
 * offline queue, then pulls + applies remote events.
 */
export function createSyncClient(opts: CreateSyncClientOptions): SyncClient {
  const api = new VaultApiClient({ baseUrl: opts.baseUrl, getToken: opts.getToken });
  return new SyncClient(api, {
    vaultId: opts.vaultId,
    deviceId: opts.deviceId,
    storage: opts.storage,
    decrypt: opts.decrypt,
    getLocalState: opts.getLocalState,
    saveLocalItem: opts.saveLocalItem,
    deleteLocalItem: opts.deleteLocalItem,
    onPushed: opts.onPushed,
    itemMatchesEvent: opts.itemMatchesEvent,
    maxPullPages: opts.maxPullPages,
  });
}

// --- Account security (passkeys / MFA / sessions / devices / step-up) ---
// Lives in ./security.ts, which imports ApiError from this file only as a
// value used inside methods (never at module top level), so the cycle is
// safe: by the time any SecurityApiClient method runs, ApiError is defined
// (ApiError is declared near the top of this file, above this block).
export {
  SecurityApiClient,
  STEP_UP_WINDOW_MS,
  isStepUpFresh,
  isStepUpRequired,
  isUnauthorized,
  isMfaRequiredResult,
  LS_API_TOKEN,
  LS_API_TOKEN_EXPIRES_AT,
  LS_ACCOUNT_EMAIL,
  webTokenStore,
  saveSessionToken,
  readStoredToken,
  getValidToken,
  getValidTokenSync,
  clearSessionToken,
  adoptRotatedToken,
} from './security';
export type {
  TokenStore,
  PasskeyAuthenticator,
  PasskeyListResponse,
  MfaEnrollResponse,
  MfaConfirmResponse,
  RecoveryCodesResponse,
  SessionResult,
  MfaRequiredResult,
  SignInResult,
  PasskeyRegisterOptionsResponse,
  PasskeyAuthenticateOptionsResponse,
  SessionInfo,
  SessionListResponse,
  DeviceInfo,
  DeviceListResponse,
  ActivityEvent,
  ActivityResponse,
  RecoveryChallengeResponse,
} from './security';
export {
  initialSignInState,
  startSignIn,
  optionsReceived,
  passkeyVerified,
  mfaVerified,
  signInFailed,
  resetSignIn,
  classifySignInError,
} from './signin';
export type {
  SignInStep,
  SignInMode,
  SignInErrorKind,
  SignInState,
} from './signin';
// NOTE: `signin.ts` must stay import-free of fetch/DOM: it is a pure
// state machine (email -> passkey -> mfa -> signed-in) so the desktop,
// web and mobile sign-in screens — and the plain-Node mirror tests in
// tests/security/signin-client.test.mjs — all share the same rules.
