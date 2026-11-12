import { currentAccount } from '@/lib/server/session';
import { readWallet, respond, signedOut } from '@/lib/server/wallet';

/** The signed-in account's agent wallet (docs/agent-wallet-plan.md); configured false when the services have none. */
export async function GET() {
  const owner = await currentAccount();
  return owner ? respond(await readWallet(owner)) : signedOut();
}
