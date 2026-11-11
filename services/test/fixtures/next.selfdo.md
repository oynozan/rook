Here is a complete, runnable Next.js 14 (App Router) landing page for Tidy.

package.json
```json
{
  "name": "tidy-landing",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "14.2.5",
    "react": "18.3.1",
    "react-dom": "18.3.1"
  },
  "devDependencies": {
    "@types/node": "20.14.0",
    "@types/react": "18.3.3",
    "@types/react-dom": "18.3.0",
    "autoprefixer": "10.4.19",
    "postcss": "8.4.39",
    "tailwindcss": "3.4.6",
    "typescript": "5.5.3"
  }
}
```

next.config.mjs
```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
```

tsconfig.json
```json
{
  "compilerOptions": {
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

tailwind.config.ts
```ts
import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef2ff",
          100: "#e0e7ff",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#4338ca",
        },
      },
    },
  },
  plugins: [],
};

export default config;
```

postcss.config.mjs
```js
/** @type {import('postcss-load-config').Config} */
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

app/globals.css
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html {
  scroll-behavior: smooth;
}

body {
  @apply bg-slate-50 text-slate-900 antialiased;
}
```

app/layout.tsx
```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tidy — The calm todo app",
  description:
    "Tidy is a delightfully simple todo app. Capture fast, organize smartly, and never miss a thing.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

app/page.tsx
```tsx
import Navbar from "@/components/Navbar";
import Hero from "@/components/Hero";
import Features from "@/components/Features";
import Pricing from "@/components/Pricing";
import FAQ from "@/components/FAQ";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <main>
      <Navbar />
      <Hero />
      <Features />
      <Pricing />
      <FAQ />
      <Footer />
    </main>
  );
}
```

components/Navbar.tsx
```tsx
const links = [
  { href: "#features", label: "Features" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
];

export default function Navbar() {
  return (
    <header className="sticky top-0 z-50 border-b border-slate-200 bg-white/80 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
        <a href="#" className="flex items-center gap-2 text-lg font-bold text-brand-600">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">
            ✓
          </span>
          Tidy
        </a>
        <div className="flex items-center gap-6">
          <ul className="hidden items-center gap-6 text-sm font-medium text-slate-600 sm:flex">
            {links.map((link) => (
              <li key={link.href}>
                <a className="hover:text-brand-600" href={link.href}>
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
          <a
            href="#pricing"
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-brand-700"
          >
            Get started
          </a>
        </div>
      </nav>
    </header>
  );
}
```

components/Hero.tsx
```tsx
export default function Hero() {
  return (
    <section className="bg-gradient-to-b from-brand-50 to-slate-50">
      <div className="mx-auto max-w-6xl px-4 py-24 text-center sm:py-32">
        <h1 className="mx-auto max-w-3xl text-4xl font-extrabold tracking-tight text-slate-900 sm:text-6xl">
          The calm way to get things done
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-600">
          Tidy is a delightfully simple todo app. Capture tasks in a flash,
          organize them with smart lists, and let gentle reminders keep you on
          track — without the clutter.
        </p>
        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <a
            href="#pricing"
            className="rounded-xl bg-brand-600 px-8 py-3 text-base font-semibold text-white shadow-lg shadow-brand-600/20 hover:bg-brand-700"
          >
            Start for free
          </a>
          <a
            href="#features"
            className="rounded-xl border border-slate-300 bg-white px-8 py-3 text-base font-semibold text-slate-700 hover:border-brand-500 hover:text-brand-600"
          >
            See features
          </a>
        </div>
        <p className="mt-4 text-sm text-slate-500">
          No credit card required. Free forever plan.
        </p>
      </div>
    </section>
  );
}
```

components/Features.tsx
```tsx
const features = [
  {
    icon: "⚡",
    title: "Quick capture",
    description:
      "Add a task in under two seconds with natural input. Type “call mom tomorrow 6pm” and Tidy schedules it for you automatically.",
  },
  {
    icon: "🧠",
    title: "Smart lists",
    description:
      "Today, Upcoming and Priority views organize themselves. Tidy sorts your tasks by deadline, tags and importance — no manual filing.",
  },
  {
    icon: "🔔",
    title: "Gentle reminders",
    description:
      "Nudges that actually help. Get reminders by email or push, snooze with one tap, and never let a task slip through the cracks.",
  },
  {
    icon: "🔁",
    title: "Recurring tasks",
    description:
      "Water the plants every Friday, review budgets monthly. Set it once and Tidy repeats it forever.",
  },
  {
    icon: "🤝",
    title: "Shared lists",
    description:
      "Collaborate on groceries, trips or team sprints. Assign tasks and watch progress in real time.",
  },
  {
    icon: "🌙",
    title: "Focus mode",
    description:
      "One task at a time. Focus mode dims everything else so you can finish what matters, then move on.",
  },
];

export default function Features() {
  return (
    <section id="features" className="mx-auto max-w-6xl px-4 py-20 sm:py-24">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
          Everything you need, nothing you don’t
        </h2>
        <p className="mt-4 text-lg text-slate-600">
          Tidy strips away the noise so you can focus on doing, not managing
          your todos.
        </p>
      </div>
      <div className="mt-14 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((feature) => (
          <div
            key={feature.title}
            className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:shadow-md"
          >
            <div className="text-3xl">{feature.icon}</div>
            <h3 className="mt-4 text-lg font-semibold text-slate-900">
              {feature.title}
            </h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              {feature.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
```

