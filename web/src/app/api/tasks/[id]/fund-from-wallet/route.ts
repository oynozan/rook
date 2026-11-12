import { currentAccount } from '@/lib/server/session';
import { fundTaskFromWallet, respond, signedOut } from '@/lib/server/wallet';

/** Funds the signed-in account's planned task from its agent wallet, in place of a transfer from its own wallet. */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const owner = await currentAccount();
  if (!owner) return signedOut();
  return respond(await fundTaskFromWallet(owner, id));
}
