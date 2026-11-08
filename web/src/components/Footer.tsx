import Link from 'next/link';
import { INSET } from './layout';

const REPO = 'https://github.com/oynozan/rook';

const GROUPS = [
  {
    label: 'Use',
    links: [
      { label: 'Open the app', href: '/app' },
      { label: 'How it works', href: `${REPO}/blob/main/docs/agentic-system.md` },
    ],
  },
  {
    label: 'Read',
    links: [
      { label: 'Product', href: `${REPO}/blob/main/docs/product.md` },
      { label: 'Docs', href: `${REPO}/tree/main/docs` },
      { label: 'Source code', href: REPO },
    ],
  },
];

const DRAW =
  'bg-[linear-gradient(currentColor_0_0)] bg-size-[0%_1.5px] bg-bottom-left bg-no-repeat transition-[background-size,color] duration-300 hover:bg-size-[100%_1.5px] hover:text-white focus-visible:bg-size-[100%_1.5px] motion-reduce:transition-none';

/** One dark slab: the way in, the links, and the wordmark cropped by the slab's bottom edge. */
export function Footer() {
  return (
    <footer className="mt-4">
      {/* Full width like the hero, which it mirrors: the hero rounds its bottom corners, the footer its top ones. */}
      <div className="@container overflow-hidden rounded-t-[clamp(1.5rem,3vw,3rem)] bg-ink text-white [&_:focus-visible]:outline-white">
        <div className={`relative z-10 pt-14 md:pt-20 ${INSET}`}>
          <div className="flex flex-col gap-8 md:flex-row md:items-end md:justify-between">
            <p className="max-w-[16ch] text-[clamp(2rem,4.2vw,3.75rem)] leading-[1.05] tracking-[-0.03em]">
              Hand Rook a task and a budget.
            </p>
            <Link
              href="/app"
              className="group inline-flex min-h-14 shrink-0 items-center justify-center gap-2.5 self-start rounded-full bg-cobalt px-8 text-lg font-medium text-white transition-colors duration-200 hover:bg-white hover:text-ink focus-visible:bg-white focus-visible:text-ink active:translate-y-px motion-reduce:transition-none max-md:w-full md:self-auto"
            >
              Open the app
              <svg className="size-5 shrink-0 transition-transform duration-250 group-hover:translate-x-1 group-focus-visible:translate-x-1 motion-reduce:translate-x-0! motion-reduce:transition-none" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
                <path d="M2 8h11M9 3.5 13.5 8 9 12.5" />
              </svg>
            </Link>
          </div>

          <nav aria-label="Footer" className="mt-10 grid grid-cols-2 gap-x-6 gap-y-8 border-t border-white/12 pt-8 sm:grid-cols-3 md:mt-14 md:grid-cols-[repeat(3,minmax(0,16rem))] md:pt-10">
            {GROUPS.map((group) => (
              <div key={group.label}>
                <h2 className="text-sm text-white/55">{group.label}</h2>
                <ul className="mt-3 space-y-2">
                  {group.links.map((l) => {
                    const cls = `py-0.5 text-white/85 ${DRAW}`;
                    return (
                      <li key={l.label}>
                        {l.href.startsWith('http') ? (
                          <a href={l.href} target="_blank" rel="noopener noreferrer" className={cls}>{l.label}</a>
                        ) : (
                          <Link href={l.href} className={cls}>{l.label}</Link>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>

          <div className="mt-12 flex flex-col gap-2 text-sm text-white/55 sm:flex-row sm:items-center sm:justify-between md:mt-16">
            <p>© 2026 Rook. The demo above is recorded on a simulated market; no real money moved.</p>
            <a href="#top" className="-my-2 self-start py-2 underline underline-offset-4 hover:text-white sm:self-auto">Back to top</a>
          </div>
        </div>

        {/* The wordmark as the slab's foot, ink touching both sides and cropped by the bottom edge. Measured in Host Grotesk:
            "rook" inks across 1.744em starting 0.050em in, so 100cqw / 1.744 fills the width and -0.050em cancels the left bearing. */}
        <p aria-hidden="true" className="pointer-events-none mt-6 -mb-[0.22em] md:mt-8 ml-[-0.05em] text-[57.35cqw] leading-[0.8] font-medium tracking-[-0.06em] whitespace-nowrap text-white select-none">
          rook
        </p>
      </div>
    </footer>
  );
}
