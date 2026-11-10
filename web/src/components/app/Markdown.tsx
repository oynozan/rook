// A report's Markdown as the page shows it (report.ts markdownBlocks): headings, lists, quotes, rules, tables and fenced
// code, with file markers in plain words. Report text comes from agents, so nothing here is ever markup: every block is
// plain React text, and a link shows the site it leads to.
import { Fragment, type ReactNode } from 'react';
import { inlineParts, markdownBlocks, type Inline } from '@/lib/report';

const LINK = 'underline decoration-ink/30 underline-offset-2 hover:decoration-ink';

/** The host a link leads to, shown beside its words unless they already say it. */
const hostOf = (href: string) => { try { return new URL(href).host.replace(/^www\./, ''); } catch { return ''; } };

export function InlineText({ text }: { text: string }): ReactNode {
  return inlineParts(text).map((p: Inline, i) => {
    if (p.kind === 'code') return <code key={i} className="font-mono text-[0.9em]">{p.text}</code>;
    if (p.kind === 'strong') return <strong key={i} className="font-medium">{p.text}</strong>;
    if (p.kind === 'em') return <em key={i}>{p.text}</em>;
    if (p.kind === 'link') {
      const host = hostOf(p.href);
      return (
        <Fragment key={i}>
          <a href={p.href} target="_blank" rel="noopener noreferrer nofollow" className={LINK}>{p.text}</a>
          {host && !p.text.toLowerCase().includes(host.toLowerCase()) && <span className="text-ink/55"> ({host})</span>}
        </Fragment>
      );
    }
    return <Fragment key={i}>{p.text}</Fragment>;
  });
}

/** Fenced code scrolls sideways, and so does a wide table, never the page. */
export function Markdown({ markdown, className = 'mt-3' }: { markdown: string; className?: string }) {
  const delay = (i: number) => ({ animationDelay: `${Math.min(i * 25, 900)}ms` });
  return (
    <div className={`${className} space-y-2 leading-relaxed`}>
      {markdownBlocks(markdown).map((b, i) => {
        switch (b.kind) {
          case 'code':
            return (
              // Focusable, so a keyboard can scroll it.
              <pre key={i} style={delay(i)} tabIndex={0} aria-label={b.lang ? `${b.lang} code` : 'Code'}
                className="rook-in max-h-120 overflow-auto rounded-xl bg-ink/5 p-3 text-sm leading-snug outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
                <code className="font-mono">{b.text}</code>
              </pre>
            );
          case 'heading':
            return <h3 key={i} style={delay(i)} className={`rook-in font-medium tracking-[-0.01em] ${b.level <= 1 ? 'mt-4 text-2xl' : 'mt-4 text-xl'}`}><InlineText text={b.text} /></h3>;
          case 'bullet':
            return <p key={i} style={{ ...delay(i), marginLeft: `${b.depth * 1.25}rem` }} className="rook-in pl-4 -indent-3">• <InlineText text={b.text} /></p>;
          case 'number':
            return <p key={i} style={delay(i)} className="rook-in pl-6 -indent-5"><span className="tabular-nums text-ink/65">{b.n}.</span> <InlineText text={b.text} /></p>;
          case 'quote':
            return <blockquote key={i} style={delay(i)} className="rook-in border-l-2 border-ink/15 pl-3 text-ink/75"><InlineText text={b.text} /></blockquote>;
          case 'rule':
            return <hr key={i} className="my-4 border-ink/10" />;
          case 'note':
            return <p key={i} style={delay(i)} className="rook-in text-ink/65">{b.text}</p>;
          case 'table':
            return (
              <div key={i} style={delay(i)} tabIndex={0} role="region" aria-label="Table"
                className="rook-in max-w-full overflow-x-auto rounded-xl border border-ink/15 outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
                <table className="w-full border-collapse text-left text-sm">
                  <thead className="bg-ink/5">
                    <tr>{b.head.map((h, j) => <th key={j} scope="col" className="px-3 py-2 font-medium whitespace-nowrap"><InlineText text={h} /></th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j} className="border-t border-ink/10">{r.map((c, k) => <td key={k} className="px-3 py-2 align-top"><InlineText text={c} /></td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return <p key={i} style={delay(i)} className="rook-in"><InlineText text={b.text} /></p>;
        }
      })}
    </div>
  );
}
