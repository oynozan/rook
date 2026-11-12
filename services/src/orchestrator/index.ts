// Orchestrator HTTP API (docs/agentic-system.md section 8.1). No side effects on import.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { config, MAX_PROMPT_CHARS } from '../shared/config.ts';
import { bigintReplacer, call, HttpError, serve, type Ctx, type Routes, type Running } from '../shared/http.ts';
import { budgetBacked, formatUsdc, namedBudgetProblem, parseUsdc } from '../shared/money.ts';
import { CONVERSATION_MESSAGES, CONVERSATION_REPORT_CHARS, type AgentHistory, type Conversation, type Plan, type RookEvent, type X402Config } from '../shared/types.ts';
import { attack } from './attack.ts';
import { createChainLedger } from './chain-ledger.ts';
import { createLedger, type Ledger } from './ledger.ts';
import { blockedBy, contractTaskOf, kill, restoreTask, runTask, SHUTDOWN } from './runner.ts';
import { openStore } from './db.ts';
import { agentApi, sleep, USDC_ASSET, USDC_CONTRACT } from '../wallet/api.ts';
import { createSweeper, fundingActive, runFunding, type FundDeps } from '../wallet/fund.ts';
import { createWallets, IntentBody, refusal } from '../wallet/index.ts';
import { budgetCovers, usdcAtomic } from '../wallet/policy.ts';
import { createWalletStore } from '../wallet/store.ts';
import {
  ancestors, attempts, emit, fromDoc, headOf, isFree, isTerminal, newTask, openPlan, persistWith, saveTask, setPlan, setStatus, snapshot, taskView, toDoc, verdictHistory, type Task,
} from './store.ts';
import { conversationTasks, questionsFor, supersedeRefusal, workspaceOf } from './store.ts';

const CreateBody = z.object({
  prompt: z.string().trim().min(1),
  budget_usdc: z.union([z.string(), z.number()]),
  reserve_share: z.number().min(0).max(0.9).optional(),
  owner: z.string().min(2).max(64).optional(), // set by the web app from a verified wallet sign-in
  wait: z.boolean().optional(), // false: answer at once with the draft task and plan in the background (progress as events)
  parent_id: z.string().min(1).max(64).optional(), // the conversation's newest task: this message follows it
  supersedes: z.string().min(1).max(64).optional(), // the newest message, sent again or edited: this one takes its place
});

/** The share of the budget the planner holds back for re-hires before it hires anyone, unless the caller names one. */
const DEFAULT_RESERVE_SHARE = 0.2;
/** A plan made at a total budget the message never names (the planner's model read one into it): never kept. */
export const BUDGET_NOT_NAMED = "Rook's planner set a budget your message doesn't name, so this plan wasn't kept. Send your message again.";
/** A message about a deleted conversation, for a caller naming no owner (an owner gets 404). */
const DELETED = 'This conversation was deleted.';

