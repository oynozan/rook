// Rook's own error texts, made fit for the page when no plainer sentence covers them: the problem is named on the page
// rather than replaced by "try again". Pure functions, so the tests use them. Run: npx tsx --test test/*.test.ts (from web/)

/**
 * The local services by port (services/src/shared/config.ts), so "127.0.0.1:7106" reads as what it is. ponytail:
 * default ports only; a setup that moves them (ORCHESTRATOR_PORT, ...) would need these read from the same variables.
 */
const SERVICES: Record<string, string> = {
  '7100': 'the orchestrator', '7101': 'the planner', '7102': 'the evaluator', '7103': 'the market gateway',
  '7104': 'the simulator', '7105': 'the signer', '7106': 'the chain gateway',
};
const MAX = 240;

/**
 * An internal error text, safe and short enough to show: one line; a local service's URL named by the service; no
 * query strings (an RPC URL can carry an API key there); keys masked; at most MAX characters; no closing full stop.
 */
export function detail(raw: unknown): string {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim()
    .replace(/(\b[A-Z]{3,7} )?https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{4})(\/\S*)?/g, (all, verb: string | undefined, port: string, path = '') =>
      SERVICES[port] ? `${SERVICES[port]}${path || verb ? ` (${verb ?? ''}${path.replace(/\?\S*/, '')})` : ''}` : all)
    .replace(/(https?:\/\/[^\s?]+)\?\S*/g, '$1')
    .replace(/ -> (\d{3})\b/g, ' answered HTTP $1')
    .replace(/(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{20,}/g, '$1:…')
    .replace(/[\s.]+$/, '');
  if (s.length > MAX) s = `${s.slice(0, MAX - 1).trimEnd()}…`;
  return s;
}

/** The orchestrator never answered: every call goes through it. A clause, to end with the action's own words. */
export const DOWN = "Rook's orchestrator isn't answering (it is stopped or restarting)";

/** The orchestrator answered 401: the two sides hold different service tokens, which no retry fixes. */
export const TOKEN_MISMATCH = "this web app's ROOK_SERVICE_TOKEN doesn't match the orchestrator's, so the orchestrator turns every request from it away. "
  + "Trying again won't help: whoever runs Rook has to give both the same token";

/**
 * Why one call to Rook failed, as a clause to follow "Rook couldn't …: ". `status`: the orchestrator's HTTP status,
 * or null when the failure was this web server's own (or the orchestrator gave none).
 */
export function cause(status: number | null, message: string): string {
  const said = detail(message);
  if (status === 401) return TOKEN_MISMATCH;
  if (status === null) return said ? `something failed on Rook's side (${said})` : "something failed on Rook's side";
  // Node's fetch says only "fetch failed" when a service behind the orchestrator (planner, gateways, signer) is down.
  if (status >= 500 && /fetch failed|ECONNREFUSED|ECONNRESET|other side closed|socket hang up/i.test(said)) return `a service behind Rook's orchestrator didn't answer (${said})`;
  if (status >= 500) return `Rook's orchestrator hit an error (${said || `HTTP ${status}`})`;
  return `Rook's orchestrator refused it (${said || `HTTP ${status}`})`;
}

/** Whether asking again may work: a failure on Rook's side might pass; a refusal or a token mismatch repeats. */
export const mayPass = (status: number | null) => status === null || status >= 500;

/** "<lead>: <cause>.", with "Try again in a moment." when asking again may work. */
export const failed = (lead: string, status: number | null, message: string) =>
  `${lead}: ${cause(status, message)}.${mayPass(status) ? ' Try again in a moment.' : ''}`;

/**
 * A call from the page to this web server never came back: the browser is offline, or the server is down, restarting
 * or was redeployed (an action the page knows is gone).
 */
export const pageUnreachable = (e: unknown) =>
  `This page got no answer from Rook's web server (${detail(e instanceof Error ? e.message : e) || 'no reason given'}). `
  + 'Check your connection; if it works, the server may be restarting, so reload the page and try again.';
