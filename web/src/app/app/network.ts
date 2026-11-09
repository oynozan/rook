// The NEAR network wallets connect to. In a plain module (not a 'use client' one) so server code can read it too.
export const NETWORK = process.env.NEXT_PUBLIC_NEAR_NETWORK === 'testnet' ? 'testnet' : 'mainnet';
