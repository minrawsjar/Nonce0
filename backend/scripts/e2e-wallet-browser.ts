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
//
// Uses the Playwright already installed for the wallet SDK's browser test, and
// the machine's own Chrome (channel: 'chrome') rather than a downloaded build.
//
// Outside backend's typecheck on purpose: the waitForFunction callbacks run IN
// THE BROWSER and read `document`, and giving backend the DOM lib to allow them
// would let server code touch `window` and `document` too.
import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { createPublicClient, createWalletClient, http, parseAbiItem, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { asChainId, fromHex } from '@opaque/protocol-types/codecs.js';
import { deployment, poolFor } from '../../deployments/index.ts';
import { deriveCommitment } from '../zk/spend.ts';
import { ARC_TESTNET } from '../chain/pool.ts';

const ring8 = poolFor(1_000_000, 'RING_8');
const scope = { chainId: asChainId(BigInt(deployment.network.chainId)), pool: ring8.address, denomination: ring8.denomination } as never;
const APP_URL = process.env['APP_URL'] ?? 'http://127.0.0.1:5173/app.html';
const WALLET_KEY = process.env['E2E_WALLET_KEY'] as `0x${string}` | undefined;
const pc = createPublicClient({ chain: ARC_TESTNET, transport: http() });
const RECIPIENT = deployment.accounts.attester;

const PROFILE = process.env['E2E_PROFILE'];
const launch = { channel: 'chrome', headless: true };
const context = PROFILE === undefined
  ? await chromium.launch(launch).then((b: any) => b.newContext())
  : await chromium.launchPersistentContext(PROFILE, launch);
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
if (signer !== undefined) {
  const account = signer.account;
  await page.exposeFunction('__e2eWallet', async (method: string, params: readonly any[]) => {
    switch (method) {
      case 'eth_accounts': case 'eth_requestAccounts': return [account.address];
      case 'eth_chainId': return `0x${ARC_TESTNET.id.toString(16)}`;
      case 'eth_sendTransaction': {
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
// Drop polls 404 until the answer lands — deliberately: a relay that said
// "exists but not ready" would be an oracle for which drops are live.
page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });
const t0 = Date.now();
const step = (s: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${s}\n`);

await page.goto(APP_URL);
await page.waitForFunction(() => /RING_8/.test(document.getElementById('caps')?.textContent ?? ''), null, { timeout: 60_000 });
step(`capabilities (read from the pool on chain): ${await page.textContent('#caps')}`);
step(`private balance: ${await page.textContent('#balance')} USDC in ${await page.textContent('#note-count')}`);

if (signer !== undefined && process.env['E2E_PQ'] === '1') {
  await page.click('#account-button');
  await page.waitForFunction(() => /Active|Not activated/.test(document.getElementById('account-state')?.textContent ?? ''), null, { timeout: 60_000 });
  if (/Not activated/.test((await page.textContent('#account-state')) ?? '')) {
    await page.click('#activate');
    await page.waitForFunction(() => /Activated|Could not activate/.test(document.getElementById('wallet-status')?.textContent ?? ''), null, { timeout: 180_000 });
    step(`activate (funding wallet pays PQAccountFactory): ${await page.textContent('#wallet-status')}`);
  }
  const address = (await page.textContent('#account-address')) as `0x${string}`;
  if ((await pc.getBalance({ address })) < parseEther('1.1')) {
    const hash = await signer.sendTransaction({ to: address, value: parseEther('1.2') });
    await pc.waitForTransactionReceipt({ hash });
  }
  step(`PQ account ${address}: ${await page.textContent('#account-state')}`);
  await page.keyboard.press('Escape');
}

if (signer !== undefined && (await page.textContent('#balance')) === '0.00') {
  await page.click('#deposit');
  await page.waitForFunction(() => /Deposited|Deposit sent|Deposit failed/.test(document.getElementById('deposit-status')?.textContent ?? ''), null, { timeout: 300_000 });
  step(`deposit (through the page's own button): ${await page.textContent('#deposit-status')}`);
  await page.waitForFunction(() => document.getElementById('balance')?.textContent === '1.00', null, { timeout: 120_000 });
  step(`private balance: ${await page.textContent('#balance')} USDC in ${await page.textContent('#note-count')}`);
}

await page.click('#tab-ring');
await page.waitForFunction(() => /deposits/.test(document.getElementById('pool-size')?.textContent ?? ''), null, { timeout: 90_000 });
step(`ring view (through the mesh): ${await page.textContent('#pool-size')} · freshness ${await page.textContent('#freshness-now')} · path ${(await page.textContent('#hops'))?.replace(/\s+/g, ' ')}`);

await page.click('#tab-send');
await page.fill('#recipient', RECIPIENT);
await page.fill('#freshness', '50');
await page.click('#arm');
await page.waitForFunction(() => /Sent across the mesh|Not sent/.test(document.getElementById('send-status')?.textContent ?? ''), null, { timeout: 420_000 });
step(`send: ${await page.textContent('#send-status')}`);

await page.waitForFunction(() => /view settlement/.test(document.getElementById('intent-list')?.textContent ?? ''), null, { timeout: 420_000 });
const tx = await page.getAttribute('#intent-list a', 'href');
step(`activity (status through the mesh): ${(await page.textContent('#intent-list .intent-state'))}  ${tx}`);
step(`private balance after: ${await page.textContent('#balance')} USDC`);
if (errors.length) step(`page errors: ${errors.slice(0, 3).join(' | ')}`);
await context.close();
await context.browser()?.close();
process.stdout.write(`TX ${tx?.split('/').pop()}\n`);
