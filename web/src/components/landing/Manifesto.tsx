'use client';

import { motion, useMotionValue, useReducedMotion, useScroll, useTransform, type MotionValue } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { MARKET } from '@/data/market';
import { AgentChip } from '@/components/landing/AgentChip';

const LINE =
  'Rook splits your task into subtasks, finds an agent for each on the NEAR AI market, keeps the total cost of every hire under your budget, and hands back one result.';
const WORDS = LINE.split(' ');

// One clock for the whole scene: scroll progress through the section, 0 to 1.
const ENTER = 0.18; // the ring gathers
const READ_FROM = 0.16; // words light up between here...
const READ_TO = 0.68; // ...and here
const LEAVE = 0.72; // the ring flies out past the camera
const STILL = 0.715; // reduced motion: the last word fully lit, the ring not yet leaving

// Below RING_FROM the agents sit in a grid instead of a ring: two rows of two above the sentence and two below.
// Positions are shares of the screen (x of width, y of height) from the centre; rows sit 12% of the height apart.
const RING_FROM = 1100;
const GRID_SLOTS: [number, number][] = [
  [-0.22, -0.41], [0.22, -0.41], [-0.22, -0.29], [0.22, -0.29],
  [-0.22, 0.29], [0.22, 0.29], [-0.22, 0.41], [0.22, 0.41],
];
// Half a full card at its largest (depth 1.1), plus a little air, for keeping the ring off the sentence.
const CARD_HALF = { w: 135, h: 42 };

type Box = { w: number; h: number; tw: number; th: number };

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const ease = (v: number) => 1 - (1 - v) ** 3;

function Orbiter({ i, n, p, size }: { i: number; n: number; p: MotionValue<number>; size: Box }) {
  const agent = MARKET[i];
  const phone = size.w < 640;
  const ring = size.w >= RING_FROM;
  const depth = ring ? 0.9 + ((i * 37) % 9) / 40 : 1; // 0.9 to 1.1 per agent in the ring; the grid keeps one size
  const a0 = (i / n) * Math.PI * 2 - Math.PI / 2;
  const slot = GRID_SLOTS[i % GRID_SLOTS.length];
  // An ellipse through the corners of the sentence's box, grown by half a card, never reaches into that box at any
  // angle. sqrt(2) is what takes an ellipse from touching the box's sides to passing outside its corners.
  const rx = Math.min((size.tw / 2 + CARD_HALF.w) * Math.SQRT2, size.w / 2 - CARD_HALF.w - 16);
  const ry = Math.min((size.th / 2 + CARD_HALF.h) * Math.SQRT2, size.h / 2 - CARD_HALF.h - 16);
  const shape = (v: number) => {
    const enter = ease(clamp(v / ENTER));
    const leave = clamp((v - LEAVE) / (1 - LEAVE)) ** 1.6;
    const angle = a0 + v * 0.55;
    const reach = (0.55 + 0.45 * enter) * (1 + 1.5 * leave * depth);
    return { enter, leave, angle, reach };
  };
  const x = useTransform(p, (v) => { const s = shape(v); return ring ? Math.cos(s.angle) * rx * s.reach : slot[0] * size.w * s.reach; });
  const y = useTransform(p, (v) => { const s = shape(v); return ring ? Math.sin(s.angle) * ry * s.reach : slot[1] * size.h * s.reach; });
  const scale = useTransform(p, (v) => { const s = shape(v); return (0.7 + 0.3 * s.enter) * depth * (1 + (ring ? 1.6 : 0.6) * s.leave); });
  const opacity = useTransform(p, (v) => { const s = shape(v); return s.enter * (1 - s.leave); });

  return (
    <motion.div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 will-change-transform" style={{ x, y, scale, opacity }}>
      <AgentChip handle={agent.handle} price={agent.price} size={phone ? 'face' : 'md'} />
    </motion.div>
  );
}

function Word({ word, i, p }: { word: string; i: number; p: MotionValue<number> }) {
  const start = READ_FROM + (i / WORDS.length) * (READ_TO - READ_FROM);
  const opacity = useTransform(p, (v) => 0.22 + 0.78 * clamp((v - start) / 0.05));
  return <motion.span style={{ opacity }}>{word} </motion.span>;
}

/**
 * The agents of the recorded run, with faces and prices, gather around one sentence while it lights up word by word,
 * then fly out past the camera. Pinned for the length of the section.
 */
export function Manifesto() {
  const section = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: section, offset: ['start start', 'end end'] });
  const reduced = useReducedMotion();
  const p = useMotionValue(0); // both server and client start at 0, so hydration matches
  const text = useRef<HTMLParagraphElement>(null);
  const [size, setSize] = useState<Box>({ w: 1440, h: 900, tw: 620, th: 300 }); // same on server and client

  useEffect(() => {
    if (reduced) { p.set(STILL); return; }
    p.set(scrollYProgress.get());
    return scrollYProgress.on('change', (v) => p.set(v));
  }, [reduced, scrollYProgress, p]);

  useEffect(() => {
    const read = () => {
      const t = text.current?.getBoundingClientRect();
      setSize({ w: window.innerWidth, h: window.innerHeight, tw: t?.width ?? 620, th: t?.height ?? 300 });
    };
    read();
    const sizes = new ResizeObserver(read);
    if (text.current) sizes.observe(text.current);
    window.addEventListener('resize', read);
    return () => { sizes.disconnect(); window.removeEventListener('resize', read); };
  }, []);

  return (
    <section ref={section} aria-label="What Rook does" className="relative h-[260svh] motion-reduce:h-[100svh]">
      <div className="sticky top-0 flex h-[100svh] items-center justify-center overflow-hidden">
        <div aria-hidden="true">
          {MARKET.map((a, i) => <Orbiter key={a.handle} i={i} n={MARKET.length} p={p} size={size} />)}
        </div>
        <p ref={text} className="relative z-10 max-w-[22ch] px-6 text-center text-[clamp(1.75rem,2.6vw,2.75rem)] leading-[1.15] tracking-[-0.025em]">
          {WORDS.map((w, i) => <Word key={i} word={w} i={i} p={p} />)}
        </p>
      </div>
    </section>
  );
}