/** Up to 5 names, then how many more. */
const named = (names: string[]) => names.length > 5 ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more` : names.join(', ');

/**
 * What the planner gets with a follow-up: the earlier messages (the first and the newest when there are too many), the
 * newest report in the conversation cut to size, the chat's current files whole (workspaceOf: they travel apart from
 * the report, so a follow-up works on the complete work), what Rook asked when the message answers it, and, for a
 * revision, the parts of the plan it changes as the user saw them, with what the planner keeps of each: its criteria,
 * search terms, category, inputs, whether Rook may write it and why Rook does it. `revises`: the plan this message
 * changes, if any.
 */
export function conversationFor(chain: Task[], revises: Task | null, ws = workspaceOf(chain)): Conversation {
  const prompts = chain.map((x) => x.prompt).reverse();
  const earlier = prompts.length > CONVERSATION_MESSAGES ? [prompts[0], ...prompts.slice(-(CONVERSATION_MESSAGES - 1))] : prompts;
  const c: Conversation = { earlier, revising: revises !== null };
  const md = chain.find((x) => x.final_result?.final_markdown.trim())?.final_result!.final_markdown.trim();
  if (md) {
    // Files left out for size are named at the end: the planner knows the files it got are not all the chat has.
    const note = ws.left.length ? `\n\n[Left out of the files sent with this message, for size: ${named(ws.left)}.]` : '';
    const CUT = '\n\n[The rest of the report is left out here.]';
    const room = CONVERSATION_REPORT_CHARS - note.length;
    c.report = (md.length > room ? md.slice(0, room - CUT.length) + CUT : md) + note;
  }
  if (ws.files.length) c.files = ws.files.map((f) => ({ path: f.name, text: f.text }));
  const questions = questionsFor(chain);
  if (questions?.length) c.questions = questions;
  if (revises?.subtasks.length) {
    c.plan = revises.subtasks.slice(0, 10).map((s) => ({
      title: s.title, brief: s.brief, criteria: s.criteria, search_terms: s.search_terms,
      ...(s.category ? { category: s.category } : {}), ...(s.self_do_ok !== undefined ? { self_do_ok: s.self_do_ok } : {}),
      ...(s.inputs?.length ? { inputs: s.inputs } : {}), ...(s.self_do_reason ? { self_do_reason: s.self_do_reason } : {}),
    }));
  }
  return c;
}

/**
 * Asks the planner for a plan, relaying its progress lines as `planning` events. A planner that answers with plain
 * JSON (an older one, or a test double) still works: there is just no progress to relay. `history`: Rook's own
 * verdicts per agent and its recent hires that never reached work (store.ts verdictHistory), which the planner ranks
 * candidates with. `min`: the contract's smallest budget, which a total
 * the message names must meet too.
 */
async function planWithProgress(t: Task, history: Record<string, AgentHistory>, min: bigint, conversation?: Conversation): Promise<Plan> {
  emit(t, 'planning', { stage: 'drafting' });
  const r = await fetch(config.urls.planner + '/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson, application/json' },
    body: JSON.stringify({ task_id: t.id, prompt: t.prompt, budget_atomic: t.budget_atomic, reserve_share: t.reserve_share, min_budget_atomic: min.toString(), history, conversation }),
    signal: t.abort.signal,
  });
  if (!(r.headers.get('content-type') ?? '').includes('ndjson')) {
    const j: any = await r.json().catch(() => null);
    if (!r.ok) throw new HttpError(r.status, j?.error ?? `planner answered HTTP ${r.status}`, j?.details);
    return j as Plan;
  }
  const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    buf += value ?? '';
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.type === 'progress') { const { type: _, ...p } = m; if (!isTerminal(t.status)) emit(t, 'planning', p); }
      else if (m.type === 'plan') return m.plan as Plan;
      else if (m.type === 'error') throw new HttpError(m.status ?? 502, m.error ?? 'planner failed', m.details);
    }
    if (done) throw new HttpError(502, 'planner ended without a plan');
  }
}

const digest = (s: string) => createHash('sha256').update(s).digest();
const num = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= 0 && process.env[k] !== '' && process.env[k] !== undefined ? v : d; };
/** With ROOK_SERVICE_TOKEN set, every route needs `x-rook-token` (constant-time compare); 401 otherwise. */
function guard(routes: Routes): Routes {
  const token = config.serviceToken;
  if (!token) return routes;
  const want = digest(token);
  return Object.fromEntries(Object.entries(routes).map(([k, h]) => [k, (ctx: Ctx) => {
    const got = ctx.req.headers['x-rook-token'];
    if (typeof got !== 'string' || !timingSafeEqual(digest(got), want)) throw new HttpError(401, 'missing or wrong x-rook-token');
    return h(ctx);
  }]));
}

export async function start(port = config.ports.orchestrator): Promise<Running> {
  const tasks = new Map<string, Task>();
  const chain = config.ledger === 'chain' ? createChainLedger() : null;
  const ledger: Ledger = chain ?? createLedger();
  const claims = new Set<string>(); // task ids and `cid:<contract task>` with a /funded check in flight
  const get = (id: string) => {
    const t = tasks.get(id);
    if (!t) throw new HttpError(404, `no task ${id}`);
    return t;
  };
  // The web app passes the signed-in account as `owner` (body, or ?owner= on a GET); someone else's task looks like no
  // task at all. Callers that pass no owner (the CLI) act on any task: the orchestrator listens on localhost only, and
  // with ROOK_SERVICE_TOKEN set only callers holding the token (the web server, the CLI) reach it. A task of a deleted
  // conversation is gone for its owner too, who is told why (nobody else learns it existed), while the CLI still sees it.
  const owned = (id: string, owner: unknown) => {
    const t = get(id);
    if (typeof owner === 'string' && t.owner !== owner) throw new HttpError(404, `no task ${id}`);
    if (typeof owner === 'string' && t.deleted_at) throw new HttpError(404, `no task ${id}: its conversation was deleted`);
    return t;
  };
  /** A newer message is being planned as a revision of `t`, a planned task: its plan replaces `t` once ready (8.9). */
  const beingRevised = (t: Task) => t.status === 'planned' && [...tasks.values()].some((x) => {
    const parent = x.status === 'draft' && x.parent_id !== null ? tasks.get(x.parent_id) : undefined;
    return parent !== undefined && openPlan(ancestors(parent, tasks)) === t;
  });

  // With ROOK_DB set, tasks survive restarts. A plan waiting for approval carries on, and so does a chain-mode task
  // waiting for its funding transaction. A chain-mode task bound to a contract task is rebuilt from the contract before
  // the API listens (a rebuild that fails is tried again after it listens), then resumed (or, killed or failed with
  // money still on chain, unwound). Any other task that was mid-run is marked failed, or closed when only the close was
  // left after its report: a sim-ledger task's balances lived in memory only.
  const db = config.dbPath ? openStore(config.dbPath) : null;
  const resumeFunding: Task[] = [];
  if (db) {
    for (const doc of db.load()) tasks.set(doc.id, fromDoc(doc));
    persistWith((t) => {
      if (!tasks.has(t.id)) return;
      if (chain) t.chain = chain.binding(t.id) ?? t.chain ?? null; // contract task, sub-accounts, outstanding authorizations
      db.save({ ...toDoc(t), ledger_saved: ledger.view(t.id) ?? t.ledger_saved ?? null });
    });
    const resume: (() => Promise<void>)[] = [];
    for (const t of tasks.values()) {
      if (t.status === 'planned' && !t.subtasks.length) {
        // Stored before an empty plan ended its task: nothing can be approved, so it ends as a new one would.
        t.error = emptyPlanReason(t.plan?.dropped ?? []);
        emit(t, 'error', { kind: 'no_plan', message: t.error });
        setStatus(t, 'failed');
        continue;
      }
      const waiting = t.status === 'planned' || (chain !== null && t.status === 'approved' && !t.chain && !isFree(t));
      // Funding from the owner's agent wallet, cut short by the restart: picked up at its step once the API listens.
      if (waiting && t.status === 'approved' && fundingActive(t)) resumeFunding.push(t);
      if (waiting || t.status === 'closed' || t.status === 'cancelled') continue;
      if (chain && t.chain && !(t.ledger_saved as { closed?: boolean } | undefined)?.closed) {
        const next = await restoreTask(chain, t);
        if (next) resume.push(next);
        continue;
      }
      // A simulated ledger lived in memory only: its books still open before the restart (a run, or a stopped task's
      // refund, under way) would show a refund under way for good. Closed ones show what the task spent and refunded.
      if (!chain && (t.ledger_saved as { closed?: boolean } | null | undefined)?.closed === false) t.ledger_saved = null;
      if (isTerminal(t.status)) continue;
      if (t.status === 'closing' && t.final_result) {
        // Only the close was left, and nothing of it can resume here (a simulated ledger, or a plan that hires no agent,
        // holds nothing on chain): the report stands, so the task ends closed, never failed.
        setStatus(t, 'closed');
        continue;
      }
      t.error = `Rook's services restarted while this task was ${t.status}, so it stopped there. ${isFree(t)
        ? 'It hired no agent, so nothing was paid.'
        : chain
        ? 'It has no contract task on record, so nothing of it is on chain to resume.'
        : 'Its simulated ledger lived in memory only, so the run cannot resume; no real money was involved.'}`;
      emit(t, 'error', { kind: 'restart', message: t.error });
      setStatus(t, 'failed');
    }
    for (const go of resume) void go().catch((e) => console.error('[orchestrator] resume after restart', e));
    console.log(`[orchestrator] ${tasks.size} task${tasks.size === 1 ? '' : 's'} loaded from ${config.dbPath}${resume.length ? `, ${resume.length} resumed from the chain` : ''}`);
  }

  // A killed or failed task returns its money after the terminal status; its stream stays open until then. In chain
  // mode only a task bound to a contract task holds money (a plan that hires no agent has books of 0, never on chain),
  // and so does one whose rebuild after a restart is being tried again: its books come back, then its money.
  // The unwind retries until the books close, so a stream can stay open for minutes; each problem streams once.
  const moving = (t: Task) => t.restoring === true
    || (ledger.view(t.id)?.closed === false && (chain === null || chain.contractTaskOf(t.id) !== null));
  /**
   * The task holds money, or may: approved (its funding may be in flight), running, closing, or ended with its books
   * still open (the refund is on its way, or, in chain mode, books not rebuilt yet after a restart). In chain mode a
   * task funded on another contract holds none here: nothing here can move its money. Deleting its chat stops it if it
   * hasn't ended, so a Rook that runs that contract returns its money instead of resuming a run its owner can't see.
   */
  const holdsMoney = (t: Task) => {
    if (t.stranded === 'other_contract') return false;
    if (['approved', 'funded', 'running', 'aggregating', 'closing'].includes(t.status) || t.unwinding || t.restoring || t.stranded) return true;
    if (!chain) return ledger.view(t.id)?.closed === false;
    // Funded here: books not known yet (a restart) count as open. Funded on another contract: nothing here can move it.
    const ours = chain.contractTaskOf(t.id) !== null || (!!t.chain && (!t.chain.contract_id || t.chain.contract_id === config.contractId));
    if (!ours) return false;
    const books = (ledger.view(t.id) ?? t.ledger_saved) as { closed?: boolean } | null | undefined;
    return books?.closed !== true;
  };
  /** Why a conversation with `t` in it can't be deleted yet, in words the web app shows as they are. */
  const deleteRefusal = (t: Task) => {
    // Its books can't be rebuilt after a restart, so Rook can't send back what it holds without its operator.
    if (t.stranded === 'misfit') return "A task in this chat still holds USDC that Rook can't send back by itself, so Rook's operator has to. Until then this chat can't be deleted.";
    // Its agent wallet funding can't be cancelled, only stopped: USDC may be on its way between the wallet and the contract.
    if (fundingActive(t)) return 'A plan in this chat is being funded from your agent wallet. Wait for it, or stop it on its page, then delete the chat.';
    if (t.status === 'approved' && chain && !isFree(t) && !chain.contractTaskOf(t.id)) return 'A plan in this chat is waiting for its funding. Cancel it on its page first, then delete the chat.';
    if (['approved', 'funded', 'running', 'aggregating'].includes(t.status)) return 'A run in this chat is still under way. Stop it or let it finish, then delete the chat.';
    return 'Rook is still returning the unspent USDC of a task in this chat. Delete the chat once it is back in your wallet.';
  };
  /**
   * Runs a plan that hires no agent (every subtask self_do): it pays no one, so it has books of 0 and, in chain mode, no
   * funding transfer or contract task. `funder`: the name the sim ledger books it to.
   */
  const startFree = (t: Task, funder: string) => {
    t.funder = chain ? t.owner : funder;
    setStatus(t, 'approved');
    void runTask(ledger, t).catch((e) => console.error('[orchestrator] runTask', e));
  };
  /** The contract's settings, read once from the chain-gateway (null until it answers). */
  let chainCfg: ChainCfg | null = null;
  const contractCfg = async (): Promise<ChainCfg | null> => {
    if (chain && !chainCfg) {
      chainCfg = await call(`${config.urls.chainGateway}/config`).then((c: any) => ({
        contract_id: c.contract_id ?? null, usdc: c.usdc ?? null, owner: c.owner ?? null,
        min_budget: /^\d+$/.test(String(c.min_budget ?? '')) ? BigInt(c.min_budget) : 0n,
        max_open_tasks: Number.isInteger(c.max_open_tasks) ? c.max_open_tasks : null,
      }), () => null);
    }
    return chainCfg;
  };
  // ---- Agent wallet (docs/agent-wallet-plan.md): the owner's NEAR Intents Agent API wallet funds their tasks ----
  const api = agentApi();
  const gapMs = num('ROOK_WALLET_GAP_MS', 2000);
  const nativeBalance = (account: string) =>
    call(`${config.urls.chainGateway}/balance?account=${encodeURIComponent(account)}&token=${USDC_CONTRACT}`).then((r: any) => String(r.balance));
  const wallets = createWallets({
    api, store: createWalletStore(db), tasks: () => tasks.values(), settleMs: num('ROOK_WALLET_SETTLE_MS', 90_000), gapMs,
    nativeBalance: (account) => (chain ? nativeBalance(account).catch(() => null) : Promise.resolve(null)),
  });
  const sweeper = createSweeper({ api, wallets, tasks: () => tasks.values(), gapMs, approvalGapMs: 0, nativeBalance });
  /** Wallet routes act for a signed-in account only: it must be named. */
  const ownerOf = (v: unknown) => {
    if (typeof v !== 'string' || v.length < 2) throw new HttpError(400, 'owner is required');
    return v;
  };
  const fundDeps: FundDeps = {
    api, wallets, tasks: () => tasks.values(), gapMs, approvalGapMs: num('ROOK_WALLET_APPROVAL_GAP_MS', 10_000),
    sweep: (owner) => (chain ? sweeper.sweep(owner) : Promise.resolve()),
    bind: async (t, cid, funder) => {
      await bindFunded(t, cid, funder);
      void t.running?.finally(() => sweeper.sweep(t.owner!)); // what the close returns to the wallet's account goes back in
    },
  };
  /** Runs `t`'s wallet funding from its step, with the transfer its plan asks for. */
  const startFunding = async (t: Task, reprint: boolean) => {
    const transfer = await fundingInstructions(t, await contractCfg(), reprint, wallets.ready(t.owner!)?.near_account_id ?? null);
    await runFunding(fundDeps, t, transfer);
  };

  /**
   * Binds contract task `cid` to `t` once it matches the approved plan and was funded by `funder` (null: any account, a
   * CLI task), then runs it. The user's own transfer (/funded) and an agent wallet's (wallet/fund.ts) both end here.
   */
  async function bindFunded(t: Task, cid: string, funder: string | null) {
    if (!chain) throw new HttpError(409, 'only with ROOK_LEDGER=chain');
    if (t.status !== 'approved') throw new HttpError(409, `task is ${t.status}, funded needs approved`);
    const bound = chain.contractTaskOf(t.id);
    if (bound !== null) throw new HttpError(409, `task is already funded by contract task ${bound}`);
    for (const other of tasks.values()) if (chain.contractTaskOf(other.id) === cid) throw new HttpError(409, `contract task ${cid} already funds ${other.id}`);
    // Claimed before the await, so two overlapping binds cannot both bind and run.
    if (claims.has(t.id) || claims.has(`cid:${cid}`)) throw new HttpError(409, `task ${t.id} or contract task ${cid} is already being checked`);
    claims.add(t.id).add(`cid:${cid}`);
    try {
      const { task: ct, subtasks } = await call(`${config.urls.chainGateway}/task/${cid}`);
      const want = expected(t);
      const bad = [
        ct.budget !== t.budget_atomic && `budget ${ct.budget} is not ${t.budget_atomic}`,
        ct.reserve !== want.reserve && `reserve ${ct.reserve} is not ${want.reserve}`,
        JSON.stringify(ct.caps) !== JSON.stringify(want.caps) && `caps ${JSON.stringify(ct.caps)} are not the plan's ${JSON.stringify(want.caps)}`,
        (ct.status !== 'Open' || ct.killed) && `contract task is ${ct.killed ? 'killed' : ct.status}`,
        // A signed-in owner binds only a contract task their own wallet (or their agent wallet) funded, never someone
        // else's matching one.
        funder !== null && ct.funder !== funder && `it was funded by ${ct.funder}, not by ${funder === t.owner ? 'the task owner ' : ''}${funder}`,
        subtasks.length > 0 && 'contract task already has funded subtasks',
      ].filter(Boolean);
      if (bad.length) throw new HttpError(409, `contract task ${cid} does not match the approved plan: ${bad.join('; ')}`);
      if (t.status !== 'approved') throw new HttpError(409, `task is ${t.status}, funded needs approved`); // killed meanwhile
      chain.bind(t.id, cid, want.nmap);
      t.funder = ct.funder;
      void runTask(ledger, t).catch((e) => console.error('[orchestrator] runTask', e));
    } finally {
      claims.delete(t.id); claims.delete(`cid:${cid}`);
    }
  }

  const running = await serve('orchestrator', guard({
    'POST /tasks': async ({ body }) => {
      const b = CreateBody.parse(body ?? {});
      if (b.prompt.length > MAX_PROMPT_CHARS) throw new HttpError(400, `prompt is ${b.prompt.length} characters; the limit is ${MAX_PROMPT_CHARS}`);
      let budget: bigint;
      try { budget = parseUsdc(b.budget_usdc); } catch (e: any) { throw new HttpError(400, e.message); }
      if (budget <= 0n) throw new HttpError(400, 'budget_usdc must be positive');
      const max = config.maxBudgetAtomic;
      if (budget > max) throw new HttpError(400, `budget ${formatUsdc(budget)} USDC is above this Rook's limit of ${formatUsdc(max)} USDC (ROOK_MAX_BUDGET_USDC)`);
      const min = (await contractCfg())?.min_budget ?? 0n;
      if (budget < min) throw new HttpError(400, `budget ${formatUsdc(budget)} USDC is below the contract's minimum of ${formatUsdc(min)} USDC`);
      // A message sent again or edited takes the place of the newest one: it follows the same task (8.9).
      const old = b.supersedes === undefined ? null : owned(b.supersedes, b.owner);
      if (old) {
        if (b.parent_id !== undefined && b.parent_id !== old.parent_id) throw new HttpError(400, `parent_id must be ${old.parent_id ?? 'left out'}: a message sent again keeps its place`);
        if (old.owner !== (b.owner ?? null)) throw new HttpError(409, `task ${old.id} has another owner: a message sent again keeps its owner`);
        const why = old.deleted_at ? DELETED : supersedeRefusal(old, tasks.values());
        if (why) throw new HttpError(409, why);
      }
      // A message in a conversation follows its newest task. Checked after the last await, so two messages sent at once
      // cannot both follow the same task.
      const parentId = old ? old.parent_id : b.parent_id;
      const parent = parentId == null ? null : owned(parentId, b.owner);
      const above = parent ? ancestors(parent, tasks) : []; // the parent and the tasks above it, nearest first
      // What the message acts on: the parent, or the task above replies that never got a plan (a run under way, say).
      const head = headOf(above);
      if (parent && head) {
        if (parent.deleted_at) throw new HttpError(409, DELETED);
        if (parent.owner !== (b.owner ?? null)) throw new HttpError(409, `task ${parent.id} has another owner: a follow-up keeps its owner`);
        if (head.status === 'draft') throw new HttpError(409, 'Wait for the plan to be ready before sending more.');
        // Chain mode, approved and not funded yet: no run has started, the funding step waits for the wallet.
        if (head.status === 'approved' && chain && !isFree(head) && !chain.contractTaskOf(head.id)) throw new HttpError(409, 'Fund or cancel the plan above before sending more.');
        // A run whose report is written has finished: only its refund is left (closing), so it takes a follow-up.
        const finished = isTerminal(head.status) || (head.status === 'closing' && head.final_result !== null);
        if (head.status !== 'planned' && !finished) throw new HttpError(409, 'Wait for this run to finish, or stop it, before sending more.');
        // A superseded message is no longer the newest: the message that took its place is.
        const newer = parent.superseded_by || [...tasks.values()].some((x) => x.parent_id === parent.id && x !== old && !x.superseded_by);
        if (newer) throw new HttpError(409, 'This conversation has a newer message: send after the newest one.');
      }
      // A message sent again or edited in the place of a revision whose plan already replaced the plan above (or of a
      // message sent in such a revision's place) revises that plan too: cancelled as replaced, it never ran.
      const replaced = old && head?.status === 'cancelled' && head.replaced_by && attempts(old, tasks).some((x) => x.id === head.replaced_by) ? head : null;
      const revises = openPlan(above) ?? replaced;
      const ws = workspaceOf(above);
      const conversation = parent ? conversationFor(above, revises, ws) : undefined;
      const t = newTask(b.prompt, budget, b.reserve_share ?? DEFAULT_RESERVE_SHARE, b.owner ?? null, parent?.id ?? null);
      if (conversation) t.earlier_prompts = conversation.earlier;
      // What its parts' inputs are attached from, and its report's files start from. ponytail: the task doc carries it,
      // so each save writes it again (up to CONVERSATION_FILES_CHARS); a table of files keyed by content would end that.
      if (ws.files.length) t.workspace = ws.files;
      if (old) Object.assign(t, { supersedes: old.id, edited: t.prompt !== old.prompt || t.budget_atomic !== old.budget_atomic });
      tasks.set(t.id, t);
      saveTask(t);
      if (old) {
        old.superseded_by = t.id;
        if (old.status === 'draft') kill(ledger, old); // its planning stops
        else if (old.status === 'planned') setStatus(old, 'cancelled');
        saveTask(old);
      }
      const planning = (async () => {
        try {
          // A kill during planning aborts the wait. ponytail: the planner does not watch the disconnect, so its LLM
          // calls for this plan still finish (and are not in this task's cost).
          const plan = await planWithProgress(t, verdictHistory(tasks.values()), min, conversation);
          if (isTerminal(t.status)) return;
          if (plan.budget.from_message) {
            // The total the message names ("make it 1 USDC", 5.1) is the task's budget, within the same limits as one sent.
            // Only a message that names an amount can set it: a model mistake never moves the money.
            const problem = budgetBacked(t.prompt, BigInt(plan.budget.budget_atomic)) ? namedBudgetProblem(BigInt(plan.budget.budget_atomic), min, max) : BUDGET_NOT_NAMED;
            if (problem) {
              t.error = problem;
              emit(t, 'error', { kind: 'planner', message: problem });
              setStatus(t, 'failed');
              return;
            }
            t.budget_atomic = plan.budget.budget_atomic;
          }
          // A plan that asks has nothing to run: never funded on facts it says it lacks.
          const asking = !!plan.questions?.length;
          if (asking && plan.subtasks.length) plan.subtasks = [];
          // What the user should know before funding, in plain words: files this chat couldn't send whole. A part whose
          // files are too large to send blocks the plan: it is shown, with why, and /approve refuses it (a note was
          // hidden, the plan funded, and the part left out only at run time).
          plan.notes ??= [];
          if (ws.left.length) plan.notes.push(`This chat's files are too many or too large to send whole, so Rook left out the ones delivered longest ago: ${named(ws.left)}.`);
          setPlan(t, plan);
          const blocked = blockedBy(t);
          if (blocked) plan.blocked = plan.blocked ? `${plan.blocked} ${blocked}` : blocked; // after the planner's own, if any
          emit(t, 'plan', plan);
          if (asking) {
            // Facts only the user can give are missing: Rook asks them instead of planning. Not a failure (no error),
            // and the next message in the chat answers them (Conversation.questions). A plan it revises stays as it was.
            setStatus(t, 'asking');
            return;
          }
          if (!plan.subtasks.length && plan.spending && !plan.dropped.length) {
            // A message that only states spending rules ("from now on, ask me before every payment"): the plan holds the
            // rules for the agent wallet and no part. Shown as planned; /approve refuses it (no subtasks).
            setStatus(t, 'planned');
            return;
          }
          if (!plan.subtasks.length) {
            // Every part was dropped: nothing can be approved, so the task ends here, keeping the plan for its drop list.
            // The budget that would hire one is worked out at the reserve share the planner was sent (setPlan replaced it).
            t.error = emptyPlanReason(plan.dropped, b.reserve_share ?? DEFAULT_RESERVE_SHARE);
            emit(t, 'error', { kind: 'no_plan', message: t.error });
            setStatus(t, 'failed');
            return;
          }
          setStatus(t, 'planned');
          // The revised plan replaces the one it changes, unless that one was approved or cancelled meanwhile. A
          // revision that fails leaves it as it was. A plan already replaced by the revision this message took the place
          // of names this one now, the revision the conversation shows.
          if (revises?.status === 'planned') {
            revises.replaced_by = t.id;
            setStatus(revises, 'cancelled');
          } else if (replaced) {
            replaced.replaced_by = t.id;
            saveTask(replaced);
          }
          // Small edits of the chat's files that Rook makes itself (a rename, a colour) pay no one and wait on no agent:
          // they start at once, as an approved plan that hires no agent does, with no button to press. Not when blocked.
          if (!plan.blocked && isFree(t) && t.subtasks.every((s) => s.self_do_reason === 'rook_edit')) startFree(t, 'funder.sim');
        } catch (e: any) {
          if (isTerminal(t.status)) return; // killed while planning: stays killed
          // A 422 is the planner's sentence for a message that isn't a task: kept as is, for the user. The rest is internal.
          t.error = e instanceof HttpError && e.status === 422 ? e.message : `planner: ${e?.message ?? e}`;
          // A go-ahead to a plan already replaced (an edit of its revision): there is no button left to run it.
          if (revises === replaced && replaced !== null && /^That reads like a go-ahead/.test(t.error)) {
            t.error = 'That reads like a go-ahead, but the plan it answers was replaced. Say what you want done, or edit this message.';
          }
          emit(t, 'error', { kind: 'planner', message: t.error });
          setStatus(t, 'failed');
        }
      })();
      if (b.wait === false) return taskView(t); // the caller follows along on /tasks/:id/events
      await planning;
      return taskView(t);
    },

    /**
     * Which market, model and ledger this orchestrator runs with, so a client can label things honestly. No secrets.
     * `network` is 'sim' unless the ledger is the chain; `simulated`: any part is (with the sim ledger, show "simulation,
     * no money moves"; with the chain ledger, a test run on `network` where funding still moves tokens).
     */
    'GET /mode': async () => {
      const c = await contractCfg();
      return {
        market: config.market, llm: config.llm, ledger: config.ledger, network: chain ? config.nearNetwork : 'sim',
        contract_id: chain ? c?.contract_id ?? (config.contractId || null) : null, usdc: chain ? c?.usdc ?? null : null,
        paying: chain !== null, simulated: config.simulated,
        // Any signed-in account funds its own task; the contract's limits on that (null without the chain).
        min_budget_atomic: chain && c ? c.min_budget.toString() : null, max_open_tasks: chain ? c?.max_open_tasks ?? null : null,
        max_budget_atomic: config.maxBudgetAtomic.toString(), // POST /tasks refuses more (ROOK_MAX_BUDGET_USDC)
        contract_owner: chain ? c?.owner ?? null : null,
      };
    },

    // An owner sees only their own tasks; a caller naming no owner (the CLI) sees every task. `has_plan`: it got a plan
    // with something to run, which tells a failed run from a failed reply in a conversation. An owner's list leaves out
    // the tasks of conversations they deleted; `supersedes` and `superseded_by` link a message sent again or edited, and
    // `edited` says which (on the message that took the other's place).
    'GET /tasks': ({ query }) => ({
      tasks: [...tasks.values()]
        .filter((t) => !query.has('owner') || (t.owner === query.get('owner') && !t.deleted_at))
        .map(({ id, status, prompt, budget_atomic, created_at, parent_id, subtasks, supersedes, superseded_by, edited, deleted_at }) => ({
          id, status, prompt, budget_atomic, created_at, parent_id, has_plan: subtasks.length > 0,
          supersedes: supersedes ?? null, superseded_by: superseded_by ?? null, edited: edited ?? false, deleted_at: deleted_at ?? null,
        })),
    }),

    'GET /tasks/:id': ({ params, query }) => snapshot(owned(params.id, query.get('owner')), ledger),

    'POST /tasks/:id/approve': async ({ params, body }) => {
      const t = owned(params.id, body?.owner);
      const reprint = chain && !isFree(t) && t.status === 'approved' && !chain.contractTaskOf(t.id); // funding instructions again
      // Instructions for the user's own transfer while the agent wallet's is on its way would fund the plan twice.
      if (fundingActive(t)) throw new HttpError(409, 'This plan is being funded from your agent wallet.');
      if (t.status !== 'planned' && !reprint) throw new HttpError(409, `task is ${t.status}, approve needs planned`);
      if (!t.subtasks.length) throw new HttpError(409, 'the plan has no subtasks');
      if (t.plan?.blocked) throw new HttpError(409, t.plan.blocked); // its sentence, for the user as it is
      if (config.market === 'live' && !chain) {
        throw new HttpError(409, 'live market: paying agents needs ROOK_LEDGER=chain (signer, chain-gateway, budget contract); see docs/x402-payments-plan.md');
      }
      // A newer message is revising this plan, and its plan replaces this one once ready: two live plans otherwise.
      const revising = () => { if (beingRevised(t)) throw new HttpError(409, 'Wait for the revised plan below.'); };
      revising();
      if (chain && !isFree(t)) {
        // Rook never creates the task on chain: the human funds it with the caps they approve, then calls /funded.
        const funding = await fundingInstructions(t, await contractCfg(), !!reprint);
        // Sent while the funding was being read; or the plan moved on meanwhile (replaced by a revision, or stopped).
        revising();
        // A reprint whose transfer /funded bound meanwhile is funded already: no instructions for a second transfer.
        if (t.status !== (reprint ? 'approved' : 'planned') || (reprint && chain.contractTaskOf(t.id) !== null)) {
          throw new HttpError(409, `task is ${t.status}${reprint && t.status === 'approved' ? ' and already funded' : ''}, approve needs planned`);
        }
        setStatus(t, 'approved');
        return { ...taskView(t), funding };
      }
      // A plan that hires no agent (every subtask self_do) costs its funder nothing, so it starts at once in chain mode too.
      startFree(t, typeof body?.funder_account === 'string' && body.funder_account ? body.funder_account : 'funder.sim');
      return taskView(t);
    },

    /** Chain mode: the human's ft_transfer_call created contract task `contract_task_id`; check it matches the plan, then run. */
    'POST /tasks/:id/funded': async ({ params, body }) => {
      const t = owned(params.id, body?.owner);
      // The web app binds a funding transfer for the signed-in account only, so a task with an owner needs it named.
      if (t.owner !== null && body?.owner !== t.owner) throw new HttpError(403, `task ${t.id} belongs to a signed-in account: /funded must name it as owner`);
      if (!chain) throw new HttpError(409, 'only with ROOK_LEDGER=chain');
      // The agent wallet's transfer is bound by Rook itself once it lands; a second funding would strand one of them.
      if (fundingActive(t)) throw new HttpError(409, 'This plan is being funded from your agent wallet.');
      if (t.status !== 'approved') throw new HttpError(409, `task is ${t.status}, funded needs approved`);
      const cid = typeof body?.contract_task_id === 'string' ? body.contract_task_id : '';
      if (!/^[0-9a-z]+$/.test(cid)) throw new HttpError(400, 'contract_task_id is required');
      await bindFunded(t, cid, t.owner);
      return { ...taskView(t), contract_task_id: cid };
    },

    /**
     * Chain mode: funds a planned task from the owner's agent wallet instead of their own wallet (docs/agent-wallet-plan.md).
     * Checked here: the plan can be funded, the wallet is set up, the budget fits the per-task limit, the wallet holds
     * it and its budget has room. Then the task is approved and the steps run in the background (wallet/fund.ts), each
     * an event; the run starts once the contract task is bound. A failure leaves the plan to be funded again.
     */
    'POST /tasks/:id/fund-from-wallet': async ({ params, body }) => {
      const owner = ownerOf(body?.owner);
      const t = owned(params.id, owner);
      if (!chain) throw new HttpError(409, 'only with ROOK_LEDGER=chain');
      if (!wallets.configured()) throw new HttpError(409, "Rook's agent wallet isn't set up on this server.");
      if (fundingActive(t)) throw new HttpError(409, 'This plan is being funded from your agent wallet already.');
      if (t.status !== 'planned') throw new HttpError(409, `task is ${t.status}, funding needs planned`);
      if (!t.subtasks.length) throw new HttpError(409, 'the plan has no subtasks');
      if (t.plan?.blocked) throw new HttpError(409, t.plan.blocked);
      if (isFree(t)) throw new HttpError(409, 'This plan hires no agent, so it needs no funding: approve it to start.');
      if (beingRevised(t)) throw new HttpError(409, 'Wait for the revised plan below.');
      const w = wallets.ready(owner);
      if (!w) throw new HttpError(409, 'Finish setting up your agent wallet first.');
      const amount = BigInt(t.budget_atomic);
      const max = w.rules?.per_task_max_usd;
      if (max !== undefined && amount > usdcAtomic(max)) {
        throw new HttpError(409, `This task's budget is ${formatUsdc(amount)} USDC, above your limit of ${formatUsdc(usdcAtomic(max))} USDC per task.`);
      }
      if (claims.has(t.id)) throw new HttpError(409, `task ${t.id} is already being checked`);
      claims.add(t.id);
      try {
        const c = await contractCfg();
        // The wallet's policy allows calls on mainnet USDC only (the Agent API is mainnet only).
        if (c?.usdc !== USDC_CONTRACT) throw new HttpError(409, "The agent wallet pays in NEAR's mainnet USDC, which this Rook's contract doesn't take.");
        const transfer = await fundingInstructions(t, c, false, w.near_account_id);
        const [registered, balances, policy] = await Promise.all([
          call(`${config.urls.chainGateway}/registered?account=${encodeURIComponent(w.near_account_id)}&token=${USDC_CONTRACT}`).then((r: any) => r.registered === true),
          api.balances(w.agent_id, USDC_ASSET), api.policy(w.agent_id),
        ]).catch((e) => { throw refusal(e); });
        // A withdrawal to an account not registered on USDC is refused (executions.md). The user's deposit registers it
        // (storage_deposit in the same transaction): Rook's own keys are function-call keys, which attach no NEAR.
        if (!registered) throw new HttpError(409, "Your agent wallet's NEAR account can't receive USDC yet. Make a deposit from your wallet panel first: it registers the account.");
        if (policy.status !== 'APPLIED' || !policy.provider_policy_synced) throw new HttpError(409, "Your agent wallet's rules are still being applied. Try again in a minute.");
        const has = BigInt(balances.balances.find((b) => b.asset_id === USDC_ASSET)?.available_raw ?? '0');
        if (has < amount) throw new HttpError(409, `Your agent wallet holds ${formatUsdc(has)} USDC and this task needs ${formatUsdc(amount)} USDC. Deposit more first.`);
        const period = w.rules?.budget_usd !== undefined ? w.rules.period ?? 'month' : null;
        const window = period ? ({ day: 'daily', week: 'weekly', month: 'monthly' } as const)[period] : null;
        const left = window ? policy.usage.budget[window].remaining_usd : null;
        if (!budgetCovers(left, amount)) {
          throw new HttpError(409, `This task needs ${formatUsdc(amount)} USDC and your agent wallet's ${window} budget has ${left} USD left.`);
        }
        // The plan moved on while this was read (a revision replaced it, or it was cancelled or approved).
        if (t.status !== 'planned' || beingRevised(t)) throw new HttpError(409, `task is ${t.status}, funding needs planned`);
        t.wallet_funding = { state: 'withdrawing', agent_id: w.agent_id, amount_atomic: t.budget_atomic, key: `rook:${t.id}:${randomUUID().slice(0, 8)}` };
        setStatus(t, 'approved');
        void runFunding(fundDeps, t, transfer).catch((e) => console.error('[orchestrator] wallet funding', e));
        return { ...taskView(t), wallet_funding: t.wallet_funding };
      } finally {
        claims.delete(t.id);
      }
    },

    /** The signed-in owner's agent wallet (AgentWalletView); configured false without ROOK_AGENT_API_KEY. */
    'GET /wallet': ({ query }) => wallets.view(ownerOf(query.get('owner'))),

    /**
     * One owner intent to sign (OwnerIntentView): agent_create (with the rules and the owner's full-access public key),
     * policy_update (the wallet's own account as a destination; or new rules), grant_issue (Rook's grant; Rook keeps
     * the token), approval_vote (approval_id and verdict).
     */
    'POST /wallet/intents': async ({ body }) => wallets.generate(IntentBody.parse(body ?? {})),

    /** The wallet's output for an intent Rook issued to this owner: submitted, followed, then the wallet as it is now. */
    'POST /wallet/intents/:cid/submit': async ({ params, body }) => wallets.submit(ownerOf(body?.owner), params.cid, body?.signed_data),

    'POST /tasks/:id/cancel': ({ params, body }) => {
      const t = owned(params.id, body?.owner);
      if (t.status !== 'planned') throw new HttpError(409, `task is ${t.status}, cancel needs planned`);
      setStatus(t, 'cancelled');
      return taskView(t);
    },

    'POST /tasks/:id/kill': ({ params, body }) => {
      const t = owned(params.id, body?.owner);
      if (isTerminal(t.status)) throw new HttpError(409, `task is already ${t.status}`);
      // Its work is done and paid for: a kill would only end a finished task as stopped, while the unwind already sends
      // the money back.
      if (t.final_result) throw new HttpError(409, 'the report is written; Rook is only returning the unspent USDC now, so there is nothing left to stop');
      kill(ledger, t);
      if (!chain) return taskView(t);
      const cid = contractTaskOf(chain, t); // also while a restart's rebuild of its books is being tried again
      const cmd = cid === null ? null : chain.killCommand(cid, t.funder);
      return { ...taskView(t), human_action: cmd ? `The signer refuses new payments and Rook returns what the sub-accounts hold. To stop the task on the contract too, its funder (or the contract owner) calls kill_task: ${cmd}` : null };
    },

    /**
     * Security demo (`rook attack`): replays the injected deliverable's demands against the ledger's refusal paths on a
     * sandbox copy of this task's books (attack.ts). Enabled in every mode: it only reaches refusals, never money.
     */
    'POST /tasks/:id/attack': async ({ params, body }) => {
      const t = owned(params.id, body?.owner);
      const allow = t.allow.length ? t.allow : (await call<X402Config>(`${config.urls.marketGateway}/x402`)).recipients ?? [];
      return { task_id: t.id, status: t.status, ledger: config.ledger, ...attack(t, allow) };
    },

    'GET /tasks/:id/events': (ctx) => events(ctx, owned(ctx.params.id, ctx.query.get('owner')), moving),

    /**
     * Deletes the conversation task :id is in (8.9): its tasks leave the owner's list and answer 404 to the owner. They
     * stay stored, with their receipts and books, and a caller naming no owner (the CLI) still sees them. Refused while
     * any of them holds or may hold money, naming it (`details.task_id`) so the web app links its page; a plan waiting
     * for approval is cancelled, a draft's planning stopped.
     */
    'POST /conversations/:id/delete': ({ params, body }) => {
      const t = owned(params.id, body?.owner);
      const all = conversationTasks(t, tasks.values()).filter((x) => x.owner === t.owner);
      const busy = all.find(holdsMoney);
      if (busy) throw new HttpError(409, deleteRefusal(busy), { task_id: busy.id });
      const at = new Date().toISOString();
      for (const x of all) {
        if (x.status === 'draft') kill(ledger, x);
        else if (x.status === 'planned') setStatus(x, 'cancelled');
        else if (x.stranded === 'other_contract' && !isTerminal(x.status)) {
          x.abort.abort(new Error('conversation deleted'));
          emit(x, 'error', { kind: 'restore', message: 'Its conversation was deleted: stopped here, so a Rook that runs its contract returns its money instead of resuming it.' });
          setStatus(x, 'killed');
        }
        x.deleted_at ??= at;
        saveTask(x);
      }
      return { deleted: all.map((x) => x.id) };
    },
  }), port);

  // The chain-gateway may start after this service: until it answers, the funding's transfer can't be read, and a
  // funding left waiting would hold its USDC on the wallet's account with nothing to move it on.
  const resume = async (t: Task) => {
    for (let i = 0; ; i++) {
      try { return await startFunding(t, true); } catch (e) {
        if (t.shutdown.signal.aborted || !(e instanceof TypeError || (e instanceof HttpError && e.status >= 500))) throw e;
        await sleep(Math.min(60_000, gapMs * 2 ** i), t.shutdown.signal);
      }
    }
  };
  for (const t of resumeFunding) void resume(t).catch((e) => t.shutdown.signal.aborted || console.error('[orchestrator] wallet funding resume', e));
  // What runs leave on agent wallets' NEAR accounts (refunds at close, a funding that stopped half way) goes back into
  // their NEAR Intents balances. ponytail: one balance read per set-up wallet per pass, no index of which wallets moved.
  const sweeps = chain && wallets.configured() ? setInterval(() => void sweeper.pass(), num('ROOK_WALLET_SWEEP_MS', 120_000)) : null;
  sweeps?.unref();

  return {
    ...running,
    close: async () => {
      if (sweeps) clearInterval(sweeps);
      for (const t of tasks.values()) {
        t.shutdown.abort(); // an unwind stops retrying; the next start resumes it
        if (!isTerminal(t.status)) t.abort.abort(new Error(SHUTDOWN)); // restore depends on it
      }
      await running.close();
      persistWith(null);
      db?.close();
    },
  };
}

