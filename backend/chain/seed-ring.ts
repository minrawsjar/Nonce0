#!/usr/bin/env node
// Seeds the RING_8 pool with decoy deposits.
//
//   node chain/seed-ring.ts --count 8
//
// A ring is eight REAL deposits and the ring client fails closed with fewer
// than seven decoys, so a fresh pool cannot be spent from until it holds some.
// These are genuine notes, derived with the same AES commitment the ring proof
// proves against, so they are spendable later: their secrets are appended to
// backend/.env and NEVER printed.
//
// For testing only, and honest about it: every decoy here comes from one
// address, so an observer knows they belong together. That does not reveal
// which ring member a spend used — the proof is zero knowledge — but a real
// anonymity set is many independent depositors, not one seeding script.

import { appendFileSync, readFileSync } from 'node:fs';

import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { asChainId, toHex } from '@opaque/protocol-types/codecs.js';

import { deployment, poolFor } from '../../deployments/index.ts';
import { createNoteSecret, deriveCommitment } from '../zk/spend.ts';
import { ARC_TESTNET } from './pool.ts';

const argv = process.argv.slice(2);
const count = Number(argv[argv.indexOf('--count') + 1] ?? 8);
if (!Number.isInteger(count) || count < 1 || count > 32) throw new Error('--count must be 1..32');

const key = process.env['EGRESS_PRIVATE_KEY'];
if (key === undefined) throw new Error('EGRESS_PRIVATE_KEY must be set in the environment');

const pool = poolFor(1_000_000, 'RING_8');
const scope = { chainId: asChainId(BigInt(deployment.network.chainId)), pool: pool.address, denomination: pool.denomination } as never;
const account = privateKeyToAccount(key as `0x${string}`);
const publicClient = createPublicClient({ chain: ARC_TESTNET, transport: http() });
const wallet = createWalletClient({ account, chain: ARC_TESTNET, transport: http() });
const ERC20 = parseAbi(['function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)']);
const POOL = parseAbi(['function deposit(bytes32 commitment)']);

// Refuse to overwrite: these are funds, and a lost secret is a lost note.
if (/^RING_DECOY_SECRETS=/m.test(readFileSync('.env', 'utf8'))) {
  throw new Error('RING_DECOY_SECRETS already exists in backend/.env — refusing to overwrite spendable notes');
}

const secrets = Array.from({ length: count }, () => createNoteSecret());
const commitments = secrets.map((s) => deriveCommitment(s, scope) as unknown as `0x${string}`);

// Written BEFORE any deposit: a crash mid-way must not strand funded notes
// whose secrets were never recorded.
appendFileSync('.env', `\n# RING_8 decoy notes (${pool.address}) — spendable; do not delete\nRING_DECOY_SECRETS=${secrets.map((s) => toHex(s)).join(',')}\n`, { mode: 0o600 });

const need = BigInt(pool.denomination) * BigInt(count);
// Exactly what these deposits need. Never MaxUint256: an unlimited approval to
// a pool is an unlimited approval for as long as the key exists.
const approveTx = await wallet.writeContract({ address: deployment.tokens.usdc.address, abi: ERC20, functionName: 'approve', args: [pool.address, need] });
await publicClient.waitForTransactionReceipt({ hash: approveTx });
console.log(`approved ${count} USDC   ${approveTx}`);

for (const [i, commitment] of commitments.entries()) {
  const tx = await wallet.writeContract({ address: pool.address, abi: POOL, functionName: 'deposit', args: [commitment] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  console.log(`deposit ${i + 1}/${count}  ${commitment.slice(0, 18)}…  block ${receipt.blockNumber}  ${receipt.status}`);
}
