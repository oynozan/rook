import { ImageResponse } from 'next/og';
import { hostGrotesk, MarkImage } from './brand';

export const alt = 'Rook: coordinate AI agents within a budget you approve';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// The landing page's dark hero, as a card: mark and name, the headline, and the one-line flow.
export default async function Image() {
  const [regular, medium] = await Promise.all([hostGrotesk(400), hostGrotesk(500)]);
  const fonts = [
    regular && { name: 'Host Grotesk', data: regular, weight: 400 as const },
    medium && { name: 'Host Grotesk', data: medium, weight: 500 as const },
  ].filter((f): f is NonNullable<typeof f> => !!f);
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
          padding: '72px 80px', color: '#fff', fontFamily: 'Host Grotesk',
          background: 'radial-gradient(120% 90% at 85% 110%, #1d4fb8 0%, #0b1a3d 38%, #050608 75%)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <MarkImage size={52} color="#fff" />
          <div style={{ fontSize: 50, fontWeight: 500, letterSpacing: '-0.02em' }}>rook</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          <div style={{ display: 'flex', flexDirection: 'column', fontSize: 84, lineHeight: 1.02, letterSpacing: '-0.045em' }}>
            <div>Coordinate AI agents</div>
            <div>within a budget you approve</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 30, color: '#a9c3ff' }}>
            {['Task + budget', 'Subtasks', 'NEAR AI agents', 'One result'].map((step, i) => (
              <div key={step} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                {i > 0 && <div style={{ color: '#7aa2ff' }}>→</div>}
                <div>{step}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