/**
 * Why a plan with no subtasks can't run, in plain words, from its drop reasons (plan.ts buildPlan). When every part
 * costs more than the budget and each says what its cheapest agent asks (need_atomic), it names those prices and the
 * budget that would hire one for each, in the web app's words (web/src/lib/planner.ts selfDoWhy), never past the
 * largest budget Rook takes. `reserveShare`: the share of the budget the planner held back before hiring.
 */
export function emptyPlanReason(dropped: Plan['dropped'], reserveShare = DEFAULT_RESERVE_SHARE): string {
  const over = dropped.some((d) => d.reason === 'over budget');
  const none = dropped.some((d) => d.reason !== 'over budget');
  if (over && none) return 'No agent on the market can do some parts of this task, and the others cost more than this budget allows.';
  if (!over) return 'No agent on the market can do any part of this task.';
  const needs = dropped.map((d) => (/^\d+$/.test(d.need_atomic ?? '') ? BigInt(d.need_atomic!) : null));
  if (needs.some((n) => n === null || n <= 0n)) return 'Every part costs more than this budget allows; try a larger budget.';
  const prices = (needs as bigint[]).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const budget = budgetToHire(prices.reduce((a, b) => a + b, 0n), reserveShare), max = config.maxBudgetAtomic;
  const whom = prices.length === 1 ? 'one' : 'one for each part';
  const hire = budget > max ? `Even the largest budget Rook takes, ${formatUsdc(max)} USDC, is too small to hire ${whom}.` : `A budget of about ${formatUsdc(budget)} USDC would hire ${whom}.`;
  if (prices.length === 1) return `The cheapest agent found for this part asks ${formatUsdc(prices[0])} USDC, more than this budget allows. ${hire}`;
  const [least, most] = [prices[0], prices[prices.length - 1]];
  return `Every part costs more than this budget allows: the cheapest agents found for them ask ${least === most ? formatUsdc(least) : `${formatUsdc(least)} to ${formatUsdc(most)}`} USDC. ${hire}`;
}

