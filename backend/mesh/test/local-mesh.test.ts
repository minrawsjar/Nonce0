import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Hex, RelayId, UnixSeconds } from '@opaque/protocol-types';

import { toPath, verify } from '../directory.ts';
import { MIN_POOL_RELAYS } from '../contracts.ts';
import { buildLocalMesh, serveLocalMesh, writeLocalMesh } from '../local-mesh.ts';
import { createChannel } from '../return-path.ts';
import { buildOnion, encodeFrame, type MeshMessageKind } from '../transport.ts';

const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stands in for whatever hop 3 actually calls. Records what reached it. */
function egressServer(answer: string) {
  const seen: unknown[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(answer);
    });
  });
  return { server, seen };
}

test('three relays start, and a payment really crosses all three', async () => {
  const mesh = buildLocalMesh(19081);
  const { server, seen } = egressServer('SUBMITTED');
  await new Promise<void>((r) => server.listen(0, r));
  const egressUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/submit`;

  const relays = await serveLocalMesh(
    mesh,
    new Map<MeshMessageKind, string>([['PAYMENT', egressUrl], ['QUERY', egressUrl]]),
  );
  try {
    const directory = mesh.signed.directory;
    const now = (directory.issuedAt + 60n) as UnixSeconds;
    const ids = directory.entries.slice(0, 3).map((e) => e.id) as unknown as readonly [RelayId, RelayId, RelayId];
    const frame = encodeFrame(
      buildOnion({
        path: toPath(directory, ids, now),
        payload: { kind: 'PAYMENT', body: '0xc0ffee' },
        expiresAt: now + 600n,
      }),
    );

    const accepted = await fetch(directory.entries[0]!.endpoint, { method: 'POST', body: frame });
    assert.equal(accepted.status, 202);

    // Each relay drains on its own 250ms clock, so three hops plus the egress
    // call need roughly a second. Polling, not a fixed sleep, so a slow
    // machine does not turn this into a flake.
    for (let i = 0; i < 60 && seen.length === 0; i++) await sleep(50);

    assert.equal(seen.length, 1, 'the payment did not reach egress');
    assert.deepEqual(seen[0], { kind: 'PAYMENT', body: '0xc0ffee' });
  } finally {
    await Promise.all(relays.map((r) => r.close()));
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('relays in one process reach each other over loopback, not their public endpoints', async () => {
  // As on Railway: the directory names public URLs, here ones nothing answers,
  // so a payment arrives only if relay-to-relay hops stay on loopback.
  const mesh = buildLocalMesh({ basePort: 19101, endpointFor: (_id, i) => `https://unreachable.invalid/r${i + 1}/v1/relay` });
  const { server, seen } = egressServer('SUBMITTED');
  await new Promise<void>((r) => server.listen(0, r));
  const egressUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/submit`;
  const relays = await serveLocalMesh(mesh, new Map<MeshMessageKind, string>([['PAYMENT', egressUrl], ['QUERY', egressUrl]]), '127.0.0.1');
  try {
    const directory = mesh.signed.directory;
    const now = (directory.issuedAt + 60n) as UnixSeconds;
    const ids = directory.entries.slice(0, 3).map((e) => e.id) as unknown as readonly [RelayId, RelayId, RelayId];
    const frame = encodeFrame(buildOnion({ path: toPath(directory, ids, now), payload: { kind: 'PAYMENT', body: '0xc0ffee' }, expiresAt: now + 600n }));
    // Hop 1 directly on its loopback port, as the host's proxy would route it.
    const accepted = await fetch(`http://127.0.0.1:${mesh.ports.get(ids[0])!}/v1/relay`, { method: 'POST', body: frame });
    assert.equal(accepted.status, 202);
    for (let i = 0; i < 60 && seen.length === 0; i++) await sleep(50);
    assert.equal(seen.length, 1, 'the payment did not cross the relays');
  } finally {
    await Promise.all(relays.map((r) => r.close()));
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('a query crosses three relays and the answer comes back through a drop', async () => {
  const mesh = buildLocalMesh(19091);
  const { server } = egressServer('CONFIRMED');
  await new Promise<void>((r) => server.listen(0, r));
  const egressUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/query`;

  const relays = await serveLocalMesh(
    mesh,
    new Map<MeshMessageKind, string>([['QUERY', egressUrl]]),
  );
  try {
    const directory = mesh.signed.directory;
    const now = (directory.issuedAt + 60n) as UnixSeconds;
    const ids = directory.entries.slice(0, 3).map((e) => e.id) as unknown as readonly [RelayId, RelayId, RelayId];
    const channel = createChannel(ids[2]!);

    await fetch(directory.entries[0]!.endpoint, {
      method: 'POST',
      body: encodeFrame(
        buildOnion({
          path: toPath(directory, ids, now),
          payload: {
            kind: 'QUERY',
            body: '0xabcd',
            responseKey: channel.responseKey,
            returnRoute: channel.returnRoute,
          },
          expiresAt: now + 600n,
        }),
      ),
    });

    // The client collects from the drop over its own connection, with the
    // drop id as its only credential.
    const dropUrl = `http://127.0.0.1:${mesh.ports.get(ids[2]!)!}/v1/status/${channel.dropId}`;
    let sealed: Hex | undefined;
    for (let i = 0; i < 60 && sealed === undefined; i++) {
      const response = await fetch(dropUrl);
      if (response.status === 200) sealed = ((await response.json()) as { sealed: Hex }).sealed;
      else await sleep(50);
    }
    assert.notEqual(sealed, undefined, 'no answer was ever deposited');
    assert.equal(text(channel.open(sealed!)), 'CONFIRMED');

    // Single-use: the credential is spent by the collection above.
    assert.equal((await fetch(dropUrl)).status, 204);
  } finally {
    await Promise.all(relays.map((r) => r.close()));
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('the generated directory verifies against the trust root it writes', () => {
  const mesh = buildLocalMesh();
  const directory = verify(mesh.signed, mesh.root, mesh.signed.directory.issuedAt);
  assert.equal(directory.entries.length, MIN_POOL_RELAYS, 'six running, three per payment');
  // Real keys, not derived from a seed: two runs must never coincide.
  assert.notEqual(
    buildLocalMesh().signed.directory.entries[0]!.kemPublicKey,
    directory.entries[0]!.kemPublicKey,
  );
});

test('the files it writes are loadable, and the keys are not world-readable', () => {
  const out = mkdtempSync(join(tmpdir(), 'opaque-mesh-'));
  const mesh = buildLocalMesh();
  writeLocalMesh(out, mesh);

  const revive = (_k: string, v: unknown): unknown =>
    typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v;
  const signed = JSON.parse(readFileSync(join(out, 'directory.json'), 'utf8'), revive);
  const root = JSON.parse(readFileSync(join(out, 'trust-root.json'), 'utf8'), revive);
  // The bigints survived the round trip, which is the only reason this
  // verifies rather than throwing on a string where a version should be.
  assert.equal(verify(signed, root, mesh.signed.directory.issuedAt).version, 1n);

  for (const id of mesh.secretKeys.keys()) {
    const path = join(out, `${id}.key`);
    assert.equal(readFileSync(path, 'utf8').trim(), mesh.secretKeys.get(id));
    assert.equal(statSync(path).mode & 0o077, 0, `${id}.key is readable by other users`);
  }
});
