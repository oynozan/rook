const REPO = 'https://github.com/oynozan/rook';

const LINKS = [
  { label: 'Product', href: `${REPO}/blob/main/docs/product.md` },
  { label: 'Docs', href: `${REPO}/tree/main/docs` },
];

const GROUP_GAP = 'gap-[clamp(1.5rem,3.5vw,2.75rem)]';

/** The rook mark: three crown blocks (agents) above one solid base (coordination and budget rules). */
export function Mark() {
  return (
    <svg className="size-7 shrink-0" viewBox="0 0 100 100" fill="currentColor" aria-hidden="true">
      <rect x="10" y="10" width="20" height="28" />
      <rect x="40" y="10" width="20" height="28" />
      <rect x="70" y="10" width="20" height="28" />
      <rect x="10" y="44" width="80" height="46" />
    </svg>
  );
}

export function Navbar() {
  return (
    <header className="flex items-center justify-between gap-4 px-[clamp(1.25rem,6vw,6rem)] py-4 md:py-5">
      <div className={`flex items-center ${GROUP_GAP}`}>
        <a href="/" className="inline-flex items-center gap-2 py-1 text-2xl font-medium tracking-[-0.015em] md:text-[1.625rem]">
          <Mark />
          rook
        </a>
        <nav aria-label="Main" className={`hidden md:flex ${GROUP_GAP}`}>
          {LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              className="bg-[linear-gradient(currentColor_0_0)] bg-size-[0%_1.5px] bg-bottom-left bg-no-repeat py-1 text-xl font-medium transition-[background-size] duration-250 hover:bg-size-[100%_1.5px] focus-visible:bg-size-[100%_1.5px] motion-reduce:transition-none"
            >
              {l.label}
            </a>
          ))}
        </nav>
      </div>
      <a
        href={REPO}
        className="group inline-flex min-h-13 items-center gap-2.5 rounded-full bg-accent px-5 text-[1.0625rem] font-medium whitespace-nowrap text-on-accent transition-colors duration-200 hover:bg-accent-hover focus-visible:bg-accent-hover active:translate-y-px motion-reduce:transition-none md:min-h-14 md:px-6.5 md:text-lg"
      >
        Read the code
        <svg
          className="size-5 shrink-0 transition-transform duration-250 group-hover:translate-x-0.75 group-focus-visible:translate-x-0.75 motion-reduce:translate-x-0! motion-reduce:transition-none"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          aria-hidden="true"
        >
          <path d="M2 8h11M9 3.5 13.5 8 9 12.5" />
        </svg>
      </a>
    </header>
  );
}
