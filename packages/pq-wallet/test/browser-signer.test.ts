import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import type { IndexedDbSignerStore } from '../src/indexeddb-store.ts';
import type { initializeSigner, signerSummary } from '../src/signer-state.ts';
import type { signDigest } from '../src/sign.ts';
import type { Bytes32 } from '@opaque/protocol-types';

declare global {
  var pqTest: {
    IndexedDbSignerStore: typeof IndexedDbSignerStore;
    initializeSigner: typeof initializeSigner;
    signerSummary: typeof signerSummary;
    signDigest: typeof signDigest;
    benchmark: () => { keyGenMs: number; signMs: number; verifyMs: number; signatureBytes: number; userAgent: string };
  };
}

test('real_browser_indexeddb_lifecycle', { skip: process.env['PQ_BROWSER_TESTS'] !== '1' }, async t => {
  const built = await build({ stdin: { contents: `
    import { IndexedDbSignerStore } from './src/indexeddb-store.ts';
    import { initializeSigner, signerSummary } from './src/signer-state.ts';
    import { signDigest } from './src/sign.ts';
    import { keyGen, sign, verify, encodeSignature } from './src/fors.ts';
    const benchmark = () => {
      let start = performance.now(); const pair = keyGen(); const keyGenMs = performance.now() - start;
      const digest = '0x' + '42'.repeat(32);
      start = performance.now(); const signature = sign(pair.secretKey, digest); const signMs = performance.now() - start;
      start = performance.now(); const valid = verify(pair.publicKey, digest, signature); const verifyMs = performance.now() - start;
      if (!valid) throw new Error('Browser signature did not verify');
      pair.secretKey.seed.fill(0);
      return { keyGenMs, signMs, verifyMs, signatureBytes: (encodeSignature(pair.publicKey, signature).length - 2) / 2, userAgent: navigator.userAgent };
    };
    globalThis.pqTest = { IndexedDbSignerStore, initializeSigner, signerSummary, signDigest, benchmark };
  `, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' }, bundle: true, write: false, platform: 'browser' });
  const script = built.outputFiles![0]!.text;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/bundle.js' ? 'text/javascript' : 'text/html');
    response.end(request.url === '/bundle.js' ? script : '<script src="/bundle.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const executable = process.env['PQ_CHROMIUM_EXECUTABLE'];
  const browser = await chromium.launch({ ...(executable ? { executablePath: executable } : {}), headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const first = await context.newPage(); const second = await context.newPage();
  const url = `http://127.0.0.1:${address.port}`;
  await Promise.all([first.goto(url), second.goto(url)]);
  const id = await first.evaluate(async () => {
    const { IndexedDbSignerStore, initializeSigner } = globalThis.pqTest;
    const store = new IndexedDbSignerStore('pq-browser-test');
    return initializeSigner(store, { keyEpoch: 0n, maxUses: 8n, lifecycleReserve: 2n, params: { k: 8, a: 4 } });
  });

  await t.test('two_tabs_commit_distinct_reservations', async () => {
    const run = (page: typeof first, n: number) => page.evaluate(async ({ id, n }) => {
      const { IndexedDbSignerStore, signDigest } = globalThis.pqTest;
      return signDigest(new IndexedDbSignerStore('pq-browser-test'), id as Bytes32, `0x${n.toString(16).padStart(64, '0')}` as Bytes32, 'ordinary');
    }, { id, n });
    const outputs = await Promise.all([run(first, 1), run(second, 2)]);
    assert.deepEqual(outputs.map(x => x.signingReservation).sort(), [1n, 2n]);
    await first.reload();
    const retry = await run(first, 1);
    assert.deepEqual(retry, outputs[0]);
  });

  await t.test('refresh_preserves_exposure_without_chain_acceptance', async () => {
    await second.reload();
    const count = await second.evaluate(async id => {
      const { IndexedDbSignerStore, signerSummary } = globalThis.pqTest;
      return (await signerSummary(new IndexedDbSignerStore('pq-browser-test'), id as Bytes32)).localSigningReservations;
    }, id);
    assert.equal(count, 2n); // No operation was submitted to a chain.
  });

  await t.test('tab_loss_after_reservation_cannot_resign_uncertain_digest', async () => {
    await first.evaluate(async id => {
      const { IndexedDbSignerStore } = globalThis.pqTest;
      const store = new IndexedDbSignerStore('pq-browser-test');
      await store.transact(id as Bytes32, current => ({ record: { ...current!, revision: current!.revision + 1n,
        reservations: [...current!.reservations, { index: 3n, digest: `0x${'03'.padStart(64, '0')}` as Bytes32 }] }, result: undefined }));
      await store.close();
    }, id);
    await first.close();
    const code = await second.evaluate(async id => {
      const { IndexedDbSignerStore, signDigest } = globalThis.pqTest;
      try { await signDigest(new IndexedDbSignerStore('pq-browser-test'), id as Bytes32, `0x${'03'.padStart(64, '0')}` as Bytes32, 'ordinary'); }
      catch (error) { return (error as { code: string }).code; }
      return 'unexpected-success';
    }, id);
    assert.equal(code, 'SIGNER_STATE_UNSAFE');
  });

  await t.test('transaction_abort_preserves_existing_record', async () => {
    const count = await second.evaluate(async id => {
      const { IndexedDbSignerStore, signerSummary } = globalThis.pqTest;
      const store = new IndexedDbSignerStore('pq-browser-test');
      try { await store.transact(id as Bytes32, () => { throw new Error('test abort'); }); } catch { /* expected */ }
      return (await signerSummary(store, id as Bytes32)).localSigningReservations;
    }, id);
    assert.equal(count, 3n);
  });

  await t.test('wallet_metadata_compare_and_swap_survives_reload', async () => {
    const created = await second.evaluate(async id => {
      const store = new globalThis.pqTest.IndexedDbSignerStore('pq-browser-test');
      const record = { version: 1 as const, revision: 0n, accountAddress: `0x${'aa'.repeat(20)}` as import('@opaque/protocol-types').Address,
        authorityId: `0x${'cc'.repeat(32)}` as Bytes32,
        active: id as Bytes32, next: `0x${'bb'.repeat(32)}` as Bytes32, rotationDeadline: 1000n,
        lastChainUseCount: 0n, lastObservedBlock: 0n, registered: false };
      const results = await Promise.all([store.compareAndSwapWallet('wallet', undefined, record), store.compareAndSwapWallet('wallet', undefined, record)]);
      await store.close(); return results;
    }, id);
    assert.deepEqual(created.sort(), [false, true]);
    await second.reload();
    assert.equal(await second.evaluate(async () => {
      return (await new globalThis.pqTest.IndexedDbSignerStore('pq-browser-test').readWallet('wallet'))!.revision;
    }), 0n);
  });

  await t.test('default_scheme_signs_and_verifies_in_chromium', async () => {
    const samples = [];
    for (let i = 0; i < 3; i++) samples.push(await second.evaluate(() => globalThis.pqTest.benchmark()));
    for (const sample of samples) assert.equal(sample.signatureBytes, 9251);
    if (process.env['PQ_WRITE_BENCHMARKS'] === '1') {
      const directory = new URL('../benchmarks/', import.meta.url);
      await mkdir(directory, { recursive: true });
      await writeFile(new URL('browser.json', directory), `${JSON.stringify({ measuredAt: new Date().toISOString(), mode: 'LOCAL_CHROMIUM',
        scheme: 'FORS+C/keccak256/k=32,a=8', samples, memory: 'Not measured', gas: 'Not measured', g2Passed: false }, null, 2)}\n`);
    }
  });
});
