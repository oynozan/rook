"use client";

// Adapted from Rare UI's Web Search (https://rareui.com), copyright (c) 2026 Swami Malode. Licence: ./RARE-UI-LICENSE.
// Changed for Rook: colours use the app's theme tokens, fonts and labels fit the app, and unused parts are removed.

import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  type AnimationPlaybackControls,
  type Transition,
  type Variants,
} from "motion/react";
import { cn } from "@/lib/utils";

export type WebSearchStatus = "searching" | "done";

export type WebSource = {
  id: string;
  title: string;
  url: string;
  snippet?: string;
  favicon?: string;
};

const COLUMNS = 4;
// each result closes this share of the gap left, so the ring fills fast early and never hits the end on its own
const STEP = 0.3;
const START = 0.08;
const CREEP = 0.25;
const CREEP_SECONDS = 4;
const RING_HOLD = 0.45;
const STACK = 4;
// hover waits a beat before acting, so a pointer just passing through never triggers it
const SPREAD_DELAY = 150;
const PREVIEW_DELAY = 300;
const LEAVE_DELAY = 150;

// springs overshoot, which would take blur below zero, so blur eases on its own
const BLUR: Transition = { duration: 0.25, ease: "easeOut" };
const SWAP: Transition = { type: "spring", duration: 0.55, bounce: 0.1, filter: BLUR };
const POP: Transition = { type: "spring", duration: 0.5, bounce: 0.4 };
const SPREAD: Transition = { type: "spring", duration: 0.35, bounce: 0 };
const OPEN: Transition = { type: "spring", duration: 0.5, bounce: 0.08 };
const CARD: Transition = { type: "spring", duration: 0.5, bounce: 0.1, filter: BLUR };
const STAGGER = 0.045;
const RING: Transition = { type: "spring", duration: 0.6, bounce: 0 };
const INSTANT: Transition = { duration: 0 };

const swapVariants: Variants = {
  enter: { y: 6, opacity: 0, filter: "blur(3px)" },
  center: { y: 0, opacity: 1, filter: "blur(0px)" },
  exit: { y: -6, opacity: 0, filter: "blur(3px)" },
};

const cardVariants: Variants = {
  enter: { opacity: 0, y: 8, scale: 0.97, filter: "blur(6px)" },
  center: { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" },
  exit: { opacity: 0, scale: 0.97, filter: "blur(4px)" },
};

// the highlight sits mid gradient and the size leaves room either side, so each sweep starts off screen
const SHIMMER =
  "linear-gradient(90deg, var(--web-search-ink) 40%, var(--web-search-shine) 50%, var(--web-search-ink) 60%)";

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const RING_CIRCLE = { ...STROKE, cx: 14, cy: 14, r: 13, strokeWidth: 1.5 };

const hash = (text: string) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  }
  return h >>> 0;
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

// without an href an anchor keeps its look but goes nowhere, for previews that shouldn't send visitors away
const linkTo = (url: string, linked: boolean) =>
  linked ? { href: url, target: "_blank", rel: "noreferrer" } : {};

// developer.mozilla.org reads as "mozilla", the way people say it
const siteName = (url: string) => {
  const parts = hostOf(url).split(".");
  return parts.length > 1 ? parts[parts.length - 2] : parts[0];
};

