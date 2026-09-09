#!/usr/bin/env node
// The managed egress, from the command line.
//
//   node mesh/run-egress.ts --port 8091 --pool 0x… --secret-file ./egress.mac
//
// Two secrets meet here and neither may be a flag: the release MAC shared with
// the confidential workflow, and the key that signs the settlement transaction.
// Both are read from files or the environment, never argv, because a value in
// argv is in the process list and in every `ps` on the box.
//
// This service sees a spend in the clear once its MAC verifies. That is why it
// is separate from every relay and why its secret is not shared with one.

import { readFileSync } from 'node:fs';

import { ProtocolFailure, type Address } from '@opaque/protocol-types';
import { privateKeyToAccount } from 'viem/accounts';

import { createPoolClient, poolSubmitter } from '../chain/pool.ts';
import { createEgress } from './egress.ts';

const flags = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  const key = argv[i];
  const value = argv[i + 1];
  if (key === undefined || !key.startsWith('--') || value === undefined) {
    throw new ProtocolFailure('INVALID_INPUT', `expected --flag value, got ${String(key)}`);
  }
  flags.set(key.slice(2), value);
}

const need = (name: string): string => {
  const value = flags.get(name);
  if (value === undefined) throw new ProtocolFailure('INVALID_INPUT', `--${name} is required`);
  return value;
};

if (import.meta.filename === process.argv[1]) {
  const secret = new TextEncoder().encode(readFileSync(need('secret-file'), 'utf8').trim());

  // From the environment, never a flag. The egress signs real transactions.
  const signingKey = process.env['EGRESS_PRIVATE_KEY'];
  if (signingKey === undefined) {
    throw new ProtocolFailure('INVALID_INPUT', 'EGRESS_PRIVATE_KEY must be set in the environment');
  }

  const pool = createPoolClient({
    account: privateKeyToAccount(signingKey as `0x${string}`),
    ...(flags.get('rpc-url') === undefined ? {} : { rpcUrl: flags.get('rpc-url')! }),
    // The egress never renders a UI, so these are only carried through for
    // completeness. capabilities() is read by the frontend, not by this.
    offChain: {
      pqWallet: 'MOCK',
      graph: 'FIXTURE',
      confidentialExecution: 'SIMULATED',
      policyScope: 'CRE_WORKFLOW_ONLY',
    },
  });

  const egress = createEgress({ secret, submitter: poolSubmitter(pool) });
  const port = Number(flags.get('port') ?? 8091);
  await egress.listen(port);
  process.stdout.write(`egress listening on ${port}, pool ${need('pool') as Address}\n`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void egress.close().then(() => process.exit(0)));
  }
}
