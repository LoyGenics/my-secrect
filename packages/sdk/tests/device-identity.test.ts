// Real-module test (imports packages/sdk/src/device-identity.ts): the
// device signed-message format against the LITERAL vector in
// specs/device-identity.md §10, signed with libsodium AND with WebCrypto
// Ed25519 (Node's crypto.subtle) — both must give the spec's bytes.
//   npx tsx --test packages/sdk/tests/device-identity.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers-sumo';
import {
  canonicalPayload,
  deviceMessage,
  enrollPayload,
  sessionBindPayload,
  toBase64UrlNoPad,
} from '../src/device-identity';

const seedHex = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const publicKey = 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg';
const challenge = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';
const deviceId = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const bindMessageHex =
  '6d792d736563726563742f6465766963652f76312f73657373696f6e2d62696e640a7b226368616c6c656e6765223a22494345694979516c4a69636f4b536f724c4330754c7a41784d6a4d304e5459334f446b364f7a7739506a38222c226465766963655f6964223a2236663163326133622d346435652d346636302d386137622d396330643165326633613462227d';
const bindSignature = 'KFN1G09bb_AoNZUh77OX3tjTRdjXEnmZEsCaNUxK4-R6X-qn4m-v6qACHOB0XDLH6LO8e_aztE49ihsRhzyuDQ';
const enrollSignature = '53CXmLHTJIzg38orguydfr11SGBznkcKMiGeoyBLz8TNP-q2OPbHH44z0sOYREYQWj59r9AfGJSK8aJOfKJqDA';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

test('session-bind message bytes match the spec vector', () => {
  assert.equal(hex(deviceMessage('session-bind', sessionBindPayload(challenge, deviceId))), bindMessageHex);
});

test('libsodium signatures over the messages match the spec vector', async () => {
  await sodium.ready;
  const kp = sodium.crypto_sign_seed_keypair(Buffer.from(seedHex, 'hex'));
  assert.equal(toBase64UrlNoPad(kp.publicKey), publicKey);
  const bind = sodium.crypto_sign_detached(deviceMessage('session-bind', sessionBindPayload(challenge, deviceId)), kp.privateKey);
  assert.equal(toBase64UrlNoPad(bind), bindSignature);
  const enroll = sodium.crypto_sign_detached(deviceMessage('enroll', enrollPayload(challenge, publicKey)), kp.privateKey);
  assert.equal(toBase64UrlNoPad(enroll), enrollSignature);
});

test('WebCrypto Ed25519 produces the same signatures (the browser path)', async () => {
  // PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410).
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seedHex, 'hex')]);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key,
    deviceMessage('session-bind', sessionBindPayload(challenge, deviceId))));
  assert.equal(toBase64UrlNoPad(sig), bindSignature);
});

test('purposes are domain-separated', async () => {
  await sodium.ready;
  const kp = sodium.crypto_sign_seed_keypair(Buffer.from(seedHex, 'hex'));
  const sig = Buffer.from(bindSignature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const payload = sessionBindPayload(challenge, deviceId);
  assert.equal(sodium.crypto_sign_verify_detached(sig, deviceMessage('session-bind', payload), kp.publicKey), true);
  assert.equal(sodium.crypto_sign_verify_detached(sig, deviceMessage('enroll', payload), kp.publicKey), false);
});

test('canonical payload: sorted, unescaped, and refuses anything needing escaping', () => {
  assert.equal(canonicalPayload({ b: '2', a: '1' }), '{"a":"1","b":"2"}');
  for (const bad of [{ a: 'quote"' }, { a: 'back\\slash' }, { a: 'new\nline' }, { a: 'café' }, { A: 'x' }, { 'a-b': 'x' }]) {
    assert.throws(() => canonicalPayload(bad as Record<string, string>));
  }
  assert.throws(() => canonicalPayload({ a: 1 } as unknown as Record<string, string>));
  assert.throws(() => deviceMessage('Bad Purpose', {}));
});