components/Pricing.tsx
```tsx
const tiers = [
  {
    name: "Free",
    price: "$0",
    description: "For personal, everyday task tracking.",
    features: ["Unlimited tasks", "Smart lists", "1 reminder per day", "Web & mobile apps"],
    cta: "Get started",
    highlighted: false,
  },
  {
    name: "Pro",
    price: "$4",
    description: "For busy people who live by their lists.",
    features: [
      "Everything in Free",
      "Unlimited reminders",
      "Recurring tasks",
      "Calendar sync",
      "File attachments",
    ],
    cta: "Start 14-day trial",
    highlighted: true,
  },
  {
    name: "Team",
    price: "$8",
    description: "For groups that share the workload.",
    features: [
      "Everything in Pro",
      "Shared lists & assignments",
      "Team activity feed",
      "Admin controls",
      "Priority support",
    ],
    cta: "Contact sales",
    highlighted: false,
  },
];

export default function Pricing() {
  return (
    <section id="pricing" className="bg-white">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            Simple pricing
          </h2>
          <p className="mt-4 text-lg text-slate-600">
            Start free, upgrade when Tidy becomes indispensable. Prices are per
            user, per month.
          </p>
        </div>
        <div className="mt-14 grid gap-8 lg:grid-cols-3">
          {tiers.map((tier) => (
            <div
              key={tier.name}
              className={
                tier.highlighted
                  ? "relative rounded-2xl border-2 border-brand-600 bg-white p-8 shadow-lg"
                  : "rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"
              }
            >
              {tier.highlighted && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-brand-600 px-3 py-1 text-xs font-semibold text-white">
                  Most popular
                </span>
              )}
              <h3 className="text-lg font-semibold text-slate-900">{tier.name}</h3>
              <p className="mt-1 text-sm text-slate-500">{tier.description}</p>
              <p className="mt-6">
                <span className="text-4xl font-extrabold text-slate-900">
                  {tier.price}
                </span>
                <span className="text-base font-medium text-slate-500"> /user /mo</span>
              </p>
              <ul className="mt-6 space-y-3 text-sm text-slate-600">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2">
                    <span className="text-brand-600">✓</span>
                    {feature}
                  </li>
                ))}
              </ul>
              <a
                href="#"
                className={
                  tier.highlighted
                    ? "mt-8 block rounded-xl bg-brand-600 px-4 py-3 text-center text-sm font-semibold text-white shadow hover:bg-brand-700"
                    : "mt-8 block rounded-xl border border-slate-300 px-4 py-3 text-center text-sm font-semibold text-slate-700 hover:border-brand-500 hover:text-brand-600"
                }
              >
                {tier.cta}
              </a>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
```

components/FAQ.tsx
```tsx
const faqs = [
  {
    question: "Is Tidy really free?",
    answer:
      "Yes! The Free plan includes unlimited tasks, smart lists and access to the web and mobile apps — forever, with no credit card required. Pro and Team plans simply add power features like unlimited reminders and shared lists.",
  },
  {
    question: "Can I use Tidy offline?",
    answer:
      "Absolutely. Tidy works fully offline on mobile and syncs automatically the moment you reconnect, so you can check things off even on a plane or in a basement.",
  },
  {
    question: "How do reminders work?",
    answer:
      "Set a due date and time — or just type it naturally — and Tidy sends a push notification or email at the right moment. On Pro you can have unlimited reminders and snooze them with one tap.",
  },
  {
    question: "Can I cancel or change plans anytime?",
    answer:
      "Yes. Upgrade, downgrade or cancel from your account settings at any time. If you cancel, you keep Pro features until the end of your billing period, and your data stays safe on the Free plan.",
  },
];

export default function FAQ() {
  return (
    <section id="faq" className="mx-auto max-w-3xl px-4 py-20 sm:py-24">
      <h2 className="text-center text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
        Frequently asked questions
      </h2>
      <div className="mt-12 space-y-4">
        {faqs.map((faq) => (
          <details
            key={faq.question}
            className="group rounded-2xl border border-slate-200 bg-white p-6 shadow-sm open:shadow-md"
          >
            <summary className="cursor-pointer list-none text-base font-semibold text-slate-900 marker:hidden">
              <span className="flex items-center justify-between">
                {faq.question}
                <span className="text-slate-400 transition group-open:rotate-45">＋</span>
              </span>
            </summary>
            <p className="mt-4 text-sm leading-6 text-slate-600">{faq.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
```

components/Footer.tsx
```tsx
export default function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto max-w-6xl px-4 py-12">
        <div className="flex flex-col items-center justify-between gap-8 sm:flex-row">
          <div className="flex items-center gap-2 text-lg font-bold text-brand-600">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">
              ✓
            </span>
            Tidy
          </div>
          <nav className="flex flex-wrap items-center justify-center gap-6 text-sm text-slate-600">
            <a href="#features" className="hover:text-brand-600">Features</a>
            <a href="#pricing" className="hover:text-brand-600">Pricing</a>
            <a href="#faq" className="hover:text-brand-600">FAQ</a>
            <a href="#" className="hover:text-brand-600">Privacy</a>
            <a href="#" className="hover:text-brand-600">Terms</a>
            <a href="#" className="hover:text-brand-600">Contact</a>
          </nav>
        </div>
        <p className="mt-8 text-center text-sm text-slate-500">
          © {new Date().getFullYear()} Tidy, Inc. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
```

app/favicon.ico is optional — Next.js will warn but run fine without it. To run:

```
npm install && npm run dev
```

Then open http://localhost:3000. The page includes a sticky nav with anchor links, a gradient hero with CTA, six feature cards, a three-tier pricing section (Free $0 / Pro $4 / Team $8), a four-question FAQ with native `<details>` accordions, and a footer with links and copyright — fully responsive with Tailwind CSS.