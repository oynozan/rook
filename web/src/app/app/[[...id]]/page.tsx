import type { Metadata } from 'next';

// Private to each signed-in account: never indexed.
export const metadata: Metadata = { title: 'Your tasks', robots: { index: false, follow: false } };

// /app and /app/{id} share this route so refreshes and links work. The conversation itself lives in the layout, so
// changing between them never remounts it.
export default function Page() {
  return null;
}
