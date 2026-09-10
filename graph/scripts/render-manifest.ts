#!/usr/bin/env bun
// Renders subgraph.yaml.
//
//   bun scripts/render-manifest.ts                 # from deployments/arc-testnet.json
//   bun scripts/render-manifest.ts graph-config.json   # an explicit config, as before
//
// With no argument it derives everything from deployments/arc-testnet.json,
// the one place addresses live — so the subgraph cannot index a pool the rest
// of the system has since moved off. scopeId is poolId(scope), computed here
// rather than written down, because a hand-copied scopeId is a second copy of
// a value that must match the chain exactly.
import { readFile, writeFile } from 'node:fs/promises';

import { poolId } from '@opaque/protocol-types/codecs.js';

import { deployment } from '../../deployments/index.ts';

type PoolConfig = { readonly address: string; readonly startBlock: number; readonly scopeId: string; readonly denomination: number };
type Config = { readonly relayDirectory: string; readonly startBlock: number; readonly pools: readonly PoolConfig[] };
function fromDeployments(): Config {
  const relay = deployment.contracts.relayDirectory;
  // Refused rather than rendered with a zero address: a subgraph indexing
  // 0x0 deploys cleanly and silently indexes nothing.
  if (relay === null) {
    throw new Error('relayDirectory is not deployed: set contracts.relayDirectory in deployments/arc-testnet.json, or pass an explicit graph-config.json');
  }
  return {
    relayDirectory: relay.address,
    startBlock: relay.deployedAtBlock,
    pools: deployment.pools.map((pool) => ({
      address: pool.address,
      startBlock: pool.deployedAtBlock,
      scopeId: poolId({
        chainId: BigInt(deployment.network.chainId),
        pool: pool.address,
        denomination: pool.denomination,
      } as never),
      denomination: pool.denomination,
    })),
  };
}

const configPath = process.argv[2];
const config: Config = configPath === undefined
  ? fromDeployments()
  : (JSON.parse(await readFile(configPath, 'utf8')) as Config);
// A zero address passes a hex check, deploys cleanly, and indexes nothing — and
// config.example.json is all zeros, so the explicit path refuses it too.
const ZERO = /^0x0{40}$/;
if (ZERO.test(config.relayDirectory) || config.pools.some((pool) => ZERO.test(pool.address))) {
  throw new Error('graph config contains a zero address: set real deployed addresses (or render from deployments/ with no argument)');
}
if (!/^0x[0-9a-fA-F]{40}$/.test(config.relayDirectory) || !Number.isInteger(config.startBlock) || config.startBlock < 0 || !Array.isArray(config.pools) || config.pools.length === 0) {
  throw new Error('graph config requires relayDirectory, non-negative startBlock, and at least one pool');
}
const denominations = new Set([1_000_000, 2_000_000, 5_000_000, 10_000_000, 20_000_000, 50_000_000, 100_000_000]);
const pools = config.pools.map((pool, index) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(pool.address) || !/^0x[0-9a-fA-F]{64}$/.test(pool.scopeId) || !Number.isInteger(pool.startBlock) || pool.startBlock < 0 || !denominations.has(pool.denomination)) {
    throw new Error(`invalid pool config at index ${index}`);
  }
  return `  - kind: ethereum\n    name: PrivatePool${index}\n    network: arc-testnet\n    source:\n      address: "${pool.address}"\n      abi: PrivatePool\n      startBlock: ${pool.startBlock}\n    context:\n      scopeId:\n        type: String\n        data: "${pool.scopeId.toLowerCase()}"\n      denomination:\n        type: String\n        data: "${pool.denomination}"\n    mapping:\n      kind: ethereum/events\n      apiVersion: 0.0.9\n      language: wasm/assemblyscript\n      entities: [RingMember, RingPool]\n      abis:\n        - name: PrivatePool\n          file: ./abis/PrivatePool.json\n      eventHandlers:\n        - event: Deposited(indexed bytes32,uint256)\n          handler: handleDeposited\n      file: ./src/mapping.ts`;
}).join('\n');
const template = await readFile(new URL('../subgraph.template.yaml', import.meta.url), 'utf8');
await writeFile(new URL('../subgraph.yaml', import.meta.url), template
  .replace('{{RELAY_DIRECTORY}}', config.relayDirectory)
  .replace('{{START_BLOCK}}', String(config.startBlock))
  .replace('{{POOL_DATA_SOURCES}}', pools));
