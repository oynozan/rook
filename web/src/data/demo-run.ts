// Recorded from a real run on 2026-11-07, sim market + canned LLM:
//   ROOK_LLM=canned pnpm dev
//   ROOK_LLM=canned pnpm rook run "Due diligence on the NEAR token" --budget 3 --yes
// Times, agents, amounts and details come from that task's event log and snapshot. Only the wording of `note` is
// written for this page. Re-record when the simulator's agents or prices change.

export type RowState = 'funded' | 'working' | 'failed' | 'unpaid' | 'passed';
export type Row = { agent: string | null; state: RowState; detail: string };
export type Frame = {
  t: number; // seconds since the run started
  note: string;
  alert?: boolean;
  spent: string;
  reserve: string;
  closed?: boolean;
  rows: Partial<Record<SubtaskId, Row>>; // only the rows this step changes
};

export const SUBTASKS = [
  { id: 's1', title: 'Holder distribution' },
  { id: 's2', title: 'Wallet activity' },
  { id: 's3', title: 'Contract check' },
  { id: 's4', title: 'Market snapshot' },
] as const;
export type SubtaskId = (typeof SUBTASKS)[number]['id'];

export const RUN = { prompt: 'Due diligence on the NEAR token', budget: '3.00', reserve: '0.60', refunded: '1.80' };

export const FRAMES: Frame[] = [
  {
    t: 0, note: 'Plan approved. Four caps funded, 0.60 held in reserve.', spent: '0.00', reserve: '0.00',
    rows: {
      s1: { agent: null, state: 'funded', detail: 'Cap 0.30' },
      s2: { agent: null, state: 'funded', detail: 'Cap 0.20' },
      s3: { agent: null, state: 'funded', detail: 'Cap 0.24' },
      s4: { agent: null, state: 'funded', detail: 'Cap 0.16' },
    },
  },
  {
    t: 2.1, note: 'Cheapest candidate hired for each subtask.', spent: '0.00', reserve: '0.00',
    rows: {
      s1: { agent: 'sim-holders-lite', state: 'working', detail: 'Quoted 0.15' },
      s2: { agent: 'sim-wallets-express', state: 'working', detail: 'Quoted 0.10' },
      s3: { agent: 'sim-tokencheck-fast', state: 'working', detail: 'Quoted 0.12' },
      s4: { agent: 'sim-price-slow', state: 'working', detail: 'Quoted 0.08' },
    },
  },
  {
    t: 3.1, note: 'A top-10 share of 291.2 is outside [0, 100]. Check failed.', alert: true, spent: '0.15', reserve: '0.00',
    rows: { s1: { agent: 'sim-holders-lite', state: 'failed', detail: 'Paid 0.15' } },
  },
  {
    t: 3.1, note: 'Deliverable tried to instruct the orchestrator. Security alert.', alert: true, spent: '0.25', reserve: '0.00',
    rows: { s2: { agent: 'sim-wallets-express', state: 'failed', detail: 'Paid 0.10' } },
  },
  {
    t: 4.1, note: 'Agent reported FAILED. Authorization released, nothing charged.', spent: '0.25', reserve: '0.26',
    rows: { s3: { agent: 'sim-tokencheck-fast', state: 'unpaid', detail: 'No charge' } },
  },
  {
    t: 6.2, note: 'Next candidates hired, with top-ups of 0.26 from the reserve.', spent: '0.25', reserve: '0.26',
    rows: {
      s1: { agent: 'sim-holders', state: 'working', detail: 'Quoted 0.30' },
      s2: { agent: 'sim-wallets', state: 'working', detail: 'Quoted 0.20' },
      s3: { agent: 'sim-tokencheck', state: 'working', detail: 'Quoted 0.25' },
    },
  },
  {
    t: 6.2, note: 'Passed every criterion. Accepted for the report.', spent: '0.45', reserve: '0.26',
    rows: { s2: { agent: 'sim-wallets', state: 'passed', detail: 'Paid 0.20' } },
  },
  {
    t: 7.2, note: 'Two more deliverables pass.', spent: '1.00', reserve: '0.26',
    rows: {
      s1: { agent: 'sim-holders', state: 'passed', detail: 'Paid 0.30' },
      s3: { agent: 'sim-tokencheck', state: 'passed', detail: 'Paid 0.25' },
    },
  },
  {
    t: 27.1, note: 'Past the deadline after 25 s. Authorization released, nothing charged.', spent: '1.00', reserve: '0.30',
    rows: { s4: { agent: 'sim-price-slow', state: 'unpaid', detail: 'No charge' } },
  },
  {
    t: 29.2, note: 'Next candidate hired, with a 0.04 top-up.', spent: '1.00', reserve: '0.30',
    rows: { s4: { agent: 'sim-price', state: 'working', detail: 'Quoted 0.20' } },
  },
  {
    t: 30.2, note: 'All four passed. Task closed, 1.80 refunded to the funder.', spent: '1.20', reserve: '0.30', closed: true,
    rows: { s4: { agent: 'sim-price', state: 'passed', detail: 'Paid 0.20' } },
  },
];

export type Hire = { agent: string; end: Exclude<RowState, 'funded' | 'working'>; label: string; detail: string; receipt?: number };

/** One line of cards per subtask: its cap and the two hires it took. Receipt numbers follow the order they were written. */
export const FILES: { id: SubtaskId; cap: string; first: Hire; second: Hire }[] = [
  {
    id: 's1', cap: '0.30',
    first: { agent: 'sim-holders-lite', end: 'failed', label: 'Failed check', detail: 'Paid 0.15', receipt: 1 },
    second: { agent: 'sim-holders', end: 'passed', label: 'Passed', detail: 'Paid 0.30', receipt: 4 },
  },
  {
    id: 's2', cap: '0.20',
    first: { agent: 'sim-wallets-express', end: 'failed', label: 'Injection', detail: 'Paid 0.10', receipt: 2 },
    second: { agent: 'sim-wallets', end: 'passed', label: 'Passed', detail: 'Paid 0.20', receipt: 3 },
  },
  {
    id: 's3', cap: '0.24',
    first: { agent: 'sim-tokencheck-fast', end: 'unpaid', label: 'Agent failed', detail: 'No charge' },
    second: { agent: 'sim-tokencheck', end: 'passed', label: 'Passed', detail: 'Paid 0.25', receipt: 5 },
  },
  {
    id: 's4', cap: '0.16',
    first: { agent: 'sim-price-slow', end: 'unpaid', label: 'Timed out', detail: 'No charge' },
    second: { agent: 'sim-price', end: 'passed', label: 'Passed', detail: 'Paid 0.20', receipt: 6 },
  },
];

/** Rows as they stand after frame `i`. */
export function rowsAt(i: number): Record<SubtaskId, Row> {
  return Object.assign({}, ...FRAMES.slice(0, i + 1).map((f) => f.rows));
}
