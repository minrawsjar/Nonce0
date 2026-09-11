#!/usr/bin/env node
// The PQ account, LIVE on Arc: FORS keys in this process, USDC sent to the
// account's address before it exists, then ONE UserOperation, signed once with
// FORS, that deploys the account (initCode: PQAccountFactory.createAccount),
// registers its key and deposits two notes. Then a withdrawal of the rest.
// No ECDSA key signs for the account. Reads and bundler calls run through the
// same WALLET_RPC answerer the mesh exit runs; the page reaches it over the
// mesh, and this script calls it in-process.
//
//   set -a; . ./.env; set +a; node chain/e2e-pq-account.ts
//
// Costs about 2 USDC from EGRESS_PRIVATE_KEY, which only sends the account 2.2
// USDC; the account pays its own deployment, and the withdrawal sends back
// what the deposit left.
// Each note is a random 128-bit image: one more ring member that nobody can
// spend. It must be an image — the pool takes any bytes32, but only a 16-byte
// image right-padded can ever sit in a ring.

import { createPublicClient, createWalletClient, http, parseAbi, parseEther, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { NoteCommitment } from '@opaque/protocol-types';
import { asChainId, toHex } from '@opaque/protocol-types/codecs.js';

import { deployment, poolFor } from '../../deployments/index.ts';
import { MemorySignerStore } from '../../packages/pq-wallet/src/signer-state.ts';
import { MemoryWalletStateStore } from '../../packages/pq-wallet/src/wallet-state.ts';
import { ARC_TESTNET } from './pool.ts';
import { ARC_AUTHORITY, createLivePqWallet, createPqAccountOps, pendingDeployment } from './pq-wallet-chain.ts';
import { createWalletRpcAnswerer } from './wallet-rpc.ts';

const log = (s: string) => process.stdout.write(`${s}\n`);
const payer = privateKeyToAccount(process.env['EGRESS_PRIVATE_KEY'] as `0x${string}`);
const publicClient = createPublicClient({ chain: ARC_TESTNET, transport: http() });
const funder = createWalletClient({ account: payer, chain: ARC_TESTNET, transport: http() });

const walletRpc = createWalletRpcAnswerer({
  publicClient: publicClient as never, bundlerUrl: ARC_AUTHORITY.bundlerUrl,
  entryPoint: ARC_AUTHORITY.entryPoint, accountImplementation: ARC_AUTHORITY.accountImplementation, factory: ARC_AUTHORITY.factory,
});
const walletStore = new MemoryWalletStateStore();
const wallet = createLivePqWallet({
  signerStore: new MemorySignerStore(), walletStore,
  publicClient: publicClient as never, payer: async () => funder, walletRpc,
});

const created = await wallet.create();
const account = created.accountAddress;
log(`account   ${account} (counterfactual: CREATE2 over its FORS commitments; no code yet: ${(await publicClient.getCode({ address: account })) === undefined})`);

const fund = await funder.sendTransaction({ to: account, value: parseEther('2.2') });
await publicClient.waitForTransactionReceipt({ hash: fund });
log(`fund      ${fund} (2.2 USDC to the undeployed address: two denominations, the rest for gas)`);
const registered = await wallet.getState();

const ring8 = poolFor(1_000_000, 'RING_8');
const scope = { chainId: asChainId(BigInt(deployment.network.chainId)), pool: ring8.address, denomination: ring8.denomination } as never;
const ops = createPqAccountOps({ wallet, account, authority: ARC_AUTHORITY, walletRpc, deployment: () => pendingDeployment(wallet, walletStore) });
const image = () => toHex(new Uint8Array([...crypto.getRandomValues(new Uint8Array(16)), ...new Uint8Array(16)])) as NoteCommitment;
const commitments = [image(), image()];
const tx = await ops.deposit({ scope, commitments });

const receipt = await publicClient.getTransactionReceipt({ hash: tx as `0x${string}` });
const events = parseEventLogs({
  abi: parseAbi(['event DepositFrom(bytes32 indexed commitment, address indexed depositor)', 'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)']),
  logs: receipt.logs,
});
const op = events.find((e) => e.eventName === 'UserOperationEvent');
const deposits = events.filter((e) => e.eventName === 'DepositFrom');
const after = await wallet.getState();
log(`deposit   ${tx} (${receipt.status}, bundled by ${receipt.from})`);
log(`          userOp success=${op?.args.success} gas=${op?.args.actualGasUsed} paid by the account`);
const fromAccount = deposits.every((d) => d.args.depositor.toLowerCase() === account);
log(`          ${deposits.length} notes deposited, all by the account: ${fromAccount}`);
const created2 = events.length > 0 && receipt.logs.some((l) => l.address.toLowerCase() === ARC_AUTHORITY.factory.toLowerCase());
log(`          deployed by this operation: ${created2}; active=${after.active}`);
log(`          FORS useCount ${registered.chainUseCount} -> ${after.chainUseCount} of ${after.maxUses} (one signature: deploy, register, both notes)`);
if (receipt.status !== 'success' || op?.args.success !== true || deposits.length !== 2 || !fromAccount || !created2
  || registered.active || !after.active || after.chainUseCount !== 1n) process.exit(1);

const before = await publicClient.getBalance({ address: payer.address });
const out = await ops.withdraw(payer.address.toLowerCase() as never);
const back = (await publicClient.getBalance({ address: payer.address })) - before;
const left = await ops.funds();
log(`withdraw  ${out} (${(Number(back) / 1e18).toFixed(4)} USDC back to the payer; account ${left.usdc6} left, ${(Number(left.prepaidGas) / 1e18).toFixed(4)} prepaid gas)`);
log(`          FORS useCount -> ${(await wallet.getState()).chainUseCount} of ${after.maxUses}`);
if (back <= 0n) process.exit(1);
