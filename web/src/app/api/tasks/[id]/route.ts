import { fundingSent } from '@/lib/server/db';
import { currentAccount } from '@/lib/server/session';
import { getTask, OrchestratorDown, OrchestratorError } from '@/lib/server/orchestrator';
import { chatDeleted } from '@/lib/refusals';

/** One task, only for the account that owns it. Anyone else gets 404, as if it didn't exist. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = await currentAccount();
  if (!account) return Response.json({ error: 'not signed in' }, { status: 401 });
  let snap;
  try {
    snap = await getTask(id, account);
  } catch (e) {
    // Only the orchestrator's 404 means no such task (`deleted`: this account deleted its chat, which the page says).
    // Anything else (down, ROOK_SERVICE_TOKEN differs, a 500): the page says the services are unreachable and tries again.
    if (e instanceof OrchestratorError && e.status === 404) {
      return Response.json({ error: `no task ${id}`, ...(chatDeleted(e.status, e.message) ? { deleted: true } : {}) }, { status: 404 });
    }
    if (!(e instanceof OrchestratorDown)) console.error(`[web] task ${id}:`, e instanceof Error ? e.message : e);
    return Response.json({ error: 'services are unreachable' }, { status: 503 });
  }
  if (snap.task.owner !== account) return Response.json({ error: `no task ${id}` }, { status: 404 });
  // A funding transfer already sent from this account's wallet, so the page offers "confirm" rather than a second
  // transfer; and, for a task stopped before Rook bound that transfer, so the page says where the USDC is.
  // A failure here is this server's own (its store), so it surfaces as an error, never as "no task".
  const unbound = snap.task.status === 'approved' || (snap.task.status === 'killed' && !snap.ledger);
  snap.funding_sent = unbound ? fundingSent(id, account) : null;
  return Response.json(snap, { headers: { 'cache-control': 'no-store' } });
}
