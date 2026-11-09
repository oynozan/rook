// Rook CLI against the orchestrator (ORCHESTRATOR_URL). No dependencies; argv parsed by hand.
//   rook plan "<prompt>" --budget <usdc> [--reserve 0.2]
//   rook run "<prompt>" --budget <usdc> [--reserve 0.2] [--yes]
//   rook approve <id> [--yes] | funded <id> <contract_task_id> | status <id> | watch <id> | kill <id> | list
//   rook attack <id> [--send-refused-tx] | mode
// Sends x-rook-token from ROOK_SERVICE_TOKEN when it is set (the orchestrator then requires it).
import { createInterface } from 'node:readline/promises';
import { config } from '../src/shared/config.ts';
import { call, HttpError } from '../src/shared/http.ts';
import { formatUsdc } from '../src/shared/money.ts';

const USAGE = `usage:
  rook plan "<prompt>" --budget <usdc> [--reserve 0.2]
  rook run "<prompt>" --budget <usdc> [--reserve 0.2] [--yes]
  rook approve <task_id> [--yes]
  rook funded <task_id> <contract_task_id> [--owner <account>]   (ROOK_LEDGER=chain, after the funding transfer)
  rook status <task_id>
  rook watch <task_id>
  rook kill <task_id>
  rook attack <task_id> [--send-refused-tx]   (security demo: replays an injected deliverable's demands; every one is refused)
  rook mode
  rook list`;

// ---- output helpers ----
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = sgr('1'), dim = sgr('2'), red = sgr('31'), green = sgr('32'), yellow = sgr('33'), cyan = sgr('36'), alert = sgr('1;41;97');
const usdc = (a: string | number | bigint | null | undefined) => (a === null || a === undefined ? '-' : `${formatUsdc(BigInt(a))} USDC`);
const short = (s: string | null | undefined, n = 10) => (s ? (s.length > n ? s.slice(0, n) + '…' : s) : '-');
const verdict = (v: string | null | undefined) => (v === 'pass' ? green('PASS') : v === 'fail' ? red('FAIL') : dim(String(v ?? '-')));
const time = (ts: string) => dim(new Date(ts).toTimeString().slice(0, 8));

