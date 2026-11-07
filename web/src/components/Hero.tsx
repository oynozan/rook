import { RunPanel } from '@/components/RunPanel';

const REPO = 'https://github.com/oynozan/rook';
const INSET = 'px-[clamp(1.25rem,6vw,6rem)]';

// Faint dot columns behind the copy, positioned by share of the section. Decorative only.
const DOT_COLUMNS = [
  { left: '74%', top: '19rem', height: '10rem' },
  { left: '82%', top: '18rem', height: '11rem' },
  { left: '90%', top: '0', height: '13rem' },
  { left: '95%', top: '14rem', height: '14rem' },
  { left: '78%', bottom: '2rem', height: '18rem' },
  { left: '88%', bottom: '2rem', height: '16rem' },
];

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      {DOT_COLUMNS.map((c) => (
        <div key={`${c.left}${c.height}`} className="dots absolute -z-10 hidden w-16 text-accent/25 lg:block" style={c} aria-hidden="true" />
      ))}

      <div className={`${INSET} pt-16 pb-14 md:pt-28 md:pb-20`}>
        <h1 className="text-[clamp(2.75rem,6vw,6rem)] leading-[1.05] font-normal tracking-[-0.035em]">
          Coordinate AI agents <br className="hidden md:block" />
          within a budget you approve
        </h1>
        <div className="mt-10 flex flex-wrap gap-4">
          <a
            href={`${REPO}#quick-start-no-keys-no-network`}
            className="inline-flex min-h-14 items-center rounded-full bg-accent px-8 text-lg font-medium text-on-accent transition-colors duration-200 hover:bg-accent-hover focus-visible:bg-accent-hover active:translate-y-px motion-reduce:transition-none"
          >
            Run the demo
          </a>
          <a
            href={`${REPO}/blob/main/docs/agentic-system.md`}
            className="inline-flex min-h-14 items-center rounded-full border border-ink/25 px-8 text-lg font-medium transition-colors duration-200 hover:border-ink hover:bg-ink/5 focus-visible:border-ink active:translate-y-px motion-reduce:transition-none"
          >
            See how it works
          </a>
        </div>
      </div>

      <div className="px-[clamp(0.75rem,2vw,2rem)]">
        <RunPanel />
      </div>

      <p className={`${INSET} max-w-[34ch] box-content py-20 text-[clamp(2rem,4vw,3.5rem)] leading-[1.15] font-normal tracking-tight md:py-32`}>
        Agent teams. Enforced budgets. Verifiable work.{' '}
        <span className="text-ink/65">
          Rook proposes the plan, hires the agents, checks each delivery against criteria written in advance, and re-hires from a limited reserve.
        </span>
      </p>
    </section>
  );
}
