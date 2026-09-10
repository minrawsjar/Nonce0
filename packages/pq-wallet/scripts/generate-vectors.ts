import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { asAddress, asChainId } from '@opaque/protocol-types/codecs.js';
import { keyGen, sign, encodeSignature, pkCommitment, forsSchemeId } from '../src/fors.ts';
import { pqDigest } from '../src/digest.ts';
import { userActionPayload, rotationPayload, disablePayload, takeoverPayload } from '../src/registry.ts';

export function generateVectors() {
  // Public, synthetic seeds ONLY. Never pass a wallet's stored key to this generator.
  const keys = [1, 2, 3].map(n => keyGen(new Uint8Array(32).fill(n)));
  const commitments = keys.map(pair => pkCommitment(pair.publicKey));
  const walletAddress = asAddress(`0x${'aa'.repeat(20)}`); const chainId = asChainId(31337n);
  const schemeId = forsSchemeId(keys[0]!.publicKey.params);
  const actions = [
    { name: 'consume', key: 0, useCount: 0n, payload: userActionPayload('0x1234') },
    { name: 'rotate', key: 0, useCount: 0n, payload: rotationPayload(commitments[2]!, 8n, 2000n) },
    { name: 'disable', key: 0, useCount: 0n, payload: disablePayload() },
    { name: 'takeover', key: 1, useCount: 0n, payload: takeoverPayload(commitments[2]!, 8n) },
  ].map(action => {
    const digest = pqDigest({ chainId, walletAddress, schemeId, useCount: action.useCount, payload: action.payload });
    const key = keys[action.key]!;
    return { ...action, useCount: action.useCount.toString(), digest, signature: encodeSignature(key.publicKey, sign(key.secretKey, digest)) };
  });
  for (const pair of keys) pair.secretKey.seed.fill(0);
  return { version: 1, provenance: 'Synthetic public seeds: 32 repetitions of byte 01, 02, 03. Original six-field digest and current registry action encoding.',
    chainId: chainId.toString(), walletAddress, schemeId, commitments, actions };
}
export async function main(): Promise<void> {
  const output = resolve('test/fixtures/authority-vectors.json');
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(generateVectors(), null, 2)}\n`);
  console.log(`Wrote synthetic conformance vectors to ${output}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Vector generation failed'); process.exitCode = 1; });
}
