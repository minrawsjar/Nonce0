#!/usr/bin/env node
// The PQ account, LIVE on Arc: FORS keys in this process, the account deployed
// by PQAccountFactory, and a deposit it signs with FORS and sends as a v0.7
// UserOperation through a public bundler. No ECDSA key signs for the account.
//
//   set -a; . ./.env; set +a; node chain/e2e-pq-account.ts
//
// Costs about 1.2 USDC from EGRESS_PRIVATE_KEY, which pays for the deploy and
// funds the account. The deposit is a random 128-bit image: one more ring
// member that nobody can spend. It must be an image — the pool takes any
// bytes32, but only a 16-byte image right-padded can ever sit in a ring.

import { createPublicClient, createWalletClient, http, parseAbi, parseEther, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { NoteCommitment } from '@opaque/protocol-types';
import { asChainId, toHex } from '@opaque/protocol-types/codecs.js';

import { deployment, poolFor } from '../../deployments/index.ts';
import { MemorySignerStore } from '../../packages/pq-wallet/src/signer-state.ts';
import { MemoryWalletStateStore } from '../../packages/pq-wallet/src/wallet-state.ts';
import { ARC_TESTNET, createPoolClient } from './pool.ts';
import { createAccountPool, createLivePqWallet, ARC_AUTHORITY } from './pq-wallet-chain.ts';

const log = (s: string) => process.stdout.write(`${s}\n`);
const payer = privateKeyToAccount(process.env['EGRESS_PRIVATE_KEY'] as `0x${string}`);
const publicClient = createPublicClient({ chain: ARC_TESTNET, transport: http() });
const funder = createWalletClient({ account: payer, chain: ARC_TESTNET, transport: http() });

const wallet = createLivePqWallet({
  signerStore: new MemorySignerStore(), walletStore: new MemoryWalletStateStore(),
  publicClient: publicClient as never, payer: async () => funder,
});

const created = await wallet.create();
const account = created.accountAddress;
log(`account   ${account} (counterfactual: CREATE2 over its FORS commitments)`);

log(`register  ${await wallet.register()} (PQAccountFactory.createAccount)`);
const registered = await wallet.getState();
log(`          active=${registered.active} useCount=${registered.chainUseCount}/${registered.maxUses}`);

const fund = await funder.sendTransaction({ to: account, value: parseEther('1.2') });
await publicClient.waitForTransactionReceipt({ hash: fund });
log(`fund      ${fund} (1.2 USDC: one denomination, the rest for gas)`);

const ring8 = poolFor(1_000_000, 'RING_8');
const scope = { chainId: asChainId(BigInt(deployment.network.chainId)), pool: ring8.address, denomination: ring8.denomination } as never;
const pool = createAccountPool({
  base: createPoolClient({ offChain: { pqWallet: 'LIVE', graph: 'LIVE', confidentialExecution: 'SIMULATED', policyScope: 'CRE_WORKFLOW_ONLY' } }),
  publicClient: publicClient as never, wallet, account, authority: ARC_AUTHORITY,
});
const commitment = toHex(new Uint8Array([...crypto.getRandomValues(new Uint8Array(16)), ...new Uint8Array(16)])) as NoteCommitment;
const tx = await pool.deposit({ scope, commitment });

const receipt = await publicClient.getTransactionReceipt({ hash: tx as `0x${string}` });
const events = parseEventLogs({
  abi: parseAbi(['event DepositFrom(bytes32 indexed commitment, address indexed depositor)', 'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)']),
  logs: receipt.logs,
});
const op = events.find((e) => e.eventName === 'UserOperationEvent');
const from = events.find((e) => e.eventName === 'DepositFrom');
const after = await wallet.getState();
log(`deposit   ${tx} (${receipt.status}, bundled by ${receipt.from})`);
log(`          userOp success=${op?.args.success} gas=${op?.args.actualGasUsed} paid by the account`);
log(`          depositor ${from?.args.depositor} = account: ${from?.args.depositor.toLowerCase() === account}`);
log(`          FORS useCount ${registered.chainUseCount} -> ${after.chainUseCount} of ${after.maxUses}`);
if (receipt.status !== 'success' || op?.args.success !== true || after.chainUseCount !== registered.chainUseCount + 1n) process.exit(1);