/**
 * The least budget that leaves `need` (atomic USDC) to hire with once the planner holds back `reserveShare` of it, rounded
 * up to a cent: the web app's budgetFor (web/src/lib/planner.ts), at any share.
 */
function budgetToHire(need: bigint, reserveShare: number): bigint {
  const keep = 1_000_000n - BigInt(Math.round(reserveShare * 1_000_000)); // money.ts share(), in millionths
  const budget = (need * 1_000_000n + keep - 1n) / keep;
  return ((budget + 9_999n) / 10_000n) * 10_000n;
}

/** Contract caps in plan order (self_do subtasks have none), Rook n -> contract n, and the reserve the contract will compute. */
function expected(t: Task) {
  const hired = t.subtasks.filter((s) => !s.self_do);
  const reserve_bps = Math.round(t.reserve_share * 10_000);
  return {
    reserve_bps, caps: hired.map((s) => s.cap_atomic), nmap: new Map(hired.map((s, i) => [s.n, i + 1])),
    reserve: ((BigInt(t.budget_atomic) * BigInt(reserve_bps)) / 10_000n).toString(),
  };
}

type ChainCfg = { contract_id: string | null; usdc: string | null; owner: string | null; min_budget: bigint; max_open_tasks: number | null };

/**
 * What the funder sends: USDC ft_transfer_call to the contract with the plan's caps in msg. Any account funds its own
 * task; `funder` is the signed-in owner who must send it (null for a CLI task: whoever sends it becomes the funder), or
 * the owner's agent wallet account when it funds the task.
 * `reprint`: the task was approved before, so the funder's transfer may already have been sent and count toward the
 * open-task limit; the instructions must still come back (the web app asks again after a reload).
 */