export type WebSearchProps = Omit<ComponentProps<"div">, "children"> & {
  sources: WebSource[];
  status?: WebSearchStatus;
  query?: string;
  label?: string;
  progress?: number;
  linked?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

function WebSearch({
  sources,
  status = "done",
  query,
  label,
  progress,
  linked = true,
  open,
  defaultOpen = true,
  onOpenChange,
  className,
  ...props
}: WebSearchProps) {
  const reduced = !!useReducedMotion();
  const [openState, setOpenState] = useState(defaultOpen);
  const [expanded, setExpanded] = useState(false);
  const [measureRef, labelWidth] = useSize<HTMLSpanElement>("width");

  const searching = status === "searching";
  const isOpen = open ?? openState;
  const count = sources.length;
  const ring = Math.min(
    1,
    Math.max(0, progress ?? (count === 0 ? START : 1 - (1 - STEP) ** count)),
  );
  const text =
    label ??
    (searching
      ? query
        ? `Searching “${query}”`
        : "Searching the web"
      : `Searched ${count} ${count === 1 ? "site" : "sites"}`);

  // the last slot belongs to the more card from the fourth result on, so no card ever has to turn into it
  const overflow = !expanded && count >= COLUMNS;
  const shown = overflow ? sources.slice(0, COLUMNS - 1) : sources;
  const hidden = overflow ? sources.slice(COLUMNS - 1) : [];
  // empty slots keep the first row full while results are still landing
  const skeletons = searching && !overflow ? Math.max(0, COLUMNS - count) : 0;

  const toggle = () => {
    const next = !isOpen;
    if (open === undefined) setOpenState(next);
    onOpenChange?.(next);
  };

  const swap = reduced ? INSTANT : SWAP;
  // after expanding, the stagger starts at the first card that was hidden
  const stagger = (i: number): Transition =>
    reduced
      ? INSTANT
      : {
          ...CARD,
          delay: Math.max(0, i - (expanded ? COLUMNS - 1 : 0)) * STAGGER,
        };

  const cell = (key: string, i: number, child: ReactNode) => (
    <motion.li
      key={key}
      className="group/card"
      layout={!reduced}
      variants={cardVariants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={stagger(i)}
    >
      {child}
    </motion.li>
  );

  return (
    <div
      data-slot="web-search"
      data-status={status}
      data-open={isOpen || undefined}
      className={cn(
        "flex w-full flex-col text-ink",
        className,
      )}
      {...props}
    >
      <button
        type="button"
        data-slot="web-search-trigger"
        onClick={toggle}
        aria-expanded={isOpen}
        className="group flex h-10 w-fit max-w-full cursor-pointer items-center gap-2.5 rounded-full bg-panel pl-1.5 pr-3.5 text-left outline-none transition-[background-color,box-shadow] hover:bg-surface hover:shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_1px_1px_rgba(0,0,0,0.04),0_2px_4px_-1px_rgba(0,0,0,0.08)] dark:hover:shadow-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent dark:hover:bg-[#232427]"
      >
        <GlobeTile searching={searching} progress={ring} reduced={reduced} />

        {/* the label springs between widths, so the icons beside it glide instead of jumping */}
        <motion.span
          aria-live="polite"
          className="relative grid min-w-0 overflow-x-clip"
          initial={false}
          animate={{ width: labelWidth ?? "auto" }}
          transition={swap}
        >
          <span
            ref={measureRef}
            aria-hidden
            className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap text-[14px] font-medium"
          >
            {text}
          </span>
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={text}
              variants={swapVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={swap}
              className="truncate whitespace-nowrap text-[14px] font-medium"
            >
              {searching ? <Shimmer reduced={reduced}>{text}</Shimmer> : text}
            </motion.span>
          </AnimatePresence>
        </motion.span>

        <FaviconStack sources={sources} reduced={reduced} />

        <motion.span
          className="-ml-0.5 shrink-0 text-ink/65 transition-colors group-hover:text-ink"
          initial={false}
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={reduced ? INSTANT : OPEN}
        >
          <Chevron />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {isOpen && (count > 0 || searching) && (
          <Collapse key="sources" reduced={reduced}>
            <ol
              data-slot="web-search-sources"
              className="relative grid grid-cols-2 gap-2 pt-2.5 sm:grid-cols-4"
            >
              <AnimatePresence mode="popLayout">
                {shown.map((source, i) =>
                  cell(
                    source.id,
                    i,
                    <SourceCard
                      source={source}
                      index={i + 1}
                      linked={linked}
                    />,
                  ),
                )}
                {Array.from({ length: skeletons }, (_, i) => (
                  <motion.li
                    key={`skeleton-${count + i}`}
                    aria-hidden
                    layout={!reduced}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, transition: { duration: 0.15 } }}
                    transition={stagger(count + i)}
                  >
                    <SkeletonCard reduced={reduced} delay={i * 0.12} />
                  </motion.li>
                ))}
                {hidden.length > 0 &&
                  cell(
                    "more",
                    COLUMNS - 1,
                    <MoreCard
                      sources={hidden}
                      onClick={() => setExpanded(true)}
                      reduced={reduced}
                    />,
                  )}
                {expanded &&
                  count >= COLUMNS &&
                  cell(
                    "less",
                    count,
                    <button
                      type="button"
                      onClick={() => setExpanded(false)}
                      className={cn(
                        CARD_SHELL,
                        "group flex-row items-center justify-center gap-1.5 bg-transparent text-[12.5px] font-medium text-ink/65 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.07)] group-hover/card:translate-y-0 hover:bg-panel hover:text-ink hover:shadow-none dark:bg-transparent dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] dark:hover:bg-[#1C1C1C]",
                      )}
                    >
                      <Chevron className="-ml-0.5 rotate-180 transition-transform duration-200 group-hover:-translate-y-px" />
                      Show less
                    </button>,
                  )}
              </AnimatePresence>
            </ol>
          </Collapse>
        )}
      </AnimatePresence>
    </div>
  );
}

function Chevron({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width={14}
      height={14}
      {...STROKE}
      strokeWidth={2.6}
      className={cn("block", className)}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function Collapse({
  reduced,
  children,
}: {
  reduced: boolean;
  children: ReactNode;
}) {
  const [ref, height] = useSize<HTMLDivElement>("height");

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      // height auto only animates on mount, so the measured height carries every later change
      animate={{ height: height ?? "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={
        reduced ? INSTANT : { height: OPEN, opacity: { duration: 0.25 } }
      }
      className="-mx-1 overflow-hidden"
    >
      {/* the inset gives the hover lift and focus rings room before the clip */}
      <div ref={ref} className="px-1 pb-1">
        {children}
      </div>
    </motion.div>
  );
}

// the li takes the hover and the card inside lifts, so the lift can't slide the card out from under the pointer
// the hover shadow stays inside the 4px the collapse leaves around the cards, or its clip shows as a hard edge
const CARD_SHELL =
  "flex h-[84px] w-full cursor-pointer flex-col rounded-[14px] bg-panel p-2.5 text-left outline-none transition-[background-color,box-shadow,translate] duration-200 group-hover/card:-translate-y-0.5 hover:bg-surface hover:shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_1px_1px_rgba(0,0,0,0.04),0_2px_4px_-1px_rgba(0,0,0,0.08)] dark:hover:shadow-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent dark:hover:bg-[#232427]";

function SourceCard({
  source,
  index,
  linked,
}: {
  source: WebSource;
  index: number;
  linked: boolean;
}) {
  return (
    <a
      data-slot="web-search-source"
      {...linkTo(source.url, linked)}
      title={source.title}
      className={cn(
        CARD_SHELL,
        "group justify-between",
        !linked && "cursor-default",
      )}
    >
      <span className="line-clamp-2 text-[12.5px] font-medium leading-[17px] text-ink/85 transition-colors group-hover:text-ink/85">
        {source.title}
      </span>
      <span className="flex items-center gap-1.5">
        <Favicon source={source} size={16} />
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-ink/65">
          {siteName(source.url)}
        </span>
        <span className="text-[11px] font-medium tabular-nums text-ink/55">
          {index}
        </span>
      </span>
    </a>
  );
}

function MoreCard({
  sources,
  onClick,
  reduced,
}: {
  sources: WebSource[];
  onClick: () => void;
  reduced: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Show ${sources.length} more agents`}
      className={cn(CARD_SHELL, "group justify-between")}
    >
      <FaviconStack sources={sources} reduced={reduced} />
      <span className="flex items-center gap-1 whitespace-nowrap text-[12.5px] font-medium leading-[17px] text-ink/85 transition-colors group-hover:text-ink/85">
        <span className="relative inline-grid overflow-hidden tabular-nums">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={sources.length}
              initial={{ y: "100%", opacity: 0, filter: "blur(2px)" }}
              animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
              exit={{ y: "-100%", opacity: 0, filter: "blur(2px)" }}
              transition={reduced ? INSTANT : SWAP}
            >
              {sources.length}
            </motion.span>
          </AnimatePresence>
        </span>
        more {sources.length === 1 ? "agent" : "agents"}
      </span>
    </button>
  );
}

function SkeletonCard({ reduced, delay }: { reduced: boolean; delay: number }) {
  const bar = "rounded-full bg-black/[0.06] dark:bg-white/[0.07]";
  return (
    <div className="relative flex h-[84px] flex-col justify-between overflow-hidden rounded-[14px] bg-panel p-2.5">
      <span className="flex flex-col gap-1.5 pt-0.5">
        <span className={cn(bar, "h-2.5 w-[88%]")} />
        <span className={cn(bar, "h-2.5 w-[60%]")} />
      </span>
      <span className="flex items-center gap-1.5">
        <span className={cn(bar, "size-3.5")} />
        <span className={cn(bar, "h-2 w-12")} />
      </span>
      {!reduced && (
        <motion.span
          className="absolute inset-0 bg-linear-to-r from-transparent via-white/60 to-transparent dark:via-white/[0.06]"
          initial={{ x: "-100%" }}
          animate={{ x: "100%" }}
          transition={{
            duration: 1.3,
            ease: "easeInOut",
            repeat: Infinity,
            delay,
          }}
        />
      )}
    </div>
  );
}

function useSize<T extends HTMLElement>(side: "width" | "height") {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<number | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // offsetWidth rounds down, which is enough to tip the label into an ellipsis
    const observer = new ResizeObserver(() =>
      setSize(Math.ceil(node.getBoundingClientRect()[side])),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [side]);

  return [ref, size] as const;
}

function useHoverIntent(enterDelay: number) {
  const [active, setActive] = useState(false);
  const timer = useRef(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const set = (next: boolean, delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setActive(next), delay);
  };

  // touch has no hover, so a tap never leaves anything stuck open
  const hover = {
    onPointerEnter: (event: ReactPointerEvent) =>
      event.pointerType === "mouse" && set(true, enterDelay),
    onPointerLeave: () => set(false, LEAVE_DELAY),
  };

  return { active, set, hover };
}

function FaviconStack({
  sources,
  reduced,
  size = 20,
}: {
  sources: WebSource[];
  reduced: boolean;
  size?: number;
}) {
  // only the icons themselves spread on hover, not the pill or card around them
  const { active: spread, hover } = useHoverIntent(SPREAD_DELAY);
  const shown = sources.slice(0, STACK);
  // the 2px plate around each icon counts in the layout, so the overlap makes room for it
  const overlap = Math.round(size * 0.3) + 4;
  // icons slide on transforms, which move in subpixels, and one padding change makes room for them
  const shift = spread ? overlap - 2 : 0;

  return (
    <motion.span
      data-slot="web-search-stack"
      {...hover}
      className="flex w-fit shrink-0 items-center"
      initial={false}
      animate={{ paddingRight: shift * Math.max(0, shown.length - 1) }}
      transition={reduced ? INSTANT : SPREAD}
    >
      <AnimatePresence initial={false}>
        {shown.map((source, i) => (
          <motion.span
            key={source.id}
            // the separator is a plate in the surface color, so the icon's soft edge blends into it instead of leaving a seam
            className="relative rounded-full bg-panel p-[2px] transition-colors group-hover:bg-surface dark:group-hover:bg-[#232427]"
            style={{ zIndex: STACK - i, marginLeft: i === 0 ? 0 : -overlap }}
            initial={{ scale: 0, opacity: 0, x: shift * i }}
            animate={{ scale: 1, opacity: 1, x: shift * i }}
            exit={{ scale: 0, opacity: 0 }}
            transition={reduced ? INSTANT : { default: POP, x: SPREAD }}
          >
            <Favicon source={source} size={size} />
          </motion.span>
        ))}
      </AnimatePresence>
    </motion.span>
  );
}

function Favicon({ source, size }: { source: WebSource; size: number }) {
  const [broken, setBroken] = useState(false);
  const name = siteName(source.url);
  const hue = hash(name) % 360;
  const image = source.favicon && !broken;

  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold uppercase leading-none text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.5,
        background: image
          ? undefined
          : `linear-gradient(135deg, oklch(0.72 0.15 ${hue}), oklch(0.58 0.17 ${(hue + 30) % 360}))`,
      }}
    >
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={source.favicon}
          alt=""
          draggable={false}
          onError={() => setBroken(true)}
          className="size-full object-cover"
        />
      ) : (
        name.charAt(0)
      )}
    </span>
  );
}

function GlobeTile({
  searching,
  progress,
  reduced,
}: {
  searching: boolean;
  progress: number;
  reduced: boolean;
}) {
  const fill = useMotionValue(searching ? 0 : 1);

  useEffect(() => {
    const target = searching ? progress : 1;
    if (reduced) {
      fill.jump(target);
      return;
    }
    let creep: AnimationPlaybackControls | undefined;
    const settle = animate(fill, target, RING);
    // between results the ring keeps edging toward the next step, so it never looks stuck
    if (searching) {
      settle.then(() => {
        creep = animate(fill, target + (1 - target) * CREEP, {
          duration: CREEP_SECONDS,
          ease: "easeOut",
        });
      });
    }
    return () => {
      settle.stop();
      creep?.stop();
    };
  }, [searching, progress, reduced, fill]);

  return (
    <span className="relative flex size-7 shrink-0 items-center justify-center rounded-full bg-surface text-ink/65 shadow-[0_1px_2px_rgba(0,0,0,0.06)] transition-colors group-hover:text-ink dark:bg-[#2A2B2F]">
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        width={15}
        height={15}
        {...STROKE}
        strokeWidth={2}
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
      </svg>
      <motion.svg
        aria-hidden
        viewBox="0 0 28 28"
        className="absolute inset-0 size-full -rotate-90 text-accent-ink"
        initial={false}
        animate={{ opacity: searching ? 1 : 0 }}
        // a finished search holds the full ring for a beat before it fades
        transition={
          reduced
            ? INSTANT
            : { duration: 0.3, delay: searching ? 0 : RING_HOLD }
        }
      >
        <circle {...RING_CIRCLE} className="opacity-[0.12]" />
        <motion.circle {...RING_CIRCLE} style={{ pathLength: fill }} />
      </motion.svg>
    </span>
  );
}

function Shimmer({
  reduced,
  children,
}: {
  reduced: boolean;
  children: ReactNode;
}) {
  if (reduced) return <span className="text-ink/65">{children}</span>;
  return (
    <motion.span
      className="bg-clip-text text-transparent [--web-search-ink:color-mix(in_oklab,var(--ink)_65%,transparent)] [--web-search-shine:var(--ink)]"
      style={{ backgroundImage: SHIMMER, backgroundSize: "250% 100%" }}
      initial={{ backgroundPosition: "100% 0" }}
      animate={{ backgroundPosition: "0% 0" }}
      transition={{ duration: 1.6, ease: "linear", repeat: Infinity }}
    >
      {children}
    </motion.span>
  );
}

export { WebSearch };
