// near-connect trusts some window messages without asking who sent them. A report's HTML preview runs agent-written
// scripts in a sandboxed frame, and that frame can still post to this window. In a plain module so it can be tested.

/**
 * The near-connect message types only a page embedding Rook may send: a wallet that page offers, and its answers.
 * 'near-wallet-injected' from any frame puts that frame's wallet first in the list and connects to it, and nothing
 * ever answers it. The wallet extensions inject with a 'near-wallet-injected' CustomEvent, not a message, so they
 * are not affected. Wallets in near-connect's own frames use other message types, matched by a random id.
 */
const FROM_EMBEDDER = new Set(['near-wallet-injected', 'near-wallet-injected-response']);

type Win = { parent: unknown };

/** True for a wallet message that did not come from the page Rook is embedded in (at top level, none can). */
export function isForgedWalletMessage(e: { data: unknown; source: unknown }, win: Win): boolean {
  const type = typeof e.data === 'object' && e.data !== null ? (e.data as { type?: unknown }).type : undefined;
  if (typeof type !== 'string' || !FROM_EMBEDDER.has(type)) return false;
  return !(win.parent !== win && e.source === win.parent);
}

const guarded = new WeakSet<object>();

/**
 * Stops forged wallet messages before near-connect's listener sees them. A capture listener on the window runs before
 * the connector's own one, whichever was added first. Adds it once per window.
 */
export function guardWalletMessages(win: Win & Pick<EventTarget, 'addEventListener'>) {
  if (guarded.has(win)) return;
  guarded.add(win);
  win.addEventListener('message', (e) => {
    if (isForgedWalletMessage(e as MessageEvent, win)) e.stopImmediatePropagation();
  }, true);
}
