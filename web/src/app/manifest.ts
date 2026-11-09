import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Rook',
    short_name: 'Rook',
    description: 'Give Rook a task and a budget; it hires agents from the NEAR AI market and returns one result.',
    start_url: '/app',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#0047ab',
    icons: [
      { src: '/icon.svg', type: 'image/svg+xml', sizes: 'any' },
      { src: '/apple-icon', type: 'image/png', sizes: '180x180' },
    ],
  };
}
