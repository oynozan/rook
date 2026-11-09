// Sets up Rook on NEAR from one admin account, idempotently: the contract, orchestrator and signer accounts (as
// sub-accounts of the admin), the budget contract, its USDC registration, the two role keys, and the env file
// `pnpm live` reads. Every step checks the chain first and skips what is already done. contract/README.md, "Mainnet".
//
//   pnpm --filter @rook/services exec tsx scripts/deploy.ts [--network mainnet] [--dry] [--upgrade]
//
// Admin key: ROOK_ADMIN_KEY, or ADMIN_WALLET_PRIVATE_KEY in the repo's .env (read here only, never by a service).
// New keys go to ~/.rook/accounts/<network>/<account>.json (written before the transaction that uses them), the
// env file to ~/.rook/<network>.env. Nothing is written inside the repo.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { KeyPair, actions, baseEncode, type KeyPairString } from 'near-api-js';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const NETWORK = arg('network', 'mainnet') as 'mainnet' | 'testnet';
const DRY = process.argv.includes('--dry');
process.env.NEAR_NETWORK = NETWORK;
process.env.NEAR_RPC_URL ??= NETWORK === 'mainnet' ? 'https://free.rpc.fastnear.com' : 'https://test.rpc.fastnear.com';
const { functionCall, rpc, sendTx, viewCall, explorerTx } = await import('../src/shared/near.ts');

const REPO = resolve(import.meta.dirname, '../..');
const HOME = join(homedir(), '.rook');
const USDC = NETWORK === 'mainnet' ? '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1' : arg('usdc', '');
const WASM = join(REPO, 'contract/target/wasm32-unknown-unknown/release/rook_budget.opt.wasm');
const NEAR = 10n ** 24n;
const near = (s: string) => BigInt(Math.round(Number(s) * 1e6)) * (NEAR / 1_000_000n);
const fmt = (y: bigint) => (Number(y / 10n ** 18n) / 1e6).toFixed(4);
const ORCH_METHODS = ['fund_subtask', 'top_up', 'record_receipt', 'close_task', 'mark_empty'];
const SIGNER_METHODS = ['register_subtask_key'];

function adminKey(): KeyPair {
  let k = process.env.ROOK_ADMIN_KEY;
  if (!k && existsSync(join(REPO, '.env'))) {
    k = readFileSync(join(REPO, '.env'), 'utf8').match(/^\s*ADMIN_WALLET_PRIVATE_KEY\s*=\s*['"]?([^'"\s]+)/m)?.[1];
  }
  if (!k) throw new Error('set ROOK_ADMIN_KEY or ADMIN_WALLET_PRIVATE_KEY in .env');
  return KeyPair.fromString((k.includes(':') ? k : `ed25519:${k}`) as KeyPairString);
}

async function accountOf(pk: string): Promise<string> {
  if (process.env.ROOK_ADMIN_ACCOUNT) return process.env.ROOK_ADMIN_ACCOUNT;
  const r = await fetch(`https://${NETWORK === 'mainnet' ? '' : 'test.'}api.fastnear.com/v0/public_key/${pk}`);
  const ids: string[] = (await r.json())?.account_ids ?? [];
  const named = ids.filter((a) => !/^[0-9a-f]{64}$/.test(a));
  if (named.length !== 1) throw new Error(`key ${pk} belongs to ${JSON.stringify(ids)}: set ROOK_ADMIN_ACCOUNT`);
  return named[0];
}

const viewAccount = (id: string) => rpc('query', { request_type: 'view_account', finality: 'final', account_id: id }).catch((e) => {
  if (/UNKNOWN_ACCOUNT|does not exist/.test(String(e?.message))) return null;
  throw e;
});
const keyList = async (id: string) => (await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: id })).keys as any[];