function table(head: string[], rows: string[][]) {
  // eslint-disable-next-line no-control-regex
  const vis = (s: string) => s.replace(/\x1b\[[\d;]*m/g, '').length;
  const w = head.map((h, i) => Math.max(vis(h), ...rows.map((r) => vis(r[i] ?? ''))));
  const line = (r: string[]) => '  ' + r.map((c, i) => c + ' '.repeat(w[i] - vis(c))).join('  ');
  console.log(bold(line(head)));
  for (const r of rows) console.log(line(r));
}

// ---- argv ----
function parse(argv: string[]) {
  const pos: string[] = [], flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-y') flags.yes = true;
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (k === 'yes') flags.yes = true;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const authHeaders = (): Record<string, string> => (process.env.ROOK_SERVICE_TOKEN ? { 'x-rook-token': process.env.ROOK_SERVICE_TOKEN } : {});

/** JSON call to the orchestrator. ponytail: shared/http.ts call() takes no headers, so this repeats it with the token. */
async function api(path: string, body?: unknown, method?: string): Promise<any> {
  const m = method ?? (body === undefined ? 'GET' : 'POST');
  const r = await fetch(config.urls.orchestrator + path, {
    method: m, headers: { ...authHeaders(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data: any;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  if (!r.ok) throw new HttpError(r.status, data?.error ?? `${m} ${path} -> HTTP ${r.status}`, data);
  return data;
}

// ---- plan printing ----
function critLine(c: any) {
  const s = c.spec ?? {};
  const what =
    c.kind === 'contains' ? `/${s.pattern}/i`
    : c.kind === 'numeric_match' ? `"${s.label}" in [${s.min ?? '-inf'}, ${s.max ?? 'inf'}]`
    : c.kind === 'cross_check' ? `"${s.label}" vs ${s.other_subtask} "${s.other_label}" within ${s.tolerance_pct}%`
    : c.kind === 'llm_judge' ? `"${s.question}"`
    : c.kind === 'schema' ? 'JSON schema'
    : JSON.stringify(s);
  return `${c.id.padEnd(3)} ${cyan(c.kind.padEnd(13))} ${what}${c.description ? dim(`  (${c.description})`) : ''}`;
}

function printPlan(task: any) {
  const p = task.plan;
  console.log(`${bold('Task')} ${task.id}  ${dim(task.status)}`);
  console.log(`${bold('Prompt')} ${task.prompt}\n`);
  if (!p) { console.log(red(`No plan: ${task.error ?? 'unknown error'}`)); return; }
  for (const s of p.subtasks) {
    const head = s.self_do ? yellow('self-do by Rook, cost 0') : `cap ${bold(usdc(s.cap_atomic))}  deadline ${s.deadline_s}s`;
    console.log(`${bold(s.id)}  ${bold(s.title)}  ${head}`);
    // The brief's first line is the title (printed above), so show the first line of the request itself.
    const ask = s.brief.split('\n').map((l: string) => l.trim()).filter(Boolean)[1] ?? s.brief.split('\n')[0];
    console.log(`    brief: ${dim(short(ask, 110))}`);
    for (const c of s.criteria) console.log(`    ${critLine(c)}`);
    for (const [i, c] of s.candidates.entries()) {
      const sr = c.success_rate === null || c.success_rate === undefined ? '-' : `${Math.round(c.success_rate)}%`; // market reports 0-100
      console.log(`    ${i === 0 ? 'hire' : '  or'} ${c.handle.padEnd(22)} ${usdc(c.price_atomic).padStart(10)}  sla ${c.sla_seconds}s  success ${sr}  jobs ${c.delivered_jobs}`);
      if (c.rank_reason) console.log(`         ${dim(c.rank_reason)}`); // plans made before ranking by expected cost have none
    }
    console.log();
  }
  if (p.dropped?.length) {
    console.log(bold('Dropped'));
    for (const d of p.dropped) console.log(`  - ${d.title}: ${d.reason}`);
  }
  if (p.notes?.length) {
    console.log(bold('Notes'));
    for (const n of p.notes) console.log(`  - ${n}`);
  }
  const b = p.budget;
  // A total the prompt names ("... for 2 USDC") is planned at instead of --budget.
  console.log(`${bold('Budget')} ${usdc(b.budget_atomic)}${b.from_message ? dim(' (named in the prompt)') : ''} = reserve ${usdc(b.reserve_atomic)} + allocatable ${usdc(b.allocatable_atomic)}; caps allocated ${bold(usdc(b.allocated_atomic))}`);
  const cost = (p.llm_calls ?? []).reduce((x: number, c: any) => x + (c.cost_usd ?? 0), 0);
  console.log(`${bold('LLM')} ${p.llm_calls?.length ?? 0} calls, ${cost.toFixed(4)} USD (planning)`);
  console.log(`${bold('Task id')} ${task.id}`);
  // A plan with every part dropped ends the task: say why (task.error) rather than only the drop list.
  if (task.status === 'failed' && task.error) console.log(red(task.error));
}

// ---- event stream ----
function eventLine(e: any): string | null {
  const d = e.data ?? {};
  const sub = (e.subtask_id ?? 'task').padEnd(4);
  const who = d.agent_handle ? `${d.agent_handle} ` : '';
  let text: string;
  switch (e.type) {
    case 'task_status': text = `${bold('status')} ${d.from ?? '-'} -> ${bold(d.to)}`; break;
    case 'subtask_status': text = `${dim('status')} ${d.from} -> ${d.to}`; break;
    case 'plan': text = `plan: ${d.subtasks?.length ?? 0} subtasks`; break;
    case 'quote': text = `quote ${who}${usdc(d.amount_atomic)}`; break;
    case 'quote_rejected': text = `${yellow('skip')} ${who}${d.reason}`; break;
    case 'hire_sent': text = `${cyan('hire')} ${who}${usdc(d.amount_atomic)} ${dim(`a2a ${short(d.a2a_task_id, 8)}`)}`; break;
    case 'a2a_state': {
      const st = d.state === 'COMPLETED' ? green(d.state) : ['FAILED', 'REJECTED', 'CANCELED', 'TIMEOUT'].includes(d.state) ? yellow(d.state) : d.state;
      text = `${dim('agent')} ${who}${st}`; break;
    }
    case 'evaluation':
      text = `${bold('verdict')} ${who}${verdict(d.verdict)}${d.failed_criteria?.length ? ` failed: ${d.failed_criteria.join(', ')}` : ''} ${dim(`attest ${short(d.attestation_hash, 12)}`)}`;
      break;
    case 'security_alert': text = alert(` SECURITY ALERT `) + ` ${who}${red(short(d.flag, 120))}`; break;
    case 'ledger': {
      const amt = d.amount_atomic !== null && d.amount_atomic !== undefined ? ` ${usdc(d.amount_atomic)}` : '';
      text = `${dim('ledger')} ${d.op}${amt}${d.agent_handle ? ` ${dim(d.agent_handle)}` : ''}`; break;
    }
    case 'receipt': text = `${bold('receipt')} ${who}${usdc(d.amount_atomic)} ${verdict(d.verdict)} ${dim(d.id)}`; break;
    case 'final': text = `${green('final report ready')}; spent ${usdc(d.spent_atomic)}, refunded ${usdc(d.refunded_atomic)}`; break;
    case 'error': text = red(`error: ${d.message}`); break;
    default: text = `${e.type} ${JSON.stringify(d)}`;
  }
  return `${time(e.ts)} ${sub} ${text}`;
}

const TERMINAL = ['closed', 'cancelled', 'killed', 'failed'];

/** Stream SSE events as one-liners until the task is terminal; reconnects with Last-Event-ID. */
async function watch(id: string, skipPlan = false) {
  let last = 0;
  for (let attempt = 0; ; attempt++) {
    let ended = false;
    try {
      const r = await fetch(`${config.urls.orchestrator}/tasks/${id}/events`, { headers: { ...authHeaders(), ...(last ? { 'last-event-id': String(last) } : {}) } });
      if (!r.ok) throw new Error(`events: HTTP ${r.status} ${await r.text()}`);
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (!data) continue;
          const e = JSON.parse(data);
          last = Math.max(last, e.seq);
          if (skipPlan && e.type === 'plan') continue;
          const line = eventLine(e);
          if (line) console.log(line);
          if (e.type === 'task_status' && TERMINAL.includes(e.data.to)) ended = true;
        }
      }
    } catch (err: any) {
      if (attempt >= 5) throw err;
      console.error(dim(`event stream dropped (${err?.message ?? err}); reconnecting`));
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    if (ended) return;
    const snap = await api(`/tasks/${id}`);
    if (TERMINAL.includes(snap.task.status)) return;
  }
}

// ---- summary ----
function printSummary(snap: any) {
  const t = snap.task;
  console.log(`\n${bold('Task')} ${t.id}  ${t.status === 'closed' ? green(t.status) : yellow(t.status)}${t.error ? red(`  ${t.error}`) : ''}`);

  if (snap.subtasks?.length) {
    console.log(bold('\nSubtasks'));
    table(['id', 'title', 'status', 'agent', 'tried', 're-hires'], snap.subtasks.map((s: any) => [
      s.id, short(s.title, 34), s.final_outcome === 'passed' ? green(s.status) : s.final_outcome === 'abandoned' ? red(s.status) : s.status,
      s.accepted?.agent_handle ?? '-', s.hires.map((h: any) => `${h.agent_handle}:${h.state}`).join(' ') || '-', String(s.rehire_count),
    ]));
  }

  if (snap.final_result) {
    console.log(bold('\n==== Final report ====\n'));
    console.log(snap.final_result.final_markdown.trim());
    console.log(bold('\n======================'));
    if (snap.final_result.attribution?.length) console.log(`Attribution: ${snap.final_result.attribution.map((a: any) => `${a.subtask_id} <- ${a.agent_handle}`).join(', ')}`);
    if (snap.final_result.abandoned?.length) console.log(yellow(`Abandoned: ${snap.final_result.abandoned.join(', ')}`));
  }

  if (snap.receipts?.length) {
    console.log(bold('\nReceipts'));
    table(['receipt', 'subtask', 'agent', 'amount', 'verdict', 'attestation', 'payment hash'], snap.receipts.map((r: any) => [
      r.id, r.subtask_id, r.agent_handle, usdc(r.amount_atomic), verdict(r.verdict), short(r.attestation_hash, 12), short(r.payment_hash, 12),
    ]));
    const sum = snap.receipts.reduce((x: bigint, r: any) => x + BigInt(r.amount_atomic), 0n);
    console.log(`  sum of receipts ${usdc(sum)}`);
  } else console.log(dim('\nNo receipts.'));

  const l = snap.ledger;
  if (l) {
    console.log(bold('\nLedger'));
    console.log(`  budget ${usdc(l.budget_atomic)}  spent ${bold(usdc(l.spent_atomic))}  reserve used ${usdc(l.reserve_used_atomic)} of ${usdc(l.reserve_atomic)}  refunded to ${l.funder} ${usdc(l.refunded_atomic)}`);
    const open = BigInt(l.unallocated_atomic) + BigInt(l.reserve_remaining_atomic) + l.subtasks.reduce((x: bigint, s: any) => x + BigInt(s.balance_atomic), 0n);
    // A stopped or closing task's unwind keeps returning it until the books close (docs/agentic-system.md 8.7).
    if (open > 0n) console.log(`  still locked ${usdc(open)}${TERMINAL.includes(t.status) || t.status === 'closing' ? '  (Rook is still returning it to the funder)' : ''}`);
    console.log(`  invariant ${l.invariant_holds ? green('holds') : red('BROKEN')}${l.killed ? red('  killed') : ''}`);
  }
  const c = snap.llm_cost;
  if (c) console.log(`${bold('\nLLM cost')} ${c.total_usd.toFixed(4)} USD over ${c.calls} calls${c.unverified_signatures ? dim(` (${c.unverified_signatures} without a verified signature)`) : ''}`);
}

// ---- commands ----
async function confirm(q: string) {
  if (!process.stdin.isTTY) {
    console.log(`${q} no TTY: pass --yes to approve non-interactively`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q);
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

async function create(pos: string[], flags: Record<string, string | true>) {
  const prompt = pos[0];
  if (!prompt || typeof flags.budget !== 'string') throw new Error(USAGE);
  const body: any = { prompt, budget_usdc: flags.budget };
  if (typeof flags.reserve === 'string') body.reserve_share = Number(flags.reserve);
  printMode(await api('/mode'));
  console.log(dim(`planning against ${config.urls.orchestrator} ...`));
  const task = await api('/tasks', body);
  printPlan(task);
  if (task.status !== 'planned') { process.exitCode = 1; return null; }
  return task;
}

function printMode(m: any) {
  if (!m.simulated) console.log(`${alert(' LIVE ')} real agents paid in USDC on NEAR ${m.network}, contract ${m.contract_id}`);
  // The chain ledger moves money even when the market or the LLM is simulated.
  else if (m.ledger === 'chain') console.log(yellow(`TEST RUN on NEAR ${m.network}: funding moves ${m.network === 'mainnet' ? 'real USDC' : 'testnet tokens'}, contract ${m.contract_id} (market ${m.market}, llm ${m.llm})`));
  else console.log(yellow(`SIMULATION, no real money moves (market ${m.market}, ledger ${m.ledger}, llm ${m.llm})`));
}

/** NEAR AI spend of the simulator's agents (process total), or null when no simulator answers. */
const simLlmUsd = () => fetch(`${config.urls.simulator}/llm-cost`, { signal: AbortSignal.timeout(2000) })
  .then((r) => (r.ok ? r.json() : null)).then((j: any) => (typeof j?.spent_usd === 'number' ? j.spent_usd as number : null), () => null);

async function approveAndWatch(id: string, yes: boolean) {
  if (!yes && !(await confirm('\nApprove? [y/N] '))) { console.log(`Not approved. Later: rook approve ${id}`); return; }
  const simBefore = await simLlmUsd();
  const approved = await api(`/tasks/${id}/approve`, {});
  if (approved.funding) { printFunding(id, approved.funding); return; }
  await runAndReport(id, simBefore);
}

/** ROOK_LEDGER=chain: Rook never moves the budget itself; the human's own transfer creates the task with the caps. */
function printFunding(id: string, f: any) {
  console.log(`\n${bold('Fund this task on chain')} (${f.network}): send ${bold(usdc(f.amount_atomic))} to ${f.contract_id} with the approved caps.`);
  console.log(`  token ${f.usdc}, msg ${f.msg}`);
  console.log(`  from ${f.funder ?? 'your own NEAR account'}: the sender becomes the task's funder, can stop and close it, and gets every refund`);
  const args = JSON.stringify({ receiver_id: f.contract_id, amount: f.amount_atomic, msg: f.msg });
  console.log(`\n  near contract call-function as-transaction ${f.usdc} ft_transfer_call json-args '${args}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${f.funder ?? '<your-account>'} network-config ${f.network} sign-with-keychain send\n`);
  console.log(`Read the contract task id from the task_created event in that transaction's logs, then: ${bold(`rook funded ${id} <contract_task_id>`)}`);
}

async function runAndReport(id: string, simBefore: number | null) {
  console.log();
  await watch(id, true);
  const snap = await api(`/tasks/${id}`);
  printSummary(snap);
  // Simulated agents bill the same NEARAI_API_KEY from the simulator process; their cost is not in the task snapshot.
  // ponytail: a delta of the simulator's process total, so a parallel run on the same simulator is counted here too.
  const simAfter = await simLlmUsd();
  if (simBefore !== null && simAfter !== null && snap.llm_cost) {
    const sim = simAfter - simBefore;
    console.log(`  simulated agents ${sim.toFixed(4)} USD; run total ${bold((snap.llm_cost.total_usd + sim).toFixed(4))} USD of NEAR AI credit`);
  }
}

// ---- attack (security demo, docs/x402-payments-plan.md step 5) ----
type Outcome = { id: string; demand: string; call: string; outcome: 'refused' | 'NOT REFUSED' | 'not sent' | 'error'; reason: string };

function printOutcomes(list: Outcome[]) {
  for (const a of list) {
    const tag = a.outcome === 'refused' ? green('REFUSED') : a.outcome === 'NOT REFUSED' ? alert(' NOT REFUSED ') : yellow(a.outcome);
    console.log(`   (${a.id}) ${a.demand}\n       ${dim(a.call)}\n       ${tag} ${a.reason}`);
  }
  return list.every((a) => a.outcome !== 'NOT REFUSED');
}

async function attack(id: string, flags: Record<string, string | true>) {
  const mode = await api('/mode');
  const r = await api(`/tasks/${id}/attack`, {});
  console.log(`${bold('rook attack')} ${r.task_id} (${r.status}), ledger ${mode.ledger}${mode.simulated ? dim(', simulation') : ''}\n`);
  const inj = r.injected;
  if (inj) {
    console.log(`${bold('1. The injected deliverable')} from ${inj.agent_handle} (${inj.subtask_id})`);
    // Flags read `<what>: '<quoted text>'`; the scanner quotes overlapping text, so show each kind once and the longest quote.
    const quote = inj.flags.map((f: string) => f.slice(f.indexOf(':') + 1).trim()).sort((x: string, y: string) => y.length - x.length)[0];
    console.log(`   ${alert(' SECURITY ALERT ')} ${inj.flags.map((f: string) => f.split(':')[0]).join(', ')}`);
    console.log(`   ${red(short(quote, 220))}`);
    console.log(`   evaluator verdict ${verdict(inj.verdict)}${inj.failed_criteria.length ? `, failed: ${inj.failed_criteria.join(', ')}` : ''} ${dim(`evaluation hash ${short(inj.attestation_hash, 16)}`)}`);
    console.log(dim('   Agent text is data: the orchestrator never acts on it, so Rook itself never tries what it asks.'));
  } else {
    console.log(dim("1. No injected deliverable in this task's events (the simulator's sim-wallets-express writes one); replaying the demo's demands anyway."));
  }
  console.log(`\n${bold("2. Rook's ledger")} ${dim("(the run's ledger code, on a sandbox copy of this task's books; the task is not touched)")}`);
  let ok = printOutcomes(r.attempts.map((a: any) => ({ ...a, outcome: a.refused ? 'refused' : 'NOT REFUSED' })));
  console.log(dim(`   sandbox spent ${usdc(r.sandbox.spent_atomic)}: only ${r.target.agent_handle}'s own payment; invariant ${r.sandbox.invariant_holds ? 'holds' : 'BROKEN'}`));
  if (mode.ledger === 'chain') ok = (await attackChain(id, r, flags)) && ok;
  else console.log(dim('\n3. Signer and budget contract: not running (ROOK_LEDGER=sim). With ROOK_LEDGER=chain, rook attack sends these demands to them too.'));
  if (ok) console.log(green('\nNothing was paid: every attempt was refused or not sent.'));
  else { console.log(alert(' AN ATTEMPT WAS NOT REFUSED ')); process.exitCode = 1; }
}

/** ROOK_LEDGER=chain: the same demands to the real signer and contract, each sent only where a refusal is certain. */
async function attackChain(id: string, r: any, flags: Record<string, string | true>) {
  console.log(`\n${bold('3. Signer and budget contract')} ${dim('(the real services; nothing is sent where it could be accepted)')}`);
  const snap = await api(`/tasks/${id}`);
  const cid = snap.ledger?.contract_task_id, account = snap.ledger?.accounts?.[r.target.n];
  // A finished task only: a /sign holds the subtask's signing slot, so it must never race a live hire.
  if (!TERMINAL.includes(snap.task.status)) { console.log(yellow(`   not sent: the task is ${snap.task.status}; attack it once it is closed, failed or killed`)); return true; }
  if (!cid || !account) { console.log(yellow('   not sent: this task was never funded on chain')); return true; }
  const gw = config.urls.chainGateway;
  const [{ task: ct, subtasks }, cfg] = await Promise.all([call(`${gw}/task/${cid}`), call(`${gw}/config`)]);
  const cs = subtasks.find((s: any) => s.account_id === account);
  if (!cs) { console.log(yellow(`   not sent: ${account} is not a subtask account of contract task ${cid}`)); return true; }
  const killed = ct.killed || cfg.killed, out: Outcome[] = [];
  const row = r.target.row, where = `${r.target.subtask_id} = contract ${cid}/${cs.n}, ${account}`;

  const sign = async (id: string, demand: string, x: any, skip: string | null) => {
    const o: Outcome = { id, demand, call: `signer /sign ${where}: ${usdc(x.amount)} to ${x.payTo}`, outcome: 'not sent', reason: skip ?? '' };
    out.push(o);
    if (skip) return;
    try {
      await call(`${config.urls.signer}/sign`, { task_id: cid, n: cs.n, account_id: account, row: x });
      Object.assign(o, { outcome: 'NOT REFUSED', reason: 'the signer signed it; the header was discarded here, never sent' });
      await call(`${config.urls.signer}/expire`, { task_id: cid, n: cs.n, terminal_unpaid: true }).catch(() => {});
    } catch (e: any) {
      Object.assign(o, e instanceof HttpError && e.status === 409 ? { outcome: 'refused', reason: e.message } : { outcome: 'error', reason: e?.message ?? String(e) });
    }
  };
  await sign('a', `pay ${r.target.agent_handle} again, the same ${usdc(row.amount)}`, row,
    killed || cs.status !== 'Funded' ? null : `subtask ${cs.n} is still Funded and the task is not killed on chain, so a replay could be a valid payment; kill the task first`);
  await sign('b', `send ${usdc(row.amount)} to evil-collector.near`, { ...row, payTo: 'evil-collector.near' }, null);
  // More than the sub-account can ever hold: its cap plus the task's whole reserve.
  const over = (BigInt(r.target.cap_atomic) + BigInt(r.target.reserve_atomic) + 1n).toString();
  await sign('c', `pay ${usdc(over)}, above the cap plus the whole reserve`, { ...row, amount: over }, null);

  const d: Outcome = { id: 'd', demand: `fund ${r.target.subtask_id} again after the kill`, call: `chain-gateway /top-up: top_up(${cid}, ${cs.n}, 0.000001 USDC) from the orchestrator key`, outcome: 'not sent', reason: '' };
  out.push(d);
  if (!killed) {
    d.reason = `the contract task is not killed on chain; the owner sends kill_task first: near contract call-function as-transaction ${cfg.contract_id} kill_task json-args '{"task_id":"${cid}"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as ${cfg.owner} network-config ${cfg.network} sign-with-keychain send`;
  } else if (flags['send-refused-tx'] !== true) {
    d.reason = 'a real transaction the contract must refuse (gas only, under 0.005 NEAR, no USDC); pass --send-refused-tx to send it';
  } else {
    try {
      await call(`${gw}/top-up`, { task_id: cid, n: cs.n, amount_atomic: '1' });
      Object.assign(d, { outcome: 'NOT REFUSED', reason: 'top_up succeeded on a killed task' });
    } catch (e: any) {
      const tx = e?.body?.details;
      Object.assign(d, tx?.tx_hash ? { outcome: 'refused', reason: `${e.message} (tx ${tx.tx_hash} ${tx.explorer_url ?? ''})` } : { outcome: 'error', reason: e?.message ?? String(e) });
    }
  }
  return printOutcomes(out);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parse(rest);
  const id = pos[0];
  const needId = () => { if (!id) throw new Error(USAGE); return id; };
  switch (cmd) {
    case 'plan': await create(pos, flags); break;
    case 'run': {
      const task = await create(pos, flags);
      if (task) await approveAndWatch(task.id, flags.yes === true);
      break;
    }
    case 'approve': {
      const snap = await api(`/tasks/${needId()}`);
      if (flags.yes !== true) printPlan({ ...snap.task, plan: snap.plan });
      await approveAndWatch(id, flags.yes === true);
      break;
    }
    case 'funded': {
      if (!pos[1]) throw new Error(USAGE);
      const simBefore = await simLlmUsd();
      const t = await api(`/tasks/${needId()}/funded`, { contract_task_id: pos[1], ...(typeof flags.owner === 'string' ? { owner: flags.owner } : {}) });
      console.log(`task ${t.id} funded by contract task ${t.contract_task_id}; running`);
      await runAndReport(id, simBefore);
      break;
    }
    case 'status': printSummary(await api(`/tasks/${needId()}`)); break;
    case 'watch': await watch(needId()); printSummary(await api(`/tasks/${id}`)); break;
    case 'kill': {
      const t = await api(`/tasks/${needId()}/kill`, {});
      console.log(`task ${t.id} ${red(t.status)}`);
      if (t.human_action) console.log(yellow(t.human_action));
      break;
    }
    case 'attack': await attack(needId(), flags); break;
    case 'mode': { const m = await api('/mode'); printMode(m); console.log(JSON.stringify(m, null, 2)); break; }
    case 'list': {
      const { tasks } = await api('/tasks');
      // Deleted by its owner in the web app, or sent again in its place: still listed here, marked.
      const note = (t: any) => (t.deleted_at ? dim(' deleted') : '') + (t.superseded_by ? dim(` sent again as ${t.superseded_by}`) : '');
      if (!tasks.length) console.log('no tasks');
      else table(['id', 'status', 'created', 'prompt'], tasks.map((t: any) => [t.id, t.status + note(t), t.created_at.slice(0, 19).replace('T', ' '), short(t.prompt, 60)]));
      break;
    }
    default:
      console.log(USAGE);
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 2;
  }
}

main().catch((e: any) => {
  const refused = e?.cause?.code === 'ECONNREFUSED' || /fetch failed/.test(e?.message ?? '');
  const msg = refused ? `cannot reach the orchestrator at ${config.urls.orchestrator}; is \`pnpm dev\` running?`
    : e?.status === 401 ? 'the orchestrator requires its service token: set ROOK_SERVICE_TOKEN in this shell to the value the services run with'
    : e?.message ?? String(e);
  console.error(red(msg));
  process.exitCode = 1;
});
