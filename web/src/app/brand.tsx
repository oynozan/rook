// Shared pieces for the generated images (social card, Apple touch icon). JSX for next/og: inline styles only.

/** The rook mark: three crown blocks over a solid base, as in the navbar. `size` is its width in px. */
export function MarkImage({ size, color }: { size: number; color: string }) {
  const u = size / 100;
  const block = (x: number, y: number, w: number, h: number) => (
    <div style={{ position: 'absolute', left: x * u, top: y * u, width: w * u, height: h * u, background: color }} />
  );
  return (
    <div style={{ position: 'relative', width: size, height: size, display: 'flex' }}>
      {block(10, 10, 20, 28)}
      {block(40, 10, 20, 28)}
      {block(70, 10, 20, 28)}
      {block(10, 44, 80, 46)}
    </div>
  );
}

/** Host Grotesk for the images, or null offline (next/og then falls back to its own font). */
export async function hostGrotesk(weight: 400 | 500): Promise<ArrayBuffer | null> {
  try {
    const css = await (await fetch(`https://fonts.googleapis.com/css2?family=Host+Grotesk:wght@${weight}`, { headers: { 'user-agent': 'curl' } })).text();
    const url = css.match(/src: url\((.+?)\) format\('(?:truetype|opentype)'\)/)?.[1];
    return url ? await (await fetch(url)).arrayBuffer() : null;
  } catch {
    return null;
  }
}
