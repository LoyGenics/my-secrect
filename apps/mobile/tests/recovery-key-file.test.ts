import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyGroups, RECOVERY_KEY_FILENAME, recoveryKeyFileText } from '../src/utils/recoveryKeyText';

test('the recovery key file keeps the exact key on its own line with the warning', () => {
  const key = 'Ab3_-xYz09Ab3_-xYz09Ab3_-xYz09Ab3_-xYz09Ab3';
  const text = recoveryKeyFileText(key, 'My Secret recovery key', 'Keep it offline.');
  assert.equal(RECOVERY_KEY_FILENAME, 'my-secret-recovery-key.txt');
  assert.deepEqual(text.split('\n'), ['My Secret recovery key', 'Keep it offline.', '', key, '']);
});

test('key groups are display-only and rejoin to the original key', () => {
  const key = 'Ab3_-xYz09Ab3_-xYz09Ab3_-xYz09Ab3_-xYz09Ab3';
  const groups = keyGroups(key);
  assert.equal(groups.length, 11);
  assert.ok(groups.slice(0, -1).every((group) => group.length === 4));
  assert.equal(groups.join(''), key);
});
