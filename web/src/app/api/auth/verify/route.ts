import { verifySignIn } from '@/app/app/session';

/** Step 2 of sign-in: the wallet's NEP-413 signature. On success a session cookie is set. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const out = await verifySignIn(body ?? {});
  return Response.json(out, { status: out.ok ? 200 : 401, headers: { 'cache-control': 'no-store' } });
}
