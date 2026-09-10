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
// Uses the Playwright already installed for the wallet SDK's browser test, and
// the machine's own Chrome (channel: 'chrome') rather than a downloaded build.
//
// Outside backend's typecheck on purpose: the waitForFunction callbacks run IN
// THE BROWSER and read `document`, and giving backend the DOM lib to allow them
// would let server code touch `window` and `document` too.
import { chromium } from '../../packages/pq-wallet/node_modules/playwright/index.mjs';
import { createPublicClient, http, parseAbiItem } from 'viem';
import { asChainId, fromHex } from '@opaque/protocol-types/codecs.js';
import { deployment, poolFor } from '../../deployments/index.ts';
import { deriveCommitment } from '../zk/spend.ts';
import { ARC_TESTNET } from '../chain/pool.ts';

const ring8 = poolFor(1_000_000, 'RING_8');
const scope = { chainId: asChainId(BigInt(deployment.network.chainId)), pool: ring8.address, denomination: ring8.denomination } as never;
// Note #2 by default; #1 was spent by chain/e2e-ring-payment.ts. Override with NOTE_INDEX.
const secretHex = process.env['RING_DECOY_SECRETS']!.split(',')[Number(process.env['NOTE_INDEX'] ?? 1)]! as `0x${string}`;
const commitment = deriveCommitment(fromHex(secretHex), scope) as unknown as `0x${string}`;
const pc = createPublicClient({ chain: ARC_TESTNET, transport: http() });
const [log] = await pc.getLogs({ address: ring8.address, event: parseAbiItem('event Deposited(bytes32 indexed commitment, uint256 index)'), args: { commitment }, fromBlock: BigInt(ring8.deployedAtBlock), toBlock: await pc.getBlockNumber() });
if (!log) throw new Error('note #2 is not a deposit in the ring pool');

const note = {
  id: 'seeded-2', scope: { chainId: `${deployment.network.chainId}n`, pool: ring8.address, denomination: ring8.denomination },
  commitment, secret: secretHex, state: 'AVAILABLE', depositTx: log.transactionHash, createdAtBlock: `${log.blockNumber}n`, reservation: null,
};
const RECIPIENT = deployment.accounts.attester;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', (e: Error) => errors.push(e.message));
// Drop polls 404 until the answer lands — deliberately: a relay that said
// "exists but not ready" would be an oracle for which drops are live.
page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });
await page.addInitScript(([n]) => {
  if (!localStorage.getItem('opaque:notes:v1')) localStorage.setItem('opaque:notes:v1', JSON.stringify({ [n.id]: n }));
}, [note]);

const t0 = Date.now();
const step = (s: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${s}\n`);

await page.goto('http://127.0.0.1:5173/app.html');
await page.waitForFunction(() => /RING_8/.test(document.getElementById('caps')?.textContent ?? ''), null, { timeout: 60_000 });
step(`capabilities (read from the pool on chain): ${await page.textContent('#caps')}`);
step(`private balance: ${await page.textContent('#balance')} USDC in ${await page.textContent('#note-count')}`);

await page.click('#tab-ring');
await page.waitForFunction(() => /deposits/.test(document.getElementById('pool-size')?.textContent ?? ''), null, { timeout: 90_000 });
step(`ring view (through the mesh): ${await page.textContent('#pool-size')} · freshness ${await page.textContent('#freshness-now')} · path ${(await page.textContent('#hops'))?.replace(/\s+/g, ' ')}`);

await page.click('#tab-send');
await page.fill('#recipient', RECIPIENT);
await page.fill('#freshness', '50');
await page.click('#arm');
await page.waitForFunction(() => /Sent across the mesh|Not sent/.test(document.getElementById('send-status')?.textContent ?? ''), null, { timeout: 180_000 });
step(`send: ${await page.textContent('#send-status')}`);

await page.waitForFunction(() => /view settlement/.test(document.getElementById('intent-list')?.textContent ?? ''), null, { timeout: 180_000 });
const tx = await page.getAttribute('#intent-list a', 'href');
step(`activity (status through the mesh): ${(await page.textContent('#intent-list .intent-state'))}  ${tx}`);
step(`private balance after: ${await page.textContent('#balance')} USDC`);
if (errors.length) step(`page errors: ${errors.slice(0, 3).join(' | ')}`);
await browser.close();
process.stdout.write(`TX ${tx?.split('/').pop()}\n`);
