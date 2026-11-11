// Wallet messages from a report preview's frame must not reach near-connect. Run: npx tsx --test test/*.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardWalletMessages, isForgedWalletMessage } from '@/lib/wallet-messages';

const manifest = { id: 'meteor-wallet', name: 'Meteor (verify funding)', features: { signAndSendTransaction: true } };
const inject = { type: 'near-wallet-injected', manifest };
const response = { type: 'near-wallet-injected-response', id: 'x', success: true, result: [] };

test('isForgedWalletMessage: at top level no frame may offer a wallet', () => {
  const top: { parent: unknown } = { parent: null };
  top.parent = top;
  const preview = {}; // the preview frame's window
  assert.equal(isForgedWalletMessage({ data: inject, source: preview }, top), true);
  assert.equal(isForgedWalletMessage({ data: inject, source: top }, top), true); // top's parent is itself: no embedder
  assert.equal(isForgedWalletMessage({ data: response, source: preview }, top), true);
});

test('isForgedWalletMessage: embedded, only the embedding page may', () => {
  const host = {};
  const app = { parent: host };
  assert.equal(isForgedWalletMessage({ data: inject, source: host }, app), false);
  assert.equal(isForgedWalletMessage({ data: response, source: host }, app), false);
  assert.equal(isForgedWalletMessage({ data: inject, source: {} }, app), true);
  assert.equal(isForgedWalletMessage({ data: inject, source: null }, app), true);
});

test('isForgedWalletMessage: other messages pass, whoever sent them', () => {
  const top: { parent: unknown } = { parent: null };
  top.parent = top;
  for (const data of [{ type: 'near-selector-ready' }, { type: 'near-wallet-injected-request', id: 'x' }, { type: 'other' }, 'near-wallet-injected', null, undefined, 3]) {
    assert.equal(isForgedWalletMessage({ data, source: {} }, top), false, JSON.stringify(data));
  }
});

test('guardWalletMessages: a forged message never reaches a later listener, a real one does', () => {
  const host = {};
  const win = Object.assign(new EventTarget(), { parent: host as unknown });
  guardWalletMessages(win);
  guardWalletMessages(win); // added once
  const seen: unknown[] = [];
  win.addEventListener('message', (e) => seen.push((e as unknown as { source: unknown }).source));
  const post = (data: unknown, source: unknown) => win.dispatchEvent(Object.assign(new Event('message'), { data, source }));
  const preview = {};
  post(inject, preview);
  post(inject, host);
  post({ type: 'near-selector-ready' }, preview);
  assert.deepEqual(seen, [host, preview]);
});
