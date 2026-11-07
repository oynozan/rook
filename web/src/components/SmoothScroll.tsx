'use client';

import Lenis from 'lenis';
import 'lenis/dist/lenis.css';
import { useEffect, useRef, type RefObject } from 'react';

const LERP = 0.1;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Smooth wheel scrolling for one scroll container. Its first child must hold the content. Off under reduced motion. */
export function useSmoothScroll(wrapper: RefObject<HTMLElement | null>, enabled = true) {
  const lenis = useRef<Lenis | null>(null);
  useEffect(() => {
    const el = wrapper.current;
    const content = el?.firstElementChild;
    if (!enabled || !el || !(content instanceof HTMLElement) || reducedMotion()) return;
    const instance = new Lenis({ wrapper: el, content, lerp: LERP, autoRaf: true });
    lenis.current = instance;
    return () => {
      instance.destroy();
      lenis.current = null;
    };
  }, [wrapper, enabled]);
  return lenis;
}

/** Smooth scrolling for a page that scrolls the window, like the landing page. Renders nothing. */
export function SmoothScroll() {
  useEffect(() => {
    if (reducedMotion()) return;
    const instance = new Lenis({ lerp: LERP, autoRaf: true });
    return () => instance.destroy();
  }, []);
  return null;
}