type Saved = { account_id: string; public_key: string; private_key: string; kind: 'full' | 'function-call'; receiver_id?: string; methods?: string[] };
const keyDir = join(HOME, 'accounts', NETWORK);
const keyFile = (account: string, kind: Saved['kind']) => join(keyDir, `${account}${kind === 'full' ? '' : '.fc'}.json`);
function loadKey(account: string, kind: Saved['kind']): KeyPair | null {
  const f = keyFile(account, kind);
  return existsSync(f) ? KeyPair.fromString(JSON.parse(readFileSync(f, 'utf8')).private_key) : null;
}
/** A new key pair, saved to disk before any transaction uses it. */
function newKey(account: string, kind: Saved['kind'], extra: Partial<Saved> = {}): KeyPair {
  const k = KeyPair.fromRandom('ed25519');
  mkdirSync(keyDir, { recursive: true });
  const f = keyFile(account, kind);
  if (existsSync(f)) throw new Error(`${f} exists; refusing to overwrite a key`);
  const saved: Saved = { account_id: account, public_key: k.getPublicKey().toString(), private_key: k.toString(), kind, ...extra };
  writeFileSync(f, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(f, 0o600); } catch { /* Windows: ACLs of the home folder apply */ }
  return k;
}

async function send(label: string, signer: string, key: KeyPair, receiver: string, acts: any[]) {
  if (DRY) { console.log(`  [dry] ${label}`); return null; }
  const r = await sendTx(signer, key, receiver, acts);
  console.log(`  ${r.success ? 'ok  ' : 'FAIL'} ${label}: ${explorerTx(r.hash)}`);
  if (!r.success) throw new Error(`${label} failed: ${JSON.stringify(r.failure)}`);
  return r;
}

const admin = adminKey();
const ADMIN = await accountOf(admin.getPublicKey().toString());
const CONTRACT = process.env.ROOK_CONTRACT_ID || `rook.${ADMIN}`;
const ORCH = process.env.ROOK_ORCHESTRATOR_ACCOUNT || `orch.${ADMIN}`;
const SIGNER = process.env.ROOK_SIGNER_ACCOUNT || `signer.${ADMIN}`;
console.log(`rook deploy (${NETWORK}${DRY ? ', dry run' : ''}): admin ${ADMIN}, contract ${CONTRACT}, orchestrator ${ORCH}, signer ${SIGNER}`);
const adminAcct = await viewAccount(ADMIN);
if (!adminAcct) throw new Error(`admin ${ADMIN} does not exist on ${NETWORK}`);
console.log(`  admin balance ${fmt(BigInt(adminAcct.amount))} NEAR`);

// 1. Accounts, each with a fresh full-access key kept in ~/.rook.
const code = readFileSync(WASM);
const codeStake = BigInt(code.length) * 10n ** 19n;
const plan: [string, bigint][] = [
  // Code stake + state + about 15 funded subtasks at 0.01625 NEAR (contract/README.md).
  [CONTRACT, codeStake + near('0.3')],
  [ORCH, near('0.3')],
  [SIGNER, near('0.15')],
];
for (const [id, amount] of plan) {
  if (await viewAccount(id)) { console.log(`  exists ${id}`); continue; }
  if (!id.endsWith(`.${ADMIN}`)) throw new Error(`${id} does not exist and is not a sub-account of ${ADMIN}: create it first`);
  const k = DRY ? KeyPair.fromRandom('ed25519') : newKey(id, 'full');
  await send(`create ${id} with ${fmt(amount)} NEAR`, ADMIN, admin, id, [actions.createAccount(), actions.transfer(amount), actions.addFullAccessKey(k.getPublicKey())]);
}
const fullKey = (id: string) => loadKey(id, 'full') ?? (DRY ? KeyPair.fromRandom('ed25519') : (() => { throw new Error(`no key for ${id} in ${keyDir}`); })());

// 2. Code (skipped when the deployed code hash matches) and init (skipped when get_config answers).
const hash = baseEncode(createHash('sha256').update(code).digest());
const deployed = (await viewAccount(CONTRACT))?.code_hash;
const inited = await viewCall(CONTRACT, 'get_config').then(() => true, () => false);
if (deployed === hash) console.log(`  code ${hash} already deployed`);
// --upgrade: new code over existing state, for a build whose state layout (the Contract struct) is unchanged.
else if (inited && !process.argv.includes('--upgrade')) throw new Error(`${CONTRACT} has state and other code (${deployed}): pass --upgrade only if the state layout is unchanged, else migrate by hand`);
const initArgs = { owner: ADMIN, orchestrator: ORCH, signer: SIGNER, usdc: USDC };
const acts = [
  ...(deployed === hash ? [] : [actions.deployContract(code)]),
  ...(inited ? [] : [functionCall('new', initArgs, 30)]),
];
if (acts.length) await send(`${deployed === hash ? '' : `deploy ${code.length} bytes (${hash}) `}${inited ? '' : `init ${JSON.stringify(initArgs)}`}`.trim(), CONTRACT, fullKey(CONTRACT), CONTRACT, acts);

