// Server-side client for the orchestrator API (docs/agentic-system.md section 8.1). It listens on localhost with no
// CORS, so the browser only ever reaches it through this app's server.
const BASE = process.env.ORCHESTRATOR_URL ?? 'http://127.0.0.1:7100';

export type TaskSummary = { id: string; status: string; prompt: string; created_at: string };

export type PlanView = {
  subtasks: { id: string; title: string; cap_atomic: string; self_do: boolean }[];
  dropped: { title: string; reason: string }[];
  budget: { reserve_atomic: string; allocated_atomic: string };
};

export type TaskView = TaskSummary & { error: string | null; plan: PlanView | null };

export class OrchestratorDown extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(BASE + path, { cache: 'no-store', ...init });
  } catch {
    throw new OrchestratorDown(`cannot reach the orchestrator at ${BASE}`);
  }
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error ?? `orchestrator answered HTTP ${r.status}`);
  return data as T;
}

export const listTasks = () => request<{ tasks: TaskSummary[] }>('/tasks').then((d) => d.tasks);

export const createTask = (prompt: string, budget_usdc: string) =>
  request<TaskView>('/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, budget_usdc }),
  });
