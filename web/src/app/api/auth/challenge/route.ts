import { issueChallenge } from '@/lib/server/session';

/** Step 1 of sign-in: a one-time nonce for the wallet to sign. */
export async function POST() {
  return Response.json(await issueChallenge(), { headers: { 'cache-control': 'no-store' } });
}
