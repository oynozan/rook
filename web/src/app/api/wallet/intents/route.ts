import { currentAccount } from '@/lib/server/session';
import { prepareIntent, respond, signedOut } from '@/lib/server/wallet';

/** One owner intent for the signed-in account's wallet to sign: a setup step, or a vote on a pending spend. */
export async function POST(req: Request) {
  const owner = await currentAccount();
  if (!owner) return signedOut();
  return respond(await prepareIntent(owner, await req.json().catch(() => null)));
}
