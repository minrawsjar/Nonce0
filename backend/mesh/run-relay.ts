#!/usr/bin/env node
// One relay, started from the command line. This is what an operator runs.
//
//   node mesh/run-relay.ts --id R1 --port 8081 --directory ./relays.json \
//     --secret-key-file ./r1.key
//
// The secret key is read from a FILE, never from a flag and never from an
// argument. A key on the command line is in the process list, in the shell
// history and in every `ps` any other user on the box can run.
//
// Three of these plus a signed directory is the mesh. They must be run by
// three different operators to mean anything: three processes on one laptop
// share one machine, one network and one log, so they collude by construction
// even though the code cannot tell the difference. `npm run mesh:local` starts
// exactly that, for development, and says so.

import { readFileSync } from 'node:fs';

import { ProtocolFailure, type Hex, type RelayId } from '@opaque/protocol-types';

import { verify } from './directory.ts';
import { createRelay } from './server.ts';
import type { DirectoryTrustRoot, SignedDirectory } from './contracts.ts';
import type { MeshMessageKind } from './transport.ts';

interface Flags {
  readonly [key: string]: string | undefined;
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === undefined || !key.startsWith('--') || value === undefined) {
      throw new ProtocolFailure('INVALID_INPUT', `expected --flag value, got ${String(key)}`);
    }
    flags[key.slice(2)] = value;
  }
  return flags;
}

const need = (flags: Flags, name: string): string => {
  const value = flags[name];
  if (value === undefined) throw new ProtocolFailure('INVALID_INPUT', `--${name} is required`);
  return value;
};

export function startFromFlags(argv: readonly string[]): ReturnType<typeof createRelay> {
  const flags = parseFlags(argv);
  const relayId = need(flags, 'id') as RelayId;

  // The directory is VERIFIED here, against a root pinned in a file the
  // operator controls — not trusted because it came from a path we were given.
  // A relay that runs on an unverified directory forwards to whatever keys an
  // attacker put in it.
  const signed = JSON.parse(readFileSync(need(flags, 'directory'), 'utf8'), (_k, v) =>
    typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  ) as SignedDirectory;
  const root = JSON.parse(readFileSync(need(flags, 'trust-root'), 'utf8'), (_k, v) =>
    typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  ) as DirectoryTrustRoot;

  const directory = verify(signed, root, BigInt(Math.floor(Date.now() / 1000)) as never);
  if (!directory.entries.some((entry) => entry.id === relayId)) {
    throw new ProtocolFailure('INVALID_INPUT', `${relayId} is not listed in this directory`);
  }

  const secretKey = readFileSync(need(flags, 'secret-key-file'), 'utf8').trim() as Hex;
  const entry = directory.entries.find((e) => e.id === relayId)!;

  const egress = new Map<MeshMessageKind, string>();
  if (flags['egress-payment'] !== undefined) egress.set('PAYMENT', flags['egress-payment']);
  if (flags['egress-query'] !== undefined) egress.set('QUERY', flags['egress-query']);

  return createRelay({
    relayId,
    secretKey,
    keyEpoch: entry.keyEpoch,
    directory,
    egress,
    batchWindowMs: Number(flags['batch-window-ms'] ?? 250),
    maxExtraDelayMs: Number(flags['max-extra-delay-ms'] ?? 250),
  });
}

// Exact path, not a basename match: `endsWith('run-relay.ts')` would also
// fire for any other script that happens to end that way.
if (import.meta.filename === process.argv[1]) {
  const argv = process.argv.slice(2);
  const relay = startFromFlags(argv);
  const port = Number(need(parseFlags(argv), 'port'));
  await relay.listen(port);
  // The only thing this process ever prints. Not a request, not an id, not a
  // peer: an operator needs to know it is up, and nothing more.
  process.stdout.write(`${relay.relayId} listening on ${port}\n`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void relay.close().then(() => process.exit(0)));
  }
}
