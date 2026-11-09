import { ImageResponse } from 'next/og';
import { MarkImage } from './brand';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

// iOS rounds the corners itself, so this is a full square.
export default function AppleIcon() {
  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0047ab' }}>
      <MarkImage size={112} color="#fff" />
    </div>,
    size,
  );
}
