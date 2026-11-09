import type { NextConfig } from 'next';

const dev = process.env.NODE_ENV === 'development';

// The wallet connector (@hot-labs/near-connect) runs each wallet's code in a sandboxed srcdoc iframe, and a srcdoc
// iframe inherits this page's policy. So the policy must let wallet code run: wallet bundles are inline, use eval and
// WebAssembly, fetch their code from the manifest's hosts (raw.githubusercontent.com, cdn.jsdelivr.net, wallet.intear.tech,
// trezu.app, ...), talk to their own bridges and RPCs over https and wss, load fonts and icons, and open native-app
// deep links in hidden iframes. ponytail: script-src keeps 'unsafe-inline' and 'unsafe-eval' and connect-src allows any
// https/wss origin, because the wallet list is a remote manifest that changes; what this policy still blocks is framing
// (frame-ancestors), plugins, <base> hijacking, form posts elsewhere, and scripts loaded from other origins.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'`,
  "style-src 'self' 'unsafe-inline' https:",
  "font-src 'self' data: https:",
  "img-src 'self' data: blob: https:",
  `connect-src 'self' https: wss:${dev ? ' ws:' : ''}`,
  'frame-src https: hotwallet: intent: meteorwallet: meteorwalletdev: intear: near-mobile-wallet:',
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const config: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: csp },
        { key: 'X-Frame-Options', value: 'DENY' }, // for browsers that predate frame-ancestors
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      ],
    }];
  },
};

export default config;