async function fundingInstructions(t: Task, c: ChainCfg | null, reprint = false, funder = t.owner) {
  const want = expected(t);
  if (!want.caps.length) throw new HttpError(409, 'every subtask is self_do: nothing to fund on chain');
  // The contract refuses a cap of 0 and refunds the transfer. Plans drafted before 0 USDC quotes were dropped can carry
  // one (reloaded from ROOK_DB): refused before the wallet opens.
  if (want.caps.some((c) => BigInt(c) <= 0n)) throw new HttpError(409, 'this plan has a 0 USDC cap; draft the task again');
  if (want.reserve !== t.plan?.budget.reserve_atomic) {
    throw new HttpError(409, `reserve_share ${t.reserve_share} gives ${want.reserve} on chain but ${t.plan?.budget.reserve_atomic} in the plan; use a share with at most 4 decimals`);
  }
  if (c && BigInt(t.budget_atomic) < c.min_budget) {
    throw new HttpError(409, `budget ${formatUsdc(BigInt(t.budget_atomic))} USDC is below the contract's minimum of ${formatUsdc(c.min_budget)} USDC`);
  }
  const cfg = await call(`${config.urls.chainGateway}/config`);
  if (funder && c?.max_open_tasks && !reprint) {
    // The contract refunds a transfer over the limit: say so before the wallet opens.
    const open = await call<{ open: number }>(`${config.urls.chainGateway}/open-tasks?account=${encodeURIComponent(funder)}`).then((r) => r.open, () => 0);
    if (open >= c.max_open_tasks) throw new HttpError(409, `${funder} already has ${open} open tasks on the contract (the limit is ${c.max_open_tasks}); wait for one to close`);
  }
  return {
    network: cfg.network, contract_id: cfg.contract_id, usdc: cfg.usdc, funder: t.owner, contract_owner: cfg.owner ?? null,
    amount_atomic: t.budget_atomic,
    msg: JSON.stringify({ create_task: { reserve_bps: want.reserve_bps, caps: want.caps } }),
  };
}

