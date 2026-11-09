import { currentAccount } from '@/app/app/session';
import { eventsUrl, getTask, OrchestratorError, serviceHeaders } from '@/app/app/orchestrator';

/** Passes the orchestrator's event stream through for the task's owner, resuming from Last-Event-ID on reconnect. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = await currentAccount();
  if (!account) return new Response(null, { status: 401 });
  try {
    const snap = await getTask(id, account);
    if (snap.task.owner !== account) return new Response(null, { status: 404 });
  } catch (e) {
    return new Response(null, { status: e instanceof OrchestratorError && e.status === 404 ? 404 : 503 }); // as GET /api/tasks/:id
  }
  const lastId = req.headers.get('last-event-id');
  try {
    const r = await fetch(eventsUrl(id, account), {
      cache: 'no-store',
      signal: req.signal,
      headers: { ...serviceHeaders(), ...(lastId ? { 'last-event-id': lastId } : {}) },
    });
    if (!r.ok || !r.body) return new Response(null, { status: r.status });
    return new Response(r.body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
  } catch {
    return new Response(null, { status: 503 });
  }
}
