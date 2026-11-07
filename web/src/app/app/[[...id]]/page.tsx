import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Rook' };

// /app and /app/{id} share this route so refreshes and links work. The conversation itself lives in the layout, so
// changing between them never remounts it.
export default function Page() {
  return null;
}
