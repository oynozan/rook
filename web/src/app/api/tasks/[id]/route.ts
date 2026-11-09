import { currentAccount } from '@/app/app/session';
import { getTask, OrchestratorDown } from '@/app/app/orchestrator';

/** One task, only for the account that owns it. Anyone else gets 404, as if it didn't exist. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = await currentAccount();
  if (!account) return Response.json({ error: 'not signed in' }, { status: 401 });
  try {
    const snap = await getTask(id);
    if (snap.task.owner !== account) return Response.json({ error: `no task ${id}` }, { status: 404 });
    return Response.json(snap, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    if (e instanceof OrchestratorDown) return Response.json({ error: 'services are not running' }, { status: 503 });
    return Response.json({ error: `no task ${id}` }, { status: 404 });
  }
}
