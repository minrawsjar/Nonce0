#!/usr/bin/env node
// Drives the REAL wallet page in headless Chrome, through the running stack,
// to a settlement on Arc.
//
//   terminal 1:  cd backend && set -a && . ./.env && set +a && node stack.ts
//   terminal 2:  cd frontend && npx vite
//   terminal 3:  cd backend && set -a && . ./.env && set +a && node scripts/e2e-wallet-browser.ts
//
// Spends seeded note #2 and burns one attester index — a script you run on
// purpose, not a test that runs itself. Secrets are read here, in Node, and
// only the note is injected into the page's own store, which is exactly where
// a MetaMask deposit would have put it. Everything after that is the page.
//
// Against the hosted wallet, from the Deposit button on:
//
//   APP_URL=https://www.opaque.credit/app.html E2E_WALLET_KEY="$EGRESS_PRIVATE_KEY" \
//     node scripts/e2e-wallet-browser.ts
//
// E2E_WALLET_KEY stands in for MetaMask: the page gets an EIP-1193 provider
// whose eth_sendTransaction is signed HERE, in Node, so the key never enters
// the page. It pays 1 USDC and gas; the note it makes is the one spent.
// E2E_PROFILE=<dir> keeps the browser profile, so a run that stops after its
// deposit leaves the note there and the next run spends it instead of paying
// for another. E2E_PQ=1 deposits from the page's PQ account instead: the
// funding wallet activates it, Node funds it (standing in for a transfer to
// the Receive address), and the deposit is a UserOperation its FORS key signs.
// That run then rotates the key, withdraws what is left, backs up, and restores
// the backup into a fresh browser. E2E_NOTES=<n> sets both amount fields: it
// deposits n notes at once and sends n USDC as n payments, and waits for all n
// to settle. E2E_DEPOSIT and E2E_SEND set the two amounts apart, in whole USDC:
// the page splits each into notes of 1 to 100 USDC, one payment per note.
// E2E_REFUSE=<usdc> first tries a send the notes cannot make and expects the
// page to refuse it. E2E_ONES=<n> deposits n 1-USDC notes in one operation
// instead (the Deposit button would split n into 2s and 5s, whose pools may
// not hold a ring yet), so a send of n exercises n payment lanes at once. E2E_EXTENSION=<extension/dist> runs the wallet as the extension
// (Playwright's Chromium, which still loads unpacked extensions): no wallet in
// the page at all, and Node sends USDC to the account's address before the
// first deposit, which deploys it. Every run fails if the page sent a request
// to anyone but its own origin and the stack: no RPC, bundler, subgraph or CDN.
//
// Uses the Playwright already installed for the wallet SDK's browser test, and
// the machine's own Chrome (channel: 'chrome') rather than a downloaded build.
//
// Outside backend's typecheck on purpose: the waitForFunction callbacks run IN
// THE BROWSER and read `document`, and giving backend the DOM lib to allow them
// would let server code touch `window` and `document` too.
import { writeFileSync } from 'node:fs';

