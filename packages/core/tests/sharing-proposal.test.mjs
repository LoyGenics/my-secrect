// Imports the real packages/core/src/sharing.ts module.
// This is not a mirrored copy of the rules.
// Kept outside tests/security/ because CI runs plain `node --test tests/security/`
// on Node 20, which cannot import TypeScript.
// Run: node --experimental-strip-types --test packages/core/tests/sharing-proposal.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canRead,
  canWrite,
  recordPendingProposal,
  validateShareForActivation,
  validateShareProposal,
} from '../src/sharing.ts';

const meta = { id: 'share_test', owner_id: 'owner_1', created_at: '2026-11-17T00:00:00.000Z' };

test('a proposal without encrypted_key is recorded as pending', () => {
  const proposal = {
    vault_id: 'vault_1',
    recipient_id: 'recipient_1',
    permission: 'read',
    item_ids: [],
  };
  assert.equal(validateShareProposal(proposal), null);
  const share = recordPendingProposal(proposal, meta);
  assert.equal(share.status, 'pending');
  assert.equal(share.vault_id, 'vault_1');
  assert.equal(share.recipient_id, 'recipient_1');
  assert.equal(share.permission, 'read');
  assert.deepEqual(share.item_ids, []);
  assert.equal(share.key_envelope_id, '');
  assert.equal(share.revoked_at, null);
  assert.equal(canRead(share), false);
  assert.equal(canWrite(share), false);
});

test('a forged active share is not readable or writable, and activation is rejected', () => {
  const recorded = recordPendingProposal({
    vault_id: 'vault_1',
    recipient_id: 'recipient_1',
    permission: 'write',
    item_ids: ['item_1'],
    encrypted_key: 'opaque-unverified-blob',
  }, meta);
  assert.equal(recorded.status, 'pending');
  assert.equal(canRead(recorded), false);
  assert.equal(canWrite(recorded), false);

  const pendingError = validateShareForActivation(recorded);
  assert.equal(typeof pendingError, 'string');
  assert.match(pendingError, /no verified key wrap exists/);

  const claimedActive = { ...recorded, status: 'active', key_envelope_id: 'env_unverified' };
  const activeError = validateShareForActivation(claimedActive);
  assert.equal(typeof activeError, 'string');
  assert.match(activeError, /no verified key wrap exists/);
  assert.equal(canRead(claimedActive), false);
  assert.equal(canWrite(claimedActive), false);

  const claimedRead = { ...claimedActive, permission: 'read' };
  assert.equal(canRead(claimedRead), false);
  assert.equal(canWrite(claimedRead), false);
});

test('an invalid proposal is rejected and the error is surfaced', () => {
  const proposal = { vault_id: '', recipient_id: 'recipient_1', permission: 'read', item_ids: [] };
  const err = validateShareProposal(proposal);
  assert.match(err, /vault_id is required/);
  assert.throws(() => recordPendingProposal(proposal, meta), /vault_id is required/);
});
