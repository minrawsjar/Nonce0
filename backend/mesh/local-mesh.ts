#!/usr/bin/env node
// Generates a real six-relay mesh and, optionally, runs it.
//
//   node mesh/local-mesh.ts --out ./.mesh          # write keys + directory
//   node mesh/local-mesh.ts --out ./.mesh --serve  # and start all six
//
// Six relays, three hops. The pool is what a payment draws FROM; the path is
// how far it travels. See MIN_POOL_RELAYS in contracts.ts for why they differ.
//
// The keys here come from the OS, not from a seed, so this is NOT
// deterministicDirectory — that one derives every relay secret from a string
// and exists only so tests reproduce. These are real keys written to real
// files, and the file permissions are the only thing protecting them.
//
// WHAT THIS IS NOT: six processes on one laptop are one operator, one machine,
// one network and one log. They collude by construction, and a bigger pool of
// them does not dilute that even slightly — six colluding relays learn exactly
// what three would. The code cannot tell the difference, which is exactly why
// the difference has to be stated: this is for development and for a demo, and
// a mesh that means anything needs the six entries below run by six different
// people on six different networks.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Hex, RelayId, UnixSeconds } from '@opaque/protocol-types';

import { MIN_POOL_RELAYS } from './contracts.ts';
import type { DirectoryEntry, DirectoryTrustRoot, RelayDirectory, SignedDirectory } from './contracts.ts';
import { deterministicSigner, signDirectory, signerCommitment } from './directory.ts';
import { createRelay, type Relay } from './server.ts';
import { generateRelayKeypair } from './transport.ts';
import type { MeshMessageKind } from './transport.ts';

const DAY = 86_400n;

/** JSON has no bigint. `123n` round-trips through the reviver in run-relay.ts. */
const replacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? `${value}n` : value;

export interface LocalMesh {
  readonly signed: SignedDirectory;
  readonly root: DirectoryTrustRoot;
  readonly secretKeys: ReadonlyMap<RelayId, Hex>;
  readonly ports: ReadonlyMap<RelayId, number>;
}

export interface LocalMeshOptions {
  readonly basePort?: number;
  readonly now?: bigint;
  /**
   * How each relay is addressed BY THE OTHER RELAYS. Defaults to loopback,
   * which is right for one host and wrong everywhere else: in containers hop 1
   * must reach hop 2 by service name, and across machines by hostname. Getting
   * this wrong does not fail at startup — it fails at the first forward, which
   * is a much worse place to find out.
   */
  readonly endpointFor?: (id: RelayId, index: number, port: number) => string;
}

export function buildLocalMesh(
  optionsOrBasePort: LocalMeshOptions | number = {},
  legacyNow?: bigint,
): LocalMesh {
  const options: LocalMeshOptions =
    typeof optionsOrBasePort === 'number'
      ? { basePort: optionsOrBasePort, ...(legacyNow === undefined ? {} : { now: legacyNow }) }
      : optionsOrBasePort;
  const basePort = options.basePort ?? 8081;
  const now = options.now ?? BigInt(Math.floor(Date.now() / 1000));
  const endpointFor =
    options.endpointFor ?? ((_id, _i, port) => `http://127.0.0.1:${port}/v1/relay`);
  const entries: DirectoryEntry[] = [];
  const secretKeys = new Map<RelayId, Hex>();
  const ports = new Map<RelayId, number>();

  for (let i = 1; i <= MIN_POOL_RELAYS; i++) {
    const id = `R${i}` as RelayId;
    const port = basePort + i - 1;
    const keypair = generateRelayKeypair(1n);
    secretKeys.set(id, keypair.secretKey);
    ports.set(id, port);
    entries.push({
      id,
      // Distinct on paper. On one laptop it is one operator wearing six hats,
      // and toPath's no-repeated-operator rule cannot see that.
      operatorId: `local-operator-${i}`,
      endpoint: endpointFor(id, i - 1, port),
      kemPublicKey: keypair.publicKey,
      keyEpoch: keypair.keyEpoch,
      validFrom: now as UnixSeconds,
      validUntil: (now + 30n * DAY) as UnixSeconds,
    });
  }

  // FORS+C is few-time: this key signs ONE directory and the successor is
  // committed below. Regenerating the mesh makes a new signer, which is why
  // the trust root is written out beside the directory rather than baked in.
  const signer = deterministicSigner(`local/${now}`);
  const directory: RelayDirectory = {
    version: 1n,
    issuedAt: now as UnixSeconds,
    expiresAt: (now + 7n * DAY) as UnixSeconds,
    entries,
    nextSignerCommitment: signerCommitment(deterministicSigner(`local/${now}/next`).publicKey),
  };

  return {
    signed: signDirectory(directory, signer),
    root: { signerCommitment: signerCommitment(signer.publicKey), minVersion: 0n },
    secretKeys,
    ports,
  };
}

export function writeLocalMesh(out: string, mesh: LocalMesh): void {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'directory.json'), JSON.stringify(mesh.signed, replacer, 2));
  writeFileSync(join(out, 'trust-root.json'), JSON.stringify(mesh.root, replacer, 2));
  for (const [id, secretKey] of mesh.secretKeys) {
    // 0600. A relay secret key readable by another user on the box is a relay
    // whose every layer that user can peel.
    writeFileSync(join(out, `${id}.key`), `${secretKey}\n`, { mode: 0o600 });
  }
}

/** Starts all three in this process. Development only — see the header. */
export async function serveLocalMesh(
  mesh: LocalMesh,
  egress: ReadonlyMap<MeshMessageKind, string>,
): Promise<readonly Relay[]> {
  const relays: Relay[] = [];
  for (const entry of mesh.signed.directory.entries) {
    const relay = createRelay({
      relayId: entry.id,
      secretKey: mesh.secretKeys.get(entry.id)!,
      keyEpoch: entry.keyEpoch,
      directory: mesh.signed.directory,
      egress,
    });
    await relay.listen(mesh.ports.get(entry.id)!);
    relays.push(relay);
  }
  return relays;
}

if (import.meta.filename === process.argv[1]) {
  const argv = process.argv.slice(2);
  const out = argv[argv.indexOf('--out') + 1] ?? './.mesh';
  const mesh = buildLocalMesh();
  writeLocalMesh(out, mesh);
  process.stdout.write(`wrote a ${MIN_POOL_RELAYS}-relay mesh to ${out}\n`);

  if (argv.includes('--serve')) {
    const egress = new Map<MeshMessageKind, string>([
      ['PAYMENT', argv[argv.indexOf('--egress-payment') + 1] ?? 'http://127.0.0.1:8090/submit'],
      ['QUERY', argv[argv.indexOf('--egress-query') + 1] ?? 'http://127.0.0.1:8090/query'],
    ]);
    const relays = await serveLocalMesh(mesh, egress);
    for (const [id, port] of mesh.ports) process.stdout.write(`${id} listening on ${port}\n`);
    process.stdout.write('THIS IS ONE OPERATOR. Not an anonymity set.\n');
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        void Promise.all(relays.map((r) => r.close())).then(() => process.exit(0));
      });
    }
  }
}
