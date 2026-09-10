import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPqWallet } from '../src/wallet.ts';
import { MockWalletChain, mockWalletOptions } from '../src/mock.ts';

export async function checkMockLifecycle() {
  const chain = new MockWalletChain(); const options = mockWalletOptions(chain); const wallet = createPqWallet(options);
  const created = await wallet.create(); await wallet.register();
  const signed = await wallet.signUserOperation('0x1234');
  const beforeSubmit = await wallet.getState();
  const operationTxHash = await chain.acceptUserOperation(signed);
  let replayRejected = false;
  try { await chain.acceptUserOperation(signed); } catch { replayRejected = true; }
  if (!replayRejected || beforeSubmit.chainUseCount !== 0n || beforeSubmit.localSigningReservations !== 1n) throw new Error('Mock lifecycle check failed');
  const rotationTxHash = await wallet.rotate();
  const rotated = await createPqWallet(options).getState();
  if (rotated.keyEpoch !== 1n || rotated.pkCommitment === created.pkCommitment) throw new Error('Mock rotation check failed');
  const disableTxHash = await wallet.disable(); chain.now += 30n * 24n * 60n * 60n;
  if ((await wallet.getState()).active) throw new Error('Mock disable check failed');
  return { mode: 'MOCK', g2Passed: false, checkedAt: new Date().toISOString(),
    checks: { pendingSigningExposurePreserved: true, replayRejected, confirmedRotation: true, disableTimelock: true },
    mockTransactionHashes: { operationTxHash, rotationTxHash, disableTxHash },
    blockers: ['Approved epoch/payload/deadline rules not provided', 'LIVE account/validator/EntryPoint/bundler adapter and configuration not provided',
      'Arc deployment/compatibility receipts and measured verification gas not available'] };
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (!args.includes('--mock')) throw new Error('This runner is MOCK-only. It cannot pass G2.');
  const output = resolve('benchmarks/mock-lifecycle.json'); const result = await checkMockLifecycle();
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Mock lifecycle passed; G2 remains false. Evidence: ${output}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Lifecycle check failed'); process.exitCode = 1; });
}
