// Canned planner output for ROOK_LLM=canned (docs/agentic-system.md 5.2 last paragraph, 5.3, 5.4).
// The labels here are the shared demo contract with the simulator and the evaluator: keep them identical.
import type { AggregateRequest, Criterion } from '../shared/types.ts';
import type { z } from 'zod';
import type { DraftSubtask } from './plan.ts';

const brief = (title: string, body: string) => `${title}\n\n${body}`;

export const CANNED_DRAFT: DraftSubtask[] = [
  {
    title: 'NEAR token holder distribution',
    brief: brief('NEAR token holder distribution',
      'Report the current holder distribution of the NEAR token. Print each figure on its own line as "Label: value" using exactly these labels: '
      + 'Total supply, Circulating supply, Holder count, Top 10 holders share, Top 100 holders share. Give shares as percentages. '
      + 'Add two or three sentences on how concentrated ownership is.'),
    search_terms: ['holder distribution'],
    self_do_ok: false,
    criteria: [
      { id: 'c1', kind: 'contains', description: 'Mentions the top 10 holders', spec: { pattern: 'top 10' } },
      { id: 'c2', kind: 'numeric_match', description: 'Top 10 share is a valid percentage', spec: { label: 'Top 10 holders share', min: 0, max: 100 } },
      { id: 'c3', kind: 'numeric_match', description: 'Holder count is positive', spec: { label: 'Holder count', min: 1 } },
      { id: 'c4', kind: 'numeric_match', description: 'Total supply is positive', spec: { label: 'Total supply', min: 1 } },
    ],
  },
  {
    title: 'NEAR wallet activity',
    brief: brief('NEAR wallet activity',
      'Report recent wallet activity on NEAR. Print each figure on its own line as "Label: value" using exactly these labels: '
      + 'Active wallets (30d), New wallets (30d), Transactions (24h). Then describe the recent trend in a short paragraph.'),
    search_terms: ['wallet activity'],
    self_do_ok: false,
    criteria: [
      { id: 'c1', kind: 'contains', description: 'Mentions active wallets', spec: { pattern: 'active wallets' } },
      { id: 'c2', kind: 'numeric_match', description: 'Active wallet count is positive', spec: { label: 'Active wallets (30d)', min: 1 } },
      { id: 'c3', kind: 'llm_judge', description: 'Describes the trend', spec: { question: 'Does the report describe recent wallet activity trends?' } },
    ],
  },
  {
    title: 'NEAR token contract check',
    brief: brief('NEAR token contract check',
      'Check the NEAR token contract for holder risks. Print each finding on its own line as "Label: value" using exactly these labels: '
      + 'Contract, Contract verified, Owner can mint, Upgradeable, Total supply. Explain any risk in one or two sentences.'),
    search_terms: ['contract check'],
    self_do_ok: false,
    criteria: [
      { id: 'c1', kind: 'contains', description: 'States whether the owner can mint', spec: { pattern: 'owner can mint' } },
      { id: 'c2', kind: 'numeric_match', description: 'Total supply is positive', spec: { label: 'Total supply', min: 1 } },
      { id: 'c3', kind: 'cross_check', description: 'Total supply agrees with the holder report', spec: { label: 'Total supply', other_subtask: 's1', other_label: 'Total supply', tolerance_pct: 1 } },
    ],
  },
  {
    title: 'NEAR token market snapshot',
    brief: brief('NEAR token market snapshot',
      'Give a current market snapshot of the NEAR token. Print each figure on its own line as "Label: value" using exactly these labels: '
      + 'Price (USD), Market cap (USD), Volume 24h (USD).'),
    search_terms: ['market snapshot'],
    self_do_ok: false,
    criteria: [
      { id: 'c1', kind: 'contains', description: 'Mentions market cap', spec: { pattern: 'market cap' } },
      { id: 'c2', kind: 'numeric_match', description: 'Price is non-negative', spec: { label: 'Price (USD)', min: 0 } },
      { id: 'c3', kind: 'numeric_match', description: 'Market cap is non-negative', spec: { label: 'Market cap (USD)', min: 0 } },
    ],
  },
];

/** Fixed self-do text that satisfies plain-text `contains` and every `numeric_match` it can. */
export function cannedSelfDo(brief: string, criteria: Criterion[]): string {
  const lines = [`# ${brief.split('\n')[0].trim()}`, '', '_SIMULATED self-do: written by Rook without a hired agent._', ''];
  for (const c of criteria) {
    if (c.kind === 'contains' && /^[\w\s,.'()%-]+$/.test(c.spec.pattern)) lines.push(`Covers: ${c.spec.pattern}`);
    if (c.kind === 'numeric_match') {
      let v = 1;
      if (c.spec.min !== undefined && v < c.spec.min) v = c.spec.min;
      if (c.spec.max !== undefined && v > c.spec.max) v = c.spec.max;
      lines.push(`${c.spec.label}: ${v}`);
    }
  }
  lines.push('', 'This section was produced without market data and repeats placeholder values only.');
  return lines.join('\n');
}

type AggIn = z.infer<typeof AggregateRequest>;

/** A subtask is merged only when it passed and has text; everything else is a gap. */
export const isMerged = (s: AggIn['subtasks'][number]) => s.status === 'passed' && !!s.deliverable_text;
export const agentOf = (s: AggIn['subtasks'][number]) => s.agent_handle ?? 'rook (self-do)';
const SELF_DO_SOURCE = 'Rook (its own model)';
/** Who wrote a part, in the report's words: the agent's handle, or Rook for its own work ('rook:self-do' is internal). */
export const sourceOf = (s: AggIn['subtasks'][number]) => (!s.agent_handle || s.agent_handle === 'rook:self-do' ? SELF_DO_SOURCE : s.agent_handle);

export function cannedAggregate(req: AggIn): string {
  // In a conversation the latest message can be just a change ("make it shorter"): the first message names the task.
  const out = [`# ${(req.earlier?.[0] ?? req.prompt).split('\n')[0].trim()}`, ''];
  for (const s of req.subtasks.filter(isMerged)) {
    const source = sourceOf(s);
    out.push(`## ${s.title}`, '', `_Source: ${source === SELF_DO_SOURCE ? source : `\`${source}\``}._`, '', s.deliverable_text!.trim(), '');
  }
  const gaps = req.subtasks.filter((s) => !isMerged(s));
  if (gaps.length) out.push('## Gaps', '', ...gaps.map((s) => `- ${s.title}: not delivered`), '');
  return out.join('\n');
}
