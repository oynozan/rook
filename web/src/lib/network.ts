// The NEAR network wallets connect to. In a plain module (not a 'use client' one) so server code can read it too.
export const NETWORK = process.env.NEXT_PUBLIC_NEAR_NETWORK === 'testnet' ? 'testnet' : 'mainnet';
export type Network = 'mainnet' | 'testnet';

export const DEFAULT_RPC = { mainnet: 'https://rpc.mainnet.fastnear.com', testnet: 'https://rpc.testnet.fastnear.com' } as const;

/** RPC for reads from the browser or the server. NEXT_PUBLIC_NEAR_RPC_URL overrides the app's own network only. */
export const rpcFor = (network: Network) => (network === NETWORK && process.env.NEXT_PUBLIC_NEAR_RPC_URL) || DEFAULT_RPC[network];

export const explorerTx = (network: Network, hash: string) =>
  `https://${network === 'mainnet' ? '' : 'testnet.'}nearblocks.io/txns/${encodeURIComponent(hash)}`;
