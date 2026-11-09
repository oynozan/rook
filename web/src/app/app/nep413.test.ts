// NEP-413 sign-in check against a reference signature from near-api-js 7.4.0 KeyPairSigner.signNep413Message
// (account alice.testnet, message "Sign in to Rook", recipient "rook.local", no callbackUrl). The key is a throwaway
// made from the seed 01 02 .. 20 and the nonce is ff fe .. e0; neither holds anything. Run: npx tsx --test src/app/app/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base58Decode, isAccountId, isFullAccessKey, parsePublicKey, payloadHash, signatureValid, SIGN_IN_MESSAGE } from './nep413';

const REF = {
  publicKey: 'ed25519:9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj',
  signature: '0eQhQt0oQdFti4YRi8+AlTQuNPozdfg3FJzcCI7Md1bCw6WzO69Ax6BsjO6JKd1afU38T/31ISKqSesimKbvCw==',
  signatureB58: '5CPgDgNMnsKkghkAQmV47zUTNQ8eSwZvTqmwpVEoLGPdVW5id1AaNNqMeuvoFUDVSaLVgUofEUHPgRC2m5eWrcee',
  nonce: Buffer.from('//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA=', 'base64'),
  recipient: 'rook.local',
};
const input = { publicKey: REF.publicKey, signature: REF.signature, message: SIGN_IN_MESSAGE, nonce: REF.nonce, recipient: REF.recipient };

test('accepts the near-api-js reference signature', () => {
  assert.equal(SIGN_IN_MESSAGE, 'Sign in to Rook');
  assert.equal(signatureValid(input), true);
});

test('accepts the same signature in base58, as a few wallets send it', () => {
  assert.equal(signatureValid({ ...input, signature: REF.signatureB58 }), true);
  assert.equal(signatureValid({ ...input, signature: `ed25519:${REF.signatureB58}` }), true);
});

test('refuses a signature made for another recipient, nonce or message', () => {
  assert.equal(signatureValid({ ...input, recipient: 'evil.example' }), false);
  assert.equal(signatureValid({ ...input, recipient: 'localhost:7110' }), false);
  const nonce = Buffer.from(REF.nonce);
  nonce[0] ^= 1;
  assert.equal(signatureValid({ ...input, nonce }), false);
  assert.equal(signatureValid({ ...input, message: 'Sign in to Rook!' }), false);
});

test('refuses a tampered signature, another key, and malformed input without throwing', () => {
  const sig = Buffer.from(REF.signature, 'base64');
  sig[10] ^= 0x40;
  assert.equal(signatureValid({ ...input, signature: sig.toString('base64') }), false);
  assert.equal(signatureValid({ ...input, publicKey: 'ed25519:11111111111111111111111111111111' }), false);
  assert.equal(signatureValid({ ...input, publicKey: 'secp256k1:abc' }), false);
  assert.equal(signatureValid({ ...input, signature: 'not a signature' }), false);
  assert.throws(() => payloadHash(SIGN_IN_MESSAGE, Buffer.alloc(31), REF.recipient), /32 bytes/);
});

test('base58 keeps leading zero bytes, and public keys decode to 32 bytes', () => {
  assert.deepEqual([...base58Decode('112')], [0, 0, 1]);
  assert.equal(parsePublicKey(REF.publicKey).length, 32);
  assert.throws(() => parsePublicKey('ed25519:2'), /32 bytes/);
});

test('account ids', () => {
  for (const ok of ['alice.near', 'rook-ops.testnet', 'a1', 'x_y.near', 'f'.repeat(64)]) assert.equal(isAccountId(ok), true, ok);
  for (const bad of ['A.near', 'a', '.near', 'alice..near', 'alice.near.', 'a'.repeat(65), 'alice@near', 7]) assert.equal(isAccountId(bad), false, String(bad));
});

test('only a FullAccess key on the account signs in', async () => {
  const rpc = (result: unknown) => (async () => new Response(JSON.stringify(result))) as unknown as typeof fetch;
  assert.equal(await isFullAccessKey('alice.testnet', REF.publicKey, 'http://rpc', rpc({ result: { permission: 'FullAccess' } })), true);
  assert.equal(await isFullAccessKey('alice.testnet', REF.publicKey, 'http://rpc', rpc({ result: { permission: { FunctionCall: {} } } })), false);
  assert.equal(await isFullAccessKey('alice.testnet', REF.publicKey, 'http://rpc', rpc({ error: { cause: { name: 'UNKNOWN_ACCESS_KEY' } } })), false);
});
