import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { asBytes32, asAddress } from '@opaque/protocol-types/codecs.js';
import { keyGen, sign, verify, encodeSignature, forsSchemeId, FORS_C_DEFAULT } from '../src/fors.ts';

export function measureLocal(iterations = 5) {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100) throw new Error('iterations must be 1..100');
  const digest = asBytes32(`0x${'42'.repeat(32)}`);
  const keygen: number[] = []; const signing: number[] = []; const verification: number[] = [];
  let signatureBytes = 0;
  for (let i = 0; i < iterations; i++) {
    let start = performance.now(); const pair = keyGen(); keygen.push(performance.now() - start);
    start = performance.now(); const signature = sign(pair.secretKey, digest); signing.push(performance.now() - start);
    start = performance.now(); const valid = verify(pair.publicKey, digest, signature); verification.push(performance.now() - start);
    if (!valid) throw new Error('Generated signature did not verify');
    signatureBytes = (encodeSignature(pair.publicKey, signature).length - 2) / 2;
    pair.secretKey.seed.fill(0);
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  return { measuredAt: new Date().toISOString(), environment: { runtime: process.version, platform: process.platform, arch: process.arch },
    mode: 'LOCAL_NODE' as const, schemeId: forsSchemeId(FORS_C_DEFAULT), parameters: FORS_C_DEFAULT, iterations, signatureBytes,
    milliseconds: { keyGenMedian: median(keygen), signMedian: median(signing), verifyMedian: median(verification),
      keyGenSamples: keygen, signSamples: signing, verifySamples: verification },
    g2Passed: false, note: 'Node measurements only. No browser, gas, security-level, or live PQ-authority claim.' };
}

export async function collectVerificationReceipt(input: {
  rpc: (method: string, params: unknown[]) => Promise<unknown>;
  chainId: bigint; txHash: string; verifier: string; calldata: string;
}) {
  const txHash = asBytes32(input.txHash); const verifier = asAddress(input.verifier);
  if (!/^0x(?:[0-9a-f]{2})+$/.test(input.calldata)) throw new Error('Expected exact verification calldata');
  if (BigInt(String(await input.rpc('eth_chainId', []))) !== input.chainId) throw new Error('Unexpected RPC chain');
  const receipt = await input.rpc('eth_getTransactionReceipt', [txHash]) as Record<string, unknown> | null;
  const tx = await input.rpc('eth_getTransactionByHash', [txHash]) as Record<string, unknown> | null;
  if (!receipt || !tx || receipt['transactionHash'] !== txHash || tx['hash'] !== txHash || receipt['status'] !== '0x1' ||
      String(tx['to']).toLowerCase() !== verifier || tx['input'] !== input.calldata ||
      receipt['blockHash'] !== tx['blockHash'] || receipt['blockNumber'] !== tx['blockNumber'] || !receipt['blockHash']) {
    throw new Error('No matching successful verification transaction');
  }
  const gasUsed = BigInt(String(receipt['gasUsed']));
  if (gasUsed <= 0n) throw new Error('Invalid receipt gas');
  return { chainId: input.chainId.toString(), transactionHash: txHash, verifier, gasUsed: gasUsed.toString(),
    blockNumber: BigInt(String(receipt['blockNumber'])).toString(), blockHash: receipt['blockHash'],
    calldataBytes: (input.calldata.length - 2) / 2, source: 'SUCCESSFUL_TRANSACTION_RECEIPT',
    note: 'Whole transaction gas, not isolated hashing cost. Does not establish full EntryPoint/bundler G2 compatibility.' };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const network = option('--network') ?? 'local';
  if (!['local', 'arc-testnet'].includes(network)) throw new Error('Use --network local or arc-testnet');
  let receipt: unknown;
  if (network === 'arc-testnet') {
    const required = ['PQ_RPC_URL', 'PQ_CHAIN_ID', 'PQ_VERIFICATION_TX_HASH', 'PQ_VERIFIER_ADDRESS', 'PQ_EXPECTED_CALLDATA'] as const;
    if (required.some(name => !process.env[name])) throw new Error(`Arc measurement requires ${required.join(', ')} and a previously submitted verification transaction`);
    const rpc = async (method: string, params: unknown[]) => {
      const response = await fetch(process.env['PQ_RPC_URL']!, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('RPC request failed');
      const value = await response.json() as { result?: unknown; error?: unknown };
      if (value.error) throw new Error('RPC returned an error');
      return value.result;
    };
    receipt = await collectVerificationReceipt({ rpc, chainId: BigInt(process.env['PQ_CHAIN_ID']!),
      txHash: process.env['PQ_VERIFICATION_TX_HASH']!, verifier: process.env['PQ_VERIFIER_ADDRESS']!, calldata: process.env['PQ_EXPECTED_CALLDATA']! });
  }
  const result = { ...measureLocal(), ...(receipt ? { arcVerificationReceipt: receipt } : {}) };
  const output = resolve(option('--output') ?? 'benchmarks/local-node.json');
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Measured ${result.signatureBytes} signature bytes; wrote ${output}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Benchmark failed'); process.exitCode = 1; });
}