/**
 * SSE: replay after Last-Event-ID (or ?after=), then stream; end after the terminal task_status event, or in chain
 * mode once the money a killed or failed task held is back (`moving` false). A payment_tx the indexer finds after that
 * is in the snapshot, not the stream.
 */
function events(ctx: Ctx, t: Task, moving: (t: Task) => boolean) {
  const after = Number(ctx.req.headers['last-event-id'] ?? ctx.query.get('after') ?? 0) || 0;
  const res = ctx.res;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  // Sent now, not with the first event: a reconnect with nothing new waited for headers until fetch gave up (5 min, a 503).
  res.flushHeaders();
  const write = (e: RookEvent) => res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e, bigintReplacer)}\n\n`);
  for (const e of t.events) if (e.seq > after) write(e);
  if (isTerminal(t.status) && !moving(t)) { res.end(); return; }
  const fn = (e: RookEvent) => {
    write(e);
    // setStatus emits before it sets t.status, so the terminal event itself is read from the event.
    if ((isTerminal(t.status) || (e.type === 'task_status' && isTerminal(e.data.to))) && !moving(t)) { t.listeners.delete(fn); res.end(); }
  };
  t.listeners.add(fn);
  // A comment line every 25 s keeps a quiet stream open: an agent can work for many minutes with no event, and the web
  // app's proxy (Node fetch, 300 s body timeout) cut the stream at 5 minutes, which the browser saw as a 503.
  const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  res.on('close', () => { clearInterval(beat); t.listeners.delete(fn); });
}
const HEARTBEAT_MS = 25_000;
