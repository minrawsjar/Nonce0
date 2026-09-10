import { readFile } from 'node:fs/promises';
import { parseAccountConfig } from '../src/account-config.ts';
import { ArcChainAdapter } from '../src/arc-chain-adapter.ts';
const path = process.env.PQ_ACCOUNT_CONFIG;
if (!path) throw new Error('Set PQ_ACCOUNT_CONFIG to a reviewed deployment configuration file');
const network = new ArcChainAdapter(parseAccountConfig(JSON.parse(await readFile(path, 'utf8'))));
await network.check();
console.log(JSON.stringify({ network: network.config.chainId, deploymentAndEntryPointChecks: 'PASS',
  customBundlerSimulation: 'NOT_ESTABLISHED_BY_THIS_CHECK', g2Passed: false }));
