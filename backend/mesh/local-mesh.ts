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

import { keccak_256 } from '@noble/hashes/sha3.js';

import type { Hex, RelayId, UnixSeconds } from '@opaque/protocol-types';
import { canonical, keyGen, utf8 } from '@opaque/pq-wallet';

import { MIN_POOL_RELAYS } from './contracts.ts';
import type { DirectoryEntry, DirectoryTrustRoot, RelayDirectory, SignedDirectory } from './contracts.ts';
import { signDirectory, signerCommitment } from './directory.ts';
import { createRelay, defaultDeliver, type Relay } from './server.ts';
import { generateRelayKeypair } from './transport.ts';
import type { MeshMessageKind } from './transport.ts';

const DAY = 86_400n;

/** JSON has no bigint. `123n` round-trips through the reviver in run-relay.ts. */
const replacer = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? `${value}n` : value;

export interface LocalMesh {
  /** The directory in force: the last link of `chain`. */
  readonly signed: SignedDirectory;
  /** The root the chain starts from: pinned in the wallet when `master` is set. */
  readonly root: DirectoryTrustRoot;
  /** From `root` to `signed`, each link signed by the key the one before committed to. */
  readonly chain: readonly SignedDirectory[];
  readonly secretKeys: ReadonlyMap<RelayId, Hex>;
  readonly ports: ReadonlyMap<RelayId, number>;
  /** When `signed` stops being the generation in force. Set only with `master`. */
  readonly generationEndsAt?: bigint;
}

/** A directory generation. Its directory stays valid a day past it, so a rollover is not a cliff. */
export const GENERATION_SECONDS = 7n * 86_400n;

const derive = (master: Uint8Array, label: string, ...parts: readonly (string | bigint)[]): Uint8Array =>
  keccak_256(canonical([utf8(`opaque/v1/mesh/${label}`), master, ...parts.map((p) => utf8(String(p)))]));

/** The FORS key that signs generation `g`'s directory. */
const directorySigner = (master: Uint8Array, g: bigint) => keyGen(derive(master, 'directory-signer', g));

/**
 * The root a wallet pins for a mesh derived from `master`: generation `from`'s
 * signer, and `from` as the rollback floor. Start at 0; later builds can pin a
 * later generation, so the chain they are served stays short.
 */
export const meshRootAt = (master: Uint8Array, from = 0n): DirectoryTrustRoot =>
  ({ signerCommitment: signerCommitment(directorySigner(master, from).publicKey), minVersion: from });

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
  /**
   * Derive the mesh from this secret instead of the OS: relay keys and the
   * directory signer of every weekly generation since `genesis`, and the
   * chain of directories from the genesis root to the one in force. The same
   * secret and clock give the same bytes on every boot, so a root compiled
   * into the wallet keeps verifying across restarts, and relays keep their
   * keys until the week turns.
   */
  readonly master?: Uint8Array;
  readonly genesis?: bigint;
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

  if (options.master !== undefined) {
    const master = options.master;
    const genesis = options.genesis ?? now;
    const current = now >= genesis ? (now - genesis) / GENERATION_SECONDS : 0n;
    const chain: SignedDirectory[] = [];
    for (let g = 0n; g <= current; g++) {
      const issuedAt = genesis + g * GENERATION_SECONDS;
      const expiresAt = issuedAt + GENERATION_SECONDS + DAY;
      const entries: DirectoryEntry[] = [];
      for (let i = 1; i <= MIN_POOL_RELAYS; i++) {
        const id = `R${i}` as RelayId;
        const port = basePort + i - 1;
        // ML-KEM takes a 64-byte seed. The epoch is the generation's start,
        // so RelayDirectory sees it move forward each week and never back.
        const keypair = generateRelayKeypair(issuedAt, new Uint8Array([...derive(master, 'relay-kem', id, g, 0n), ...derive(master, 'relay-kem', id, g, 1n)]));
        if (g === current) { secretKeys.set(id, keypair.secretKey); ports.set(id, port); }
        entries.push({
          id, operatorId: `local-operator-${i}`, endpoint: endpointFor(id, i - 1, port), kemPublicKey: keypair.publicKey,
          keyEpoch: keypair.keyEpoch, validFrom: issuedAt as UnixSeconds, validUntil: expiresAt as UnixSeconds,
        });
      }
      chain.push(signDirectory({
        version: g + 1n, issuedAt: issuedAt as UnixSeconds, expiresAt: expiresAt as UnixSeconds, entries,
        nextSignerCommitment: signerCommitment(directorySigner(master, g + 1n).publicKey),
      }, directorySigner(master, g)));
    }
    return {
      signed: chain[chain.length - 1]!, root: meshRootAt(master), chain, secretKeys, ports,
      generationEndsAt: genesis + (current + 1n) * GENERATION_SECONDS,
    };
  }

  for (let i = 1; i <= MIN_POOL_RELAYS; i++) {
    const id = `R${i}` as RelayId;
    const port = basePort + i - 1;
    // Fresh keys every build, so a fresh epoch: RelayDirectory refuses to
    // announce a key under an epoch that does not move forward.
    const keypair = generateRelayKeypair(now);
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
  //
  // From the OS RNG and then dropped. It used to be derived from `now`, which
  // is the directory's own issuedAt: anyone reading a published directory
  // could re-derive this key and its successor, and sign a mesh of their own.
  const signer = keyGen();
  const directory: RelayDirectory = {
    version: 1n,
    issuedAt: now as UnixSeconds,
    expiresAt: (now + 7n * DAY) as UnixSeconds,
    entries,
    nextSignerCommitment: signerCommitment(keyGen().publicKey),
  };
  const signed = signDirectory(directory, signer);

  return {
    signed,
    root: { signerCommitment: signerCommitment(signer.publicKey), minVersion: 0n },
    chain: [signed],
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
  host?: string,
): Promise<readonly Relay[]> {
  const relays: Relay[] = [];
  // Relays in this process hand messages to each other over loopback. Through
  // their public endpoints every hop would leave through the host's proxy and
  // come back in, and under load the proxy fails some of those requests: each
  // one a message lost (a relay cannot retry what it has acknowledged) and a
  // client waiting out its poll.
  const loopback = new Map(mesh.signed.directory.entries.map((e) =>
    [e.endpoint, `http://${host ?? '127.0.0.1'}:${mesh.ports.get(e.id)!}/v1/relay`]));
  const deliver = (url: string, body: Uint8Array) => defaultDeliver(loopback.get(url) ?? url, body);
  for (const entry of mesh.signed.directory.entries) {
    const relay = createRelay({
      relayId: entry.id,
      secretKey: mesh.secretKeys.get(entry.id)!,
      keyEpoch: entry.keyEpoch,
      directory: mesh.signed.directory,
      egress,
      deliver,
    });
    await relay.listen(mesh.ports.get(entry.id)!, host);
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
