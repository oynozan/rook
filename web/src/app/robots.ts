import type { MetadataRoute } from 'next';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:7110';

// The landing page is public; the app and its API are per-account and stay out of search.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', allow: '/', disallow: ['/app', '/api'] }, sitemap: `${SITE}/sitemap.xml` };
}
