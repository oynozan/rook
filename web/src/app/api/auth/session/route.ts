import { currentAccount, signOut } from '@/app/app/session';

/** Who is signed in, if anyone. */
export async function GET() {
  return Response.json({ account: await currentAccount() }, { headers: { 'cache-control': 'no-store' } });
}

/** Sign out. */
export async function DELETE() {
  await signOut();
  return Response.json({ account: null });
}
