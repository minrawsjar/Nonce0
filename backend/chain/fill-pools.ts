#!/usr/bin/env node
// Fills RING_8 pools to a ring's worth of deposits, from several fresh
// accounts, at random intervals.
//
//   set -a && . ./.env && set +a && node chain/fill-pools.ts --pools 2,5 \
//     [--target 8] [--accounts 5] [--gap 30-180] [--reserve 8]
//
// The funder (FUNDER_KEY, else EGRESS_PRIVATE_KEY) pays each account exactly
// what its deposits need plus gas, and keeps --reserve USDC: the egress key
// also pays for every settlement. No account ends up with more than a quarter
// of a pool, past which selectDecoys treats one funder's notes as one cluster
// (§8.1). Run it again as the funder has more; it only adds what is missing.
//
// Honest about what it is: one operator behind every account. The notes are
// real and spendable — every key and note secret is in .env.seeders.json
// (0600, gitignored), written before any money moves, never printed — but a
// pool filled this way is no anonymity set against whoever filled it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { createPublicClient, createWalletClient, formatUnits, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { asChainId, toHex } from '@opaque/protocol-types/codecs.js';

import { deployment, poolFor } from '../../deployments/index.ts';
import { createNoteSecret, deriveCommitment } from '../zk/spend.ts';
import { ARC_TESTNET, rpcTransport } from './pool.ts';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1]!;
};
const denoms = arg('pools', '').split(',').filter(Boolean).map(Number);
const target = Number(arg('target', '8'));
const accountCount = Number(arg('accounts', '5'));
const [gapMin, gapMax] = arg('gap', '30-180').split('-').map(Number) as [number, number];
const reserve = BigInt(Math.round(Number(arg('reserve', '8')) * 1e6));
if (denoms.length === 0) throw new Error('--pools, e.g. --pools 2,5 (USDC)');

const funderKey = process.env['FUNDER_KEY'] ?? process.env['EGRESS_PRIVATE_KEY'];
if (funderKey === undefined) throw new Error('FUNDER_KEY or EGRESS_PRIVATE_KEY must be set');

const USDC = deployment.tokens.usdc.address;
const ERC20 = parseAbi([
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
const POOL = parseAbi(['function deposit(bytes32 commitment)', 'function depositCount() view returns (uint256)']);
const publicClient = createPublicClient({ chain: ARC_TESTNET, transport: rpcTransport() });
const clientFor = (key: `0x${string}`) => createWalletClient({ account: privateKeyToAccount(key), chain: ARC_TESTNET, transport: rpcTransport() });
const usd = (v: bigint) => `${formatUnits(v, 6)} USDC`;
const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const send = async (hash: `0x${string}`) => {
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`reverted: ${hash}`);
};

interface Note { pool: string; denomination: number; account: string; secret: string; commitment: string; tx?: string }
interface State { accounts: { key: `0x${string}`; address: string }[]; notes: Note[] }
const STATE = '.env.seeders.json';
const state: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { accounts: [], notes: [] };
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 1), { mode: 0o600 });

// ── the plan: what each pool is missing, spread so no account passes 25% ──
const cap = Math.max(1, Math.floor(target / 4));
while (state.accounts.length < accountCount) {
  const key = generatePrivateKey();
  state.accounts.push({ key, address: privateKeyToAccount(key).address });
}
const accounts = state.accounts.slice(-accountCount);
const planned: Note[] = [];
for (const d of denoms) {
  const pool = poolFor(d * 1_000_000, 'RING_8');
  const scope = { chainId: asChainId(BigInt(deployment.network.chainId)), pool: pool.address, denomination: pool.denomination } as never;
  const have = Number(await publicClient.readContract({ address: pool.address, abi: POOL, functionName: 'depositCount' }));
  const need = Math.max(0, target - have);
  if (need > accounts.length * cap) throw new Error(`${d} USDC pool needs ${need} deposits: use at least ${Math.ceil(need / cap)} --accounts`);
  // Round-robin from a random start: no account gets more than cap of a pool.
  const start = Math.floor(Math.random() * accounts.length);
  for (let i = 0; i < need; i++) {
    const secret = createNoteSecret();
    planned.push({
      pool: pool.address, denomination: pool.denomination, account: accounts[(start + i) % accounts.length]!.address,
      secret: toHex(secret), commitment: deriveCommitment(secret, scope) as string,
    });
  }
  log(`${d} USDC pool: ${have} on chain, ${need} to add`);
}

// ── money: exactly the deposits plus gas, and the funder keeps its reserve ──
const gasPrice = await publicClient.getGasPrice();
// An approve and a deposit per note, at a generous 150k gas each, x1.5.
const gasPerNote = (gasPrice * 150_000n * 2n * 3n / 2n) / 10n ** 12n; // 18-decimal native → 6-decimal USDC
const owed = new Map<string, bigint>();
for (const n of planned) owed.set(n.account, (owed.get(n.account) ?? 0n) + BigInt(n.denomination) + gasPerNote);
const total = [...owed.values()].reduce((a, b) => a + b, 0n);
const funder = clientFor(funderKey as `0x${string}`);
const funds = await publicClient.readContract({ address: USDC, abi: ERC20, functionName: 'balanceOf', args: [funder.account.address] });
log(`plan: ${planned.length} deposits from ${owed.size} accounts, ${usd(total)}; funder holds ${usd(funds)}, keeps ${usd(reserve)}`);
if (planned.length === 0) process.exit(0);
if (funds - total < reserve) throw new Error(`not enough: need ${usd(total + reserve - funds)} more in the funder`);

// Written BEFORE any money moves: a crash must not strand funded notes or accounts.
state.notes.push(...planned);
save();

for (const [address, amount] of owed) {
  await send(await funder.writeContract({ address: USDC, abi: ERC20, functionName: 'transfer', args: [address as `0x${string}`, amount] }));
  log(`funded ${address.slice(0, 10)}… with ${usd(amount)}`);
}

// ── deposits, shuffled, at random gaps ──
const queue = [...planned].sort(() => Math.random() - 0.5);
for (const [i, note] of queue.entries()) {
  if (i > 0) {
    const gap = gapMin + Math.random() * (gapMax - gapMin);
    log(`next in ${Math.round(gap)} s`);
    await new Promise((r) => setTimeout(r, gap * 1000));
  }
  const wallet = clientFor(accounts.find((a) => a.address === note.account)!.key);
  await send(await wallet.writeContract({ address: USDC, abi: ERC20, functionName: 'approve', args: [note.pool as `0x${string}`, BigInt(note.denomination)] }));
  const tx = await wallet.writeContract({ address: note.pool as `0x${string}`, abi: POOL, functionName: 'deposit', args: [note.commitment as `0x${string}`] });
  await send(tx);
  note.tx = tx;
  save();
  const count = await publicClient.readContract({ address: note.pool as `0x${string}`, abi: POOL, functionName: 'depositCount' });
  log(`${note.denomination / 1e6} USDC pool → ${count} deposits (from ${note.account.slice(0, 10)}…)  ${deployment.network.explorer}/tx/${tx}`);
}
log('done');
