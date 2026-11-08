'use client';

import { useEffect, useRef } from 'react';

/**
 * A grid of short strokes, every one turned toward a single point: agents lined up on one task. The point follows a
 * mouse over the hero and otherwise drifts on its own. Strokes near it grow, brighten and turn cobalt.
 * Draws only while on screen; under reduced motion it draws once and stays still.
 */
export function AgentField({ className = '' }: { className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = canvas.current;
    const host = c?.parentElement;
    const ctx = c?.getContext('2d');
    if (!c || !host || !ctx) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let w = 0;
    let h = 0;
    let frame = 0;
    let onScreen = true;
    const pointer = { x: 0, y: 0, on: false };
    const aim = { x: -1, y: -1 };

    const draw = (t: number) => {
      const gap = w < 640 ? 40 : 54;
      const cols = Math.ceil(w / gap);
      const rows = Math.ceil(h / gap);
      // Idle: a slow figure-eight over the right half, clear of the headline.
      const idleX = w * (0.7 + 0.17 * Math.sin(t * 0.00019));
      const idleY = h * (0.42 + 0.24 * Math.sin(t * 0.00031 + 1.2));
      const goalX = pointer.on ? pointer.x : idleX;
      const goalY = pointer.on ? pointer.y : idleY;
      if (aim.x < 0) { aim.x = goalX; aim.y = goalY; }
      aim.x += (goalX - aim.x) * 0.07;
      aim.y += (goalY - aim.y) * 0.07;
      const reach = Math.max(w, h) * 0.6;

      ctx.clearRect(0, 0, w, h);
      ctx.lineCap = 'round';
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const x = (i + 0.5) * (w / cols);
          const y = (j + 0.5) * (h / rows);
          const dx = aim.x - x;
          const dy = aim.y - y;
          const near = Math.max(0, 1 - Math.hypot(dx, dy) / reach) ** 1.6;
          const a = Math.atan2(dy, dx);
          const half = gap * (0.13 + 0.2 * near);
          // cobalt-soft (#7aa2ff) near the aim, white further out
          ctx.strokeStyle = near > 0.55 ? `rgba(122,162,255,${0.35 + 0.65 * near})` : `rgba(255,255,255,${0.1 + 0.55 * near})`;
          ctx.lineWidth = 1 + 1.4 * near;
          ctx.beginPath();
          ctx.moveTo(x - Math.cos(a) * half, y - Math.sin(a) * half);
          ctx.lineTo(x + Math.cos(a) * half, y + Math.sin(a) * half);
          ctx.stroke();
        }
      }
    };

    const loop = (t: number) => {
      draw(t);
      frame = onScreen ? requestAnimationFrame(loop) : 0;
    };

    const resize = () => {
      const r = c.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = r.width;
      h = r.height;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      aim.x = -1;
      if (reduced || !frame) draw(0);
    };

    const sizes = new ResizeObserver(resize);
    sizes.observe(c);
    resize();

    if (reduced) return () => sizes.disconnect();

    const seen = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      if (onScreen && !frame) frame = requestAnimationFrame(loop);
    });
    seen.observe(c);

    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const r = c.getBoundingClientRect();
      pointer.x = e.clientX - r.left;
      pointer.y = e.clientY - r.top;
      pointer.on = true;
    };
    const leave = () => { pointer.on = false; };
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerleave', leave);

    return () => {
      cancelAnimationFrame(frame);
      sizes.disconnect();
      seen.disconnect();
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerleave', leave);
    };
  }, []);

  return <canvas ref={canvas} aria-hidden="true" className={className} />;
}
