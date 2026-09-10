import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PqWallet } from '@opaque/protocol-types';
import { createMockPqWallet } from '../src/mock.ts';

export async function createAndRegister(wallet: PqWallet) {
  const created = await wallet.create();
  const txHash = await wallet.register();
  return { accountAddress: created.accountAddress, txHash, state: await wallet.getState() };
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (!args.includes('--mock')) throw new Error('LIVE account adapter/configuration is not supplied. Use --mock for the explicitly simulated demonstration.');
  const result = await createAndRegister(createMockPqWallet());
  console.log(JSON.stringify({ mode: 'MOCK', g2Passed: false, ...result }, (_, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Create/register failed'); process.exitCode = 1; });
}
