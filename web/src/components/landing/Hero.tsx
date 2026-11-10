import { AgentField } from '@/components/landing/AgentField';
import { INSET } from '@/components/layout';
import { HowItWorks } from '@/components/landing/HowItWorks';
import { Manifesto } from '@/components/landing/Manifesto';
import Link from 'next/link';

export function Hero() {
  return (
    <>
      {/* Full screen, ink, with the field behind. The navbar sits on top of this section. */}
      {/* One corner-radius taller than the screen, so the rounded corners sit just below the fold instead of on it. */}
      <section className="relative isolate flex flex-col justify-end md:min-h-[calc(100svh+clamp(1.5rem,3vw,3rem))] overflow-hidden rounded-b-[clamp(1.5rem,3vw,3rem)] bg-ink text-white [&_:focus-visible]:outline-white">
        <AgentField className="absolute inset-0 -z-20 size-full" />
        {/* Keeps the copy readable where strokes pass behind it. */}
        <div
          className="absolute inset-0 -z-10 bg-[linear-gradient(to_top,#0a0a0a_30%,rgb(10_10_10/0.5)_65%,transparent)] md:bg-[linear-gradient(to_right,#0a0a0a_15%,rgb(10_10_10/0.55)_55%,transparent_85%)]"
          aria-hidden="true"
        />

        <div className={`${INSET} pt-30 pb-14 md:pt-32 md:pb-[calc(clamp(3rem,9vh,7rem)+clamp(1.5rem,3vw,3rem))]`}>
          <h1 className="text-[clamp(3rem,6.9vw,8.5rem)] leading-[0.95] font-normal tracking-[-0.045em]">
            Coordinate AI agents <br className="max-md:hidden" />
            within a budget you approve
          </h1>
          <p className="mt-7 max-w-[40ch] text-[clamp(1.125rem,1.6vw,1.375rem)] leading-normal text-white/75 md:mt-9">
            Give Rook a task and a budget. It splits the work, hires priced agents from the NEAR AI market, and keeps the total cost under your budget.
          </p>

          <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-4 md:mt-12">
            <Link
              href="/app"
              className="group inline-flex min-h-15 items-center gap-5 rounded-full bg-cobalt py-2 pr-2 pl-7 text-lg font-medium text-white transition-colors duration-200 hover:bg-cobalt-hover active:translate-y-px motion-reduce:transition-none"
            >
              Open the app
              <span className="grid size-11 place-items-center overflow-hidden rounded-full bg-white text-ink" aria-hidden="true">
                {/* The arrow leaves through the corner and a new one arrives behind it. */}
                <span className="relative size-4.5 overflow-hidden">
                  {[0, 1].map((n) => (
                    <svg
                      key={n}
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      className={`absolute inset-0 size-4.5 transition-transform duration-350 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${
                        n === 0
                          ? 'group-hover:translate-x-5 group-hover:-translate-y-5 group-focus-visible:translate-x-5 group-focus-visible:-translate-y-5'
                          : '-translate-x-5 translate-y-5 group-hover:translate-x-0 group-hover:translate-y-0 group-focus-visible:translate-x-0 group-focus-visible:translate-y-0'
                      }`}
                    >
                      <path d="M4 12 12 4M5.5 4H12v6.5" />
                    </svg>
                  ))}
                </span>
              </span>
            </Link>
          </div>
        </div>
      </section>

      {/* The middle, on the page itself. overflow-clip (not hidden) keeps the pinned parts working. */}
      <div className="overflow-clip">
        <Manifesto />
        <HowItWorks />
      </div>
    </>
  );
}