import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { createPublicClient, createWalletClient, http, parseAbiItem, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { asChainId, fromHex } from '@opaque/protocol-types/codecs.js';
import { deployment, poolFor } from '../../deployments/index.ts';
import { deriveCommitment } from '../zk/spend.ts';
import { ARC_TESTNET } from '../chain/pool.ts';

const ring8 = poolFor(1_000_000, 'RING_8');
const scope = { chainId: asChainId(BigInt(deployment.network.chainId)), pool: ring8.address, denomination: ring8.denomination } as never;
let APP_URL = process.env['APP_URL'] ?? 'http://127.0.0.1:5173/app.html';
const EXTENSION = process.env['E2E_EXTENSION'];
const WALLET_KEY = process.env['E2E_WALLET_KEY'] as `0x${string}` | undefined;
const pc = createPublicClient({ chain: ARC_TESTNET, transport: http() });
const RECIPIENT = deployment.accounts.attester;
const NOTES = Number(process.env['E2E_NOTES'] ?? 1);
const DEPOSIT = Number(process.env['E2E_DEPOSIT'] ?? NOTES);
const SEND = Number(process.env['E2E_SEND'] ?? NOTES);
const ONES = Number(process.env['E2E_ONES'] ?? 0);

const PROFILE = process.env['E2E_PROFILE'];
const launch = { channel: 'chrome', headless: true };
const context = EXTENSION !== undefined
  // E2E_CHROMIUM: a Chromium or Chrome for Testing binary, if Playwright's own is not installed.
  ? await chromium.launchPersistentContext(PROFILE ?? '', {
    ...(process.env['E2E_CHROMIUM'] ? { executablePath: process.env['E2E_CHROMIUM'] } : { channel: 'chromium' }),
    headless: true, args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  })
  : PROFILE === undefined
    ? await chromium.launch(launch).then((b: any) => b.newContext())
    : await chromium.launchPersistentContext(PROFILE, launch);
if (EXTENSION !== undefined) {
  // The extension's id is in its service worker's URL.
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  APP_URL = `chrome-extension://${new URL(worker.url()).host}/app.html`;
}
const page = await context.newPage();

if (WALLET_KEY === undefined) {
  // Note #2 by default; #1 was spent by chain/e2e-ring-payment.ts. Override with NOTE_INDEX.
  const secretHex = process.env['RING_DECOY_SECRETS']!.split(',')[Number(process.env['NOTE_INDEX'] ?? 1)]! as `0x${string}`;
  const commitment = deriveCommitment(fromHex(secretHex), scope) as unknown as `0x${string}`;
  const [log] = await pc.getLogs({ address: ring8.address, event: parseAbiItem('event Deposited(bytes32 indexed commitment, uint256 index)'), args: { commitment }, fromBlock: BigInt(ring8.deployedAtBlock), toBlock: await pc.getBlockNumber() });
  if (!log) throw new Error('note #2 is not a deposit in the ring pool');
  const note = {
    id: 'seeded-2', scope: { chainId: `${deployment.network.chainId}n`, pool: ring8.address, denomination: ring8.denomination },
    commitment, secret: secretHex, state: 'AVAILABLE', depositTx: log.transactionHash, createdAtBlock: `${log.blockNumber}n`, reservation: null,
  };
  await page.addInitScript(([n]) => {
    if (!localStorage.getItem('opaque:notes:v1')) localStorage.setItem('opaque:notes:v1', JSON.stringify({ [n.id]: n }));
  }, [note]);
}
const signer = WALLET_KEY === undefined ? undefined : createWalletClient({ account: privateKeyToAccount(WALLET_KEY), chain: ARC_TESTNET, transport: http() });
// Each eth_sendTransaction is one confirmation a real wallet would pop up.
let confirmations = 0;
// The extension's page has no wallet: MetaMask does not inject into extensions.
if (signer !== undefined && EXTENSION === undefined) {
  const account = signer.account;
  await page.exposeFunction('__e2eWallet', async (method: string, params: readonly any[]) => {
    switch (method) {
      case 'eth_accounts': case 'eth_requestAccounts': return [account.address];
      case 'eth_chainId': return `0x${ARC_TESTNET.id.toString(16)}`;
      case 'eth_sendTransaction': {
        confirmations++;
        const t = params[0];
        return signer.sendTransaction({ to: t.to, data: t.data, ...(t.value ? { value: BigInt(t.value) } : {}) });
      }
      default: return pc.request({ method, params } as never);
    }
  });
  await page.addInitScript(() => {
    (window as any).ethereum = {
      request: ({ method, params }: { method: string; params?: unknown[] }) => (window as any).__e2eWallet(method, params ?? []),
      on() {}, removeListener() {},
    };
  });
}
const errors: string[] = [];
page.on('pageerror', (e: Error) => errors.push(e.message));
// What the page itself sends, to check nothing that names the wallet goes direct.
const direct: { url: string; body: string }[] = [];
page.on('request', (r: { url(): string; postData(): string | null }) => { if (!r.url().includes('railway.app') && !r.url().includes('opaque.credit') && !r.url().includes('127.0.0.1') && !r.url().startsWith('chrome-extension://')) direct.push({ url: r.url(), body: r.postData() ?? '' }); });
page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', (r: { status(): number; url(): string; request(): { method(): string } }) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
const t0 = Date.now();
const step = (s: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${s}\n`);

await page.goto(APP_URL);
await page.waitForFunction(() => !/Loading/.test(document.getElementById('note-count')?.textContent ?? 'Loading')
  || document.getElementById('boot-error')?.hidden === false, null, { timeout: 120_000 });
if (await page.isVisible('#boot-error')) throw new Error(`the page could not start: ${await page.textContent('#boot-error')}`);
step(`private balance: ${await page.textContent('#balance')} USDC in ${await page.textContent('#note-count')}`);

if (signer !== undefined && process.env['E2E_PQ'] === '1') {
  await page.click('#account-button');
  await page.waitForFunction(() => /Active|Not on chain/.test(document.getElementById('account-state')?.textContent ?? ''), null, { timeout: 60_000 });
  const address = (await page.textContent('#account-address')) as `0x${string}`;
  if ((await pc.getBalance({ address })) < parseEther(String(DEPOSIT + 0.1))) {
    const hash = await signer.sendTransaction({ to: address, value: parseEther(String(DEPOSIT + 0.2)) });
    await pc.waitForTransactionReceipt({ hash });
  }
  step(`PQ account ${address}: ${await page.textContent('#account-state')}`);
  await page.keyboard.press('Escape');
}

if (signer !== undefined && ONES > 0) {
  await page.waitForFunction(() => /^0x[0-9a-f]{40}$/.test(document.getElementById('account-address')?.textContent ?? ''), null, { timeout: 60_000 });
  const address = (await page.textContent('#account-address')) as `0x${string}`;
  const balance = Number(await page.textContent('#balance'));
  if ((await pc.getBalance({ address })) < parseEther(String(ONES + 0.2))) {
    await pc.waitForTransactionReceipt({ hash: await signer.sendTransaction({ to: address, value: parseEther(String(ONES + 0.25)) }) });
  }
  // Exposed once the page has finished starting, after its first reads.
  await page.waitForFunction(() => (window as any).opaque !== undefined, null, { timeout: 60_000 });
  await page.evaluate(async (n: number) => {
    const rt = (window as any).opaque;
    await rt.app.depositNotes([{ scope: rt.scopes.find((s: any) => s.denomination === 1_000_000), count: n }]);
  }, ONES);
  await page.click('#refresh-balance');
  await page.waitForFunction((b: string) => document.getElementById('balance')?.textContent === b, `${balance + ONES}.00`, { timeout: 120_000 });
  step(`${ONES} one-USDC notes in one deposit: ${await page.textContent('#balance')} USDC in ${await page.textContent('#note-count')}`);
}

if (signer !== undefined && (await page.textContent('#balance')) === '0.00') {
  if (EXTENSION !== undefined) {
    // What a user does from any wallet or exchange: USDC to the Receive address.
    await page.waitForFunction(() => /^0x[0-9a-f]{40}$/.test(document.getElementById('account-address')?.textContent ?? ''), null, { timeout: 60_000 });
    const address = (await page.textContent('#account-address')) as `0x${string}`;
    if ((await pc.getBalance({ address })) < parseEther(String(DEPOSIT + 0.2))) {
      await pc.waitForTransactionReceipt({ hash: await signer.sendTransaction({ to: address, value: parseEther(String(DEPOSIT + 0.25)) }) });
    }
    step(`funded ${address} from outside the wallet: ${Number(await pc.getBalance({ address })) / 1e18} USDC`);
  }
  await page.fill('#deposit-count', String(DEPOSIT));
  step(`deposit preview: ${await page.textContent('#deposit-split')}`);
  const before = confirmations;
  await page.click('#deposit');
  await page.waitForFunction(() => /Deposited|Deposit sent|Deposit failed/.test(document.getElementById('deposit-status')?.textContent ?? ''), null, { timeout: 300_000 });
  step(`deposit (through the page's own button): ${await page.textContent('#deposit-status')} · funding-wallet confirmations: ${confirmations - before}`);
  await page.waitForFunction((n: number) => document.getElementById('balance')?.textContent === `${n}.00`, DEPOSIT, { timeout: 120_000 });
  step(`private balance: ${await page.textContent('#balance')} USDC in ${await page.textContent('#note-count')}`);
}

if (signer !== undefined && process.env['E2E_PQ'] === '1') {
  const address = (await page.textContent('#account-address')) as string;
  // Rotate: the funding wallet pays; the key signs its own successor in.
  await page.click('#rotate');
  await page.waitForFunction(() => /Rotated|Could not rotate/.test(document.getElementById('rotate-status')?.textContent ?? ''), null, { timeout: 240_000 });
  step(`rotate: ${await page.textContent('#rotate-status')} · signatures ${await page.textContent('#sig-left')} ${await page.textContent('#sig-max')}`);

  // Withdraw what the deposit left, to the funding wallet.
  await page.click('#account-button');
  await page.waitForFunction(() => !document.getElementById('withdraw-box')?.hidden, null, { timeout: 60_000 });
  await page.click('#withdraw');
  await page.waitForFunction(() => /Withdrawn|Could not withdraw/.test(document.getElementById('wallet-status')?.textContent ?? ''), null, { timeout: 240_000 });
  step(`withdraw: ${await page.textContent('#wallet-status')}`);

  // Backup, then restore into a browser that has never seen this account.
  await page.fill('#backup-pass', 'correct horse battery staple');
  // The file is taken as the button hands it to the download link: Chrome under
  // Playwright completes only the first download a persistent profile ever makes.
  await page.evaluate(() => {
    const make = URL.createObjectURL;
    URL.createObjectURL = (blob: Blob) => { (window as any).__backup = blob; return make(blob); };
  });
  await page.click('#backup-export');
  await page.waitForFunction(() => (window as any).__backup !== undefined, null, { timeout: 60_000 });
  const file = `${process.env['TMPDIR'] ?? '/tmp'}/opaque-e2e-backup.json`;
  writeFileSync(file, await page.evaluate(() => (window as any).__backup.text()));
  await page.keyboard.press('Escape');
  const fresh = await chromium.launch(launch).then((b: any) => b.newContext());
  const other = await fresh.newPage();
  other.on('dialog', (d: { accept(): Promise<void> }) => void d.accept());
  await other.goto(APP_URL);
  await other.waitForFunction(() => /0x[0-9a-f]{40}/.test(document.getElementById('account-address')?.textContent ?? ''), null, { timeout: 120_000 });
  const before = await other.textContent('#account-address');
  await other.click('#account-button');
  await other.fill('#backup-pass', 'correct horse battery staple');
  await other.setInputFiles('#backup-file', file);
  await other.waitForFunction((a: string) => document.getElementById('account-address')?.textContent === a, address, { timeout: 180_000 });
  step(`restore: a fresh browser's account ${before?.slice(0, 10)}… became ${address.slice(0, 10)}… (${await other.textContent('#sig-left')} ${await other.textContent('#sig-max')} signatures)`);
  await fresh.close();
}

await page.click('#tab-ring');
await page.waitForFunction(() => /USDC/.test(document.getElementById('pool-size')?.textContent ?? ''), null, { timeout: 90_000 });
step(`ring view (through the mesh): ${await page.textContent('#pool-size')} · freshness ${await page.textContent('#freshness-now')} · path ${(await page.textContent('#hops'))?.replace(/\s+/g, ' ')}`);

await page.click('#tab-send');
await page.fill('#recipient', RECIPIENT);
if (process.env['E2E_REFUSE'] !== undefined) {
  await page.fill('#send-amount', process.env['E2E_REFUSE']);
  await page.click('#arm');
  await page.waitForFunction(() => /can't make/.test(document.getElementById('send-status')?.textContent ?? ''), null, { timeout: 120_000 });
  step(`refused, as it should be: ${await page.textContent('#send-status')}`);
  await page.fill('#recipient', RECIPIENT);
}
await page.fill('#send-amount', String(SEND));
// The page adds its rows and refreshes its balance only after the last
// payment is out, while its own poll may render earlier ones: wait for both.
const rowsBefore = await page.locator('#intent-list .intent').count();
const balanceAfter = `${Number(await page.textContent('#balance')) - SEND}.00`;
await page.click('#arm');
const sendAt = Date.now();
await page.waitForFunction(() => /Sent across the mesh|payments across the mesh|Not sent|failed|can't make/.test(document.getElementById('send-status')?.textContent ?? ''), null, { timeout: 420_000 });
const sendStatus = (await page.textContent('#send-status')) ?? '';
step(`send (${((Date.now() - sendAt) / 1000).toFixed(1)}s): ${sendStatus}`);
if (!/across the mesh\./.test(sendStatus)) throw new Error('the send did not go out');
// One payment per note: "Sent 4 USDC as 4 payments across the mesh", or one.
const PAYMENTS = Number(/as (\d+) payments/.exec(sendStatus)?.[1] ?? 1);

// One row per send, newest first: it is settled when it links every settlement.
await page.waitForFunction(([n, before]: number[]) => {
  const rows = document.querySelectorAll('#intent-list .intent');
  return rows.length >= before! + 1 && rows[0]!.querySelectorAll('a').length === n;
}, [PAYMENTS, rowsBefore], { timeout: 420_000 });
await page.waitForFunction((b: string) => document.getElementById('balance')?.textContent === b, balanceAfter, { timeout: 60_000 });
const txs: string[] = await page.$$eval('#intent-list .intent:first-child a', (links: Element[]) => links.map((a) => a.getAttribute('href') ?? ''));
step(`activity (status through the mesh, all settled ${((Date.now() - sendAt) / 1000).toFixed(1)}s after Send): one row, ${await page.textContent('#intent-list .intent-amt')} ${await page.textContent('#intent-list .intent-state')}  ${txs.join('  ')}`);
step(`private balance after: ${await page.textContent('#balance')} USDC`);
if (errors.length) step(`page errors: ${errors.slice(0, 6).join(' | ')}`);
// The page talks to its own origin and the stack, and to nobody else: its reads
// cross the mesh, its funding wallet's go through the wallet's provider, and
// its fonts are its own. Not an RPC, a bundler, the subgraph, or a font CDN.
step(`requests from the page to anyone but its origin and the stack: ${direct.length}`);
for (const l of direct.slice(0, 3)) step(`  leak: ${l.url} ${l.body.slice(0, 160)}`);
if (direct.length > 0) process.exitCode = 1;
await context.close();
await context.browser()?.close();
process.stdout.write(`TX ${txs.map((t) => t.split('/').pop()).join(' ')}\n`);
