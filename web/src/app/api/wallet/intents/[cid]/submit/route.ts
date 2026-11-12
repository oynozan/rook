import { currentAccount } from '@/lib/server/session';
import { respond, signedOut, submitIntent } from '@/lib/server/wallet';

/** The wallet's signature on intent `cid`, passed on for the signed-in account; answers with the wallet as it is now. */
export async function POST(req: Request, { params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  const owner = await currentAccount();
  if (!owner) return signedOut();
  return respond(await submitIntent(owner, cid, await req.json().catch(() => null)));
}