// 3. USDC registration for the contract and the admin (min = max = 0.00125 NEAR for native USDC).
const bounds = await viewCall(USDC, 'storage_balance_bounds');
for (const id of [CONTRACT, ADMIN]) {
  if (await viewCall(USDC, 'storage_balance_of', { account_id: id })) { console.log(`  ${id} registered on USDC`); continue; }
  await send(`register ${id} on USDC`, ADMIN, admin, USDC, [functionCall('storage_deposit', { account_id: id, registration_only: true }, 30, BigInt(bounds.min))]);
}

// 4. Role keys: function-call keys limited to this contract and these methods. The full-access keys stay in ~/.rook.
const roleKeys: Record<string, KeyPair> = {};
for (const [id, methods, allowance] of [[ORCH, ORCH_METHODS, near('0.25')], [SIGNER, SIGNER_METHODS, near('0.1')]] as const) {
  let k = loadKey(id, 'function-call');
  const onChain = k && (await keyList(id)).some((x) => x.public_key === k!.getPublicKey().toString());
  if (k && onChain) { console.log(`  ${id} function-call key ${k.getPublicKey()} on chain`); roleKeys[id] = k; continue; }
  if (!k) k = DRY ? KeyPair.fromRandom('ed25519') : newKey(id, 'function-call', { receiver_id: CONTRACT, methods: [...methods] });
  await send(`add ${id} key for ${methods.join(', ')} (allowance ${fmt(allowance)} NEAR)`, id, fullKey(id), id,
    [actions.addFunctionCallAccessKey(k.getPublicKey(), CONTRACT, [...methods], allowance)]);
  roleKeys[id] = k;
}

// 5. The env file `pnpm live` loads (~/.rook/<network>.env): keys stay out of the repo.
const envFile = join(HOME, `${NETWORK}.env`);
const old = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
const token = old.match(/^ROOK_SERVICE_TOKEN=(\S+)/m)?.[1] ?? randomBytes(24).toString('hex');
const lines = [
  `# Written by services/scripts/deploy.ts. Holds role keys: never copy it into the repo.`,
  `NEAR_NETWORK=${NETWORK}`, `NEAR_RPC_URL=${process.env.NEAR_RPC_URL}`, `ROOK_CONTRACT_ID=${CONTRACT}`,
  `ROOK_ORCHESTRATOR_ACCOUNT=${ORCH}`, `ROOK_ORCHESTRATOR_KEY=${roleKeys[ORCH]?.toString() ?? ''}`,
  `ROOK_SIGNER_ACCOUNT=${SIGNER}`, `ROOK_SIGNER_KEY=${roleKeys[SIGNER]?.toString() ?? ''}`,
  `ROOK_SERVICE_TOKEN=${token}`,
  ...(NETWORK === 'mainnet' ? ['ROOK_MARKET=live', 'ROOK_LEDGER=chain', 'ROOK_LLM=near'] : []),
];
if (DRY) console.log(`  [dry] write ${envFile}`);
else {
  mkdirSync(dirname(envFile), { recursive: true });
  writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 });
  console.log(`  wrote ${envFile}`);
}
const cfg = await viewCall(CONTRACT, 'get_config').catch(() => null);
console.log('  contract config:', JSON.stringify(cfg));
for (const id of [ADMIN, CONTRACT, ORCH, SIGNER]) {
  const a = await viewAccount(id);
  console.log(`  ${id}: ${a ? `${fmt(BigInt(a.amount))} NEAR, ${a.storage_usage} bytes` : 'missing'}`);
}
