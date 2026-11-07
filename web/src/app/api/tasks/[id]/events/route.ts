import { ORCHESTRATOR } from '@/app/app/orchestrator';

/** Passes the orchestrator's event stream through, resuming from Last-Event-ID when the browser reconnects. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lastId = req.headers.get('last-event-id');
  try {
    const r = await fetch(`${ORCHESTRATOR}/tasks/${encodeURIComponent(id)}/events`, {
      cache: 'no-store',
      signal: req.signal,
      headers: lastId ? { 'last-event-id': lastId } : undefined,
    });
    if (!r.ok || !r.body) return new Response(null, { status: r.status });
    return new Response(r.body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
  } catch {
    return new Response(null, { status: 503 });
  }
}
