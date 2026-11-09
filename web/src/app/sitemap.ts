import type { MetadataRoute } from 'next';

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:7110';

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: SITE, changeFrequency: 'weekly', priority: 1 }];
}
