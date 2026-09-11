// Read-only diagnostic: public test keys, simulated funding, no broadcast.
import { readFile } from 'node:fs/promises';
import { parseAbi } from 'viem';
import { asBytes32 } from '@opaque/protocol-types/codecs.js';
import { parseAccountConfig } from '../src/account-config.ts';
import { ArcChainAdapter } from '../src/arc-chain-adapter.ts';
import { keyGen, pkCommitment, sign, encodeSignature } from '../src/fors.ts';
import { actionCallData, packedGas, accountDigest, signatureEnvelope } from '../src/user-operation.ts';

const path = process.env.PQ_ACCOUNT_CONFIG;
if (!path) throw new Error('Set PQ_ACCOUNT_CONFIG to the deployment config');
const network = new ArcChainAdapter(parseAccountConfig(JSON.parse(await readFile(path, 'utf8'))));
await network.check();
const key = keyGen(new Uint8Array(32).fill(1), { k: 32, a: 8 });
const next = keyGen(new Uint8Array(32).fill(2), { k: 32, a: 8 });
const a = pkCommitment(key.publicKey), b = pkCommitment(next.publicKey);
const now = (await network.client.getBlock()).timestamp;
const deadline = now + 86400n * 30n;
const salt = asBytes32(`0x${'aa'.repeat(32)}`);
const sender = await network.address(a, b, deadline, salt);
const price = await network.client.getGasPrice();
const context = { chainId: BigInt(network.config.chainId), entryPoint: network.config.entryPoint,
  epoch: 0n, useCount: 0n, validAfter: now, validUntil: now + 300n };
const abi = parseAbi(['function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)']);
for (const verification of [499999n, 600000n]) {
  const op = { sender, nonce: 0n, initCode: network.initCode(a, b, deadline, salt), callData: actionCallData(0),
    accountGasLimits: packedGas(verification, 500000n), preVerificationGas: 250000n, gasFees: packedGas(price, price * 2n),
    paymasterAndData: '0x' as const, signature: '0x' as `0x${string}` };
  op.signature = signatureEnvelope(context, encodeSignature(key.publicKey, sign(key.secretKey, accountDigest(op, context))));
  try {
    await network.client.simulateContract({ address: network.config.entryPoint, abi, functionName: 'handleOps',
      args: [[op], '0x0000000000000000000000000000000000000001'], account: '0x0000000000000000000000000000000000000001',
      gas: 3000000n, stateOverride: [{ address: sender, balance: 100n * 10n ** 18n }] });
    console.log(JSON.stringify({ verificationGas: verification.toString(), exactEntryPointSimulation: 'PASS', broadcast: false }));
  } catch (error) {
    // Print just the decoded failure, never request payloads or endpoint URLs.
    const e = error as { shortMessage?: string; cause?: { reason?: string; data?: { args?: unknown[] } } };
    console.log(JSON.stringify({ verificationGas: verification.toString(), exactEntryPointSimulation: 'FAIL',
      reason: e.cause?.data?.args?.map(String) ?? e.cause?.reason ?? e.shortMessage ?? 'RPC failed', broadcast: false }));
  }
}
