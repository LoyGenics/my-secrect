// MIRROR: re-implements logic in-file; NOT production verification (see tests run via tsx --test for real-module coverage).
import test from 'node:test';
import assert from 'node:assert/strict';
// Sync conflict rule: never Last Write Wins. Both-changed => keep both versions.
// (Duplicated tiny logic here so the test runs without a TS loader.)
function detectConflict(localRevision, localBase, remoteRevision) {
  if (localRevision === localBase) return 'none';
  if (remoteRevision === localBase) return 'none';
  return 'same_item_both_changed';
}
test('different items / one side unchanged => no conflict', () => {
  assert.equal(detectConflict(3, 3, 5), 'none');
  assert.equal(detectConflict(5, 3, 3), 'none');
});
test('both changed same item => conflict, keep both', () => {
  assert.equal(detectConflict(4, 3, 5), 'same_item_both_changed');
});
