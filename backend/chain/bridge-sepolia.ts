#!/usr/bin/env node
// Moves USDC from Ethereum Sepolia to Arc testnet over Circle's CCTP V2, to
// the same address: approve and burn on Sepolia, Circle's attestation, mint
// on Arc.
//
//   set -a && . ./.env && set +a && node chain/bridge-sepolia.ts --amount 1600
//
// A fast transfer (finality 1000), for Circle's fee as its API quotes it now
// (1 bp when written). Signs with FUNDER_KEY, else EGRESS_PRIVATE_KEY; the
// Sepolia side needs a little ETH, the Arc side a little USDC for gas.

import { createPublicClient, createWalletClient, formatUnits, http, pad, parseAbi, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

import { deployment } from '../../deployments/index.ts';
import { ARC_TESTNET, rpcTransport } from './pool.ts';

// CCTP V2 testnet: the same contracts on every chain (developers.circle.com/cctp).
const TOKEN_MESSENGER = '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa';
const MESSAGE_TRANSMITTER = '0xe737e5cebeeba77efe34d4aa090756590b1ce275';
const SEPOLIA_USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
const SEPOLIA_DOMAIN = 0;
const ARC_DOMAIN = 26;
const IRIS = 'https://iris-api-sandbox.circle.com';

const i = process.argv.indexOf('--amount');
const amount = parseUnits(i === -1 ? '' : process.argv[i + 1]!, 6);
if (amount <= 0n) throw new Error('--amount <USDC>, e.g. --amount 1600');
const key = process.env['FUNDER_KEY'] ?? process.env['EGRESS_PRIVATE_KEY'];
if (key === undefined) throw new Error('FUNDER_KEY or EGRESS_PRIVATE_KEY must be set');
const account = privateKeyToAccount(key as `0x${string}`);

const sepoliaRpc = http('https://ethereum-sepolia-rpc.publicnode.com');
const sep = createPublicClient({ chain: sepolia, transport: sepoliaRpc });
const sepWallet = createWalletClient({ account, chain: sepolia, transport: sepoliaRpc });
const arc = createPublicClient({ chain: ARC_TESTNET, transport: rpcTransport() });
const arcWallet = createWalletClient({ account, chain: ARC_TESTNET, transport: rpcTransport() });
const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const ok = async (client: typeof sep | typeof arc, hash: `0x${string}`) => {
  if ((await client.waitForTransactionReceipt({ hash })).status !== 'success') throw new Error(`reverted: ${hash}`);
};

const ERC20 = parseAbi(['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const have = await sep.readContract({ address: SEPOLIA_USDC, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
if (have < amount) throw new Error(`only ${formatUnits(have, 6)} USDC on Sepolia`);

// Circle's quote, in basis points; maxFee is a ceiling, so twice it.
const quotes = (await (await fetch(`${IRIS}/v2/burn/USDC/fees/${SEPOLIA_DOMAIN}/${ARC_DOMAIN}`)).json()) as { finalityThreshold: number; minimumFee: number }[];
const bps = quotes.find((q) => q.finalityThreshold === 1000)?.minimumFee ?? 1;
const maxFee = (amount * BigInt(Math.round(bps * 100)) * 2n) / 1_000_000n;
const arcBalance = () => arc.readContract({ address: deployment.tokens.usdc.address, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
const arcBefore = await arcBalance();
log(`bridging ${formatUnits(amount, 6)} USDC Sepolia → Arc for ${account.address}; fee ≤ ${formatUnits(maxFee, 6)} USDC`);

await ok(sep, await sepWallet.writeContract({ address: SEPOLIA_USDC, abi: ERC20, functionName: 'approve', args: [TOKEN_MESSENGER, amount] }));
const burn = await sepWallet.writeContract({
  address: TOKEN_MESSENGER,
  abi: parseAbi(['function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)']),
  functionName: 'depositForBurn',
  args: [amount, ARC_DOMAIN, pad(account.address), SEPOLIA_USDC, pad('0x'), maxFee, 1000],
});
await ok(sep, burn);
log(`burned on Sepolia  https://sepolia.etherscan.io/tx/${burn}`);

let message: { status?: string; message?: `0x${string}`; attestation?: `0x${string}` } | undefined;
for (let t = 0; t < 180 && message?.status !== 'complete'; t++) {
  await new Promise((r) => setTimeout(r, 5_000));
  const res = await fetch(`${IRIS}/v2/messages/${SEPOLIA_DOMAIN}?transactionHash=${burn}`);
  if (res.ok) message = ((await res.json()) as { messages?: typeof message[] }).messages?.[0];
}
if (message?.status !== 'complete') throw new Error(`no attestation after 15 min; rerun the mint later for burn ${burn}`);
log('attested by Circle');

const mint = await arcWallet.writeContract({
  address: MESSAGE_TRANSMITTER,
  abi: parseAbi(['function receiveMessage(bytes message, bytes attestation) returns (bool)']),
  functionName: 'receiveMessage',
  args: [message.message!, message.attestation!],
});
await ok(arc, mint);
log(`minted on Arc: +${formatUnits((await arcBalance()) - arcBefore, 6)} USDC  ${deployment.network.explorer}/tx/${mint}`);
