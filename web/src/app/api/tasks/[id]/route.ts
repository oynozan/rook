import { ORCHESTRATOR } from '@/app/app/orchestrator';

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const r = await fetch(`${ORCHESTRATOR}/tasks/${encodeURIComponent(id)}`, { cache: 'no-store' });
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
  } catch {
    return Response.json({ error: 'services are not running' }, { status: 503 });
  }
}
