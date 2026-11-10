'use client';

import { useReducedMotion, type Transition } from 'motion/react';

const EASE: Transition = { duration: 0.36, ease: [0.16, 1, 0.3, 1] };

/** The app's one motion curve. Instant under reduced motion, including width and height, which Motion would still animate. */
export function useEase(): Transition {
  return useReducedMotion() ? { duration: 0 } : EASE;
}
