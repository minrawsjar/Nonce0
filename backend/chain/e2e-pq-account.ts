#!/usr/bin/env node
// The PQ account, LIVE on Arc: FORS keys in this process, the account deployed
// by PQAccountFactory, a deposit it signs with FORS and sends as a v0.7
// UserOperation through a public bundler, then a withdrawal of what is left.
// No ECDSA key signs for the account. Reads and bundler calls run through the
// same WALLET_RPC answerer the mesh exit runs; the page reaches it over the
// mesh, and this script calls it in-process.
//
//   set -a; . ./.env; set +a; node chain/e2e-pq-account.ts
//
// Costs about 1 USDC from EGRESS_PRIVATE_KEY: it pays for the deploy and funds
// the account with 1.2, and the withdrawal sends back what the deposit left. The deposit is a random 128-bit image: one more ring
// member that nobody can spend. It must be an image — the pool takes any
// bytes32, but only a 16-byte image right-padded can ever sit in a ring.

import { createPublicClient, createWalletClient, http, parseAbi, parseEther, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { NoteCommitment } from '@opaque/protocol-types';
import { asChainId, toHex } from '@opaque/protocol-types/codecs.js';

import { deployment, poolFor } from '../../deployments/index.ts';
import { MemorySignerStore } from '../../packages/pq-wallet/src/signer-state.ts';
import { MemoryWalletStateStore } from '../../packages/pq-wallet/src/wallet-state.ts';
import { ARC_TESTNET } from './pool.ts';
import { ARC_AUTHORITY, createLivePqWallet, createPqAccountOps } from './pq-wallet-chain.ts';
import { createWalletRpcAnswerer } from './wallet-rpc.ts';

const log = (s: string) => process.stdout.write(`${s}\n`);
const payer = privateKeyToAccount(process.env['EGRESS_PRIVATE_KEY'] as `0x${string}`);
const publicClient = createPublicClient({ chain: ARC_TESTNET, transport: http() });
const funder = createWalletClient({ account: payer, chain: ARC_TESTNET, transport: http() });

const walletRpc = createWalletRpcAnswerer({
  publicClient: publicClient as never, bundlerUrl: ARC_AUTHORITY.bundlerUrl,
  entryPoint: ARC_AUTHORITY.entryPoint, accountImplementation: ARC_AUTHORITY.accountImplementation,
});
const wallet = createLivePqWallet({
  signerStore: new MemorySignerStore(), walletStore: new MemoryWalletStateStore(),
  publicClient: publicClient as never, payer: async () => funder, walletRpc,
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
const ops = createPqAccountOps({ wallet, account, authority: ARC_AUTHORITY, walletRpc });
const commitment = toHex(new Uint8Array([...crypto.getRandomValues(new Uint8Array(16)), ...new Uint8Array(16)])) as NoteCommitment;
const tx = await ops.deposit({ scope, commitment });

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

const before = await publicClient.getBalance({ address: payer.address });
const out = await ops.withdraw(payer.address.toLowerCase() as never);
const back = (await publicClient.getBalance({ address: payer.address })) - before;
const left = await ops.funds();
log(`withdraw  ${out} (${(Number(back) / 1e18).toFixed(4)} USDC back to the payer; account ${left.usdc6} left, ${(Number(left.prepaidGas) / 1e18).toFixed(4)} prepaid gas)`);
log(`          FORS useCount -> ${(await wallet.getState()).chainUseCount} of ${after.maxUses}`);
if (back <= 0n) process.exit(1);
