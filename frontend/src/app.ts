// opaque wallet — the UI, wired to the real protocol.
//
// Two rules kept strictly, because these exact bytes ship as the extension
// popup as well as the hosted page:
//
//   * every handler is attached with addEventListener — Manifest V3 forbids
//     inline handlers, so app.html has none to attach;
//   * nothing is eval'd or built from a string.
//
// Everything below reads real state: the note balance from this browser's
// vault, the ring and privacy score through the mesh, the path from the
// verified relay directory, payment status through the mesh. Nothing in the
// page is simulated.

import type { IntentStatus, NoteSummary, PrivacyScore, StatusHandle, UnixSeconds } from '@opaque/protocol-types';

import { makeAmount, MAX_NOTES_PER_DEPOSIT } from './lib/protocol/index.js';
import { paymentDeadline } from './lib/payment-deadline.js';
import { runPaymentLanes } from './lib/payment-lanes.js';
import { startWallet, type WalletRuntime } from './lib/runtime.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_SIZE = 8;

/** Throws rather than returning null: a missing id is a broken build, not a runtime case. */
function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`app.html is missing #${id}`);
  return node as T;
}

// The wallet cannot start without the runtime, and a page that silently shows
// zeros would read as an empty wallet rather than a failure. This bar stays
// hidden until there is something the user has to know about.
function showBootError(message: string): void {
  const bar = el('boot-error');
  bar.textContent = message;
  bar.hidden = false;
}

let rt: WalletRuntime;
/** USDC at the account's own address: sent to it, not yet deposited as notes. */
let accountUsdc = 0;
let notes: readonly NoteSummary[] = [];
/** Deposits in each ring pool, by pool address, as last read through the mesh. */
const poolSizes = new Map<string, number>();
let hops: readonly string[] = [];
let opaqueAddress = '';
let fundingAddress = '';

interface BrowserProvider {
  request(input: { method: string; params?: readonly unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
}

const provider = (): BrowserProvider | undefined =>
  (globalThis as { ethereum?: BrowserProvider }).ethereum;
const ARC_CHAIN_ID = 5_042_002;
const ARC_HEX = `0x${ARC_CHAIN_ID.toString(16)}`;
const ARC_EXPLORER = 'https://testnet.arcscan.app';
/**
 * USDC a deposit keeps in the account for its own gas. ponytail: a flat
 * margin over the ~0.03 a one-note operation costs; what it leaves over stays
 * in the account and pays for the next one.
 */
const DEPOSIT_GAS_USDC = 0.2;
/** A payment waiting for privacy settles when the mesh reaches this score. */
const MIN_FRESHNESS = 70;
/**
 * Independent notes share neither nullifier nor ring proof. Four lanes keep a
 * four-note payment responsive for hackathon demos; every lane remains an
 * independent, all-settled operation.
 */
const PAYMENT_LANES = 4;
const shortAddress = (value: string) => value ? `${value.slice(0, 6)}…${value.slice(-4)}` : 'Not connected';
const isRejected = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 4001;

function setStatus(id: string, message: string): void { el(id).textContent = message; }

async function copyText(value: string, button?: HTMLButtonElement): Promise<void> {
  if (!value) return;
  await navigator.clipboard.writeText(value);
  if (button) {
    const old = button.textContent ?? 'Copy address';
    button.textContent = 'Copied';
    window.setTimeout(() => { button.textContent = old; }, 1_500);
  }
}

async function readFundingWallet(): Promise<void> {
  const injected = provider();
  if (!injected) {
    // Not needed: the account is funded by sending USDC to its address.
    el('funding-state').textContent = 'None — send USDC to your address from any wallet';
    el('connect-wallet').hidden = true;
    el('network-label').textContent = 'Arc testnet';
    return;
  }
  const accounts = await injected.request({ method: 'eth_accounts' }) as string[];
  fundingAddress = accounts[0] ?? '';
  el('funding-state').textContent = shortAddress(fundingAddress);
  const chainId = await injected.request({ method: 'eth_chainId' }) as string;
  const correct = Number.parseInt(chainId, 16) === ARC_CHAIN_ID;
  el('network-label').textContent = correct ? 'Arc testnet' : 'Switch to Arc';
  // The dot that used to carry this is gone; the button itself says it now.
  el('network-button').classList.toggle('wrong', !correct);
}

async function connectFundingWallet(): Promise<boolean> {
  const injected = provider();
  if (!injected) {
    setStatus('wallet-status', 'Install MetaMask or another EIP-1193 wallet to fund private notes.');
    window.open('https://metamask.io/download/', '_blank', 'noopener');
    return false;
  }
  const button = el<HTMLButtonElement>('connect-wallet');
  button.disabled = true;
  setStatus('wallet-status', 'Waiting for your wallet…');
  try {
    const accounts = await injected.request({ method: 'eth_requestAccounts' }) as string[];
    fundingAddress = accounts[0] ?? '';
    const chainId = await injected.request({ method: 'eth_chainId' }) as string;
    if (Number.parseInt(chainId, 16) !== ARC_CHAIN_ID) {
      try {
        await injected.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ARC_HEX }] });
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 4902) {
          await injected.request({ method: 'wallet_addEthereumChain', params: [{ chainId: ARC_HEX, chainName: 'Arc Testnet', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: ['https://rpc.testnet.arc.io'], blockExplorerUrls: [ARC_EXPLORER] }] });
        } else { throw error; }
      }
    }
    await readFundingWallet();
    button.textContent = 'Funding wallet connected';
    setStatus('wallet-status', `Connected ${shortAddress(fundingAddress)} on Arc testnet.`);
    return true;
  } catch (error) {
    if (isRejected(error)) setStatus('wallet-status', '');
    else setStatus('wallet-status', `Could not connect: ${(error as Error).message}`);
    return false;
  } finally { button.disabled = false; }
}

// ── payments this browser has sent ────────────────────────────────────────
//
// Kept locally so Activity survives a reload. A handle and a recipient only —
// no note secret, no proof. The handle is a capability: whoever holds it can
// read this payment's status, so it stays on this device.

interface SentPayment {
  readonly handle: string;
  readonly recipient: string;
  readonly at: number;
  /** The send it belongs to: one Activity row per send, however many notes. */
  readonly group?: string;
  /** The note's value; absent on payments from when every note was 1 USDC. */
  readonly usdc?: number;
  state?: IntentStatus['state'];
  txHash?: string;
}
const SENT_KEY = 'opaque:sent:v1';
const sent: SentPayment[] = (() => {
  try { return JSON.parse(localStorage.getItem(SENT_KEY) ?? '[]') as SentPayment[]; } catch { return []; }
})();
const saveSent = () => localStorage.setItem(SENT_KEY, JSON.stringify(sent));
const TERMINAL = new Set(['SETTLED', 'FAILED']);

// ── the PQ account key ────────────────────────────────────────────────────

async function renderBudget(): Promise<void> {
  const state = await rt.app.walletState();
  opaqueAddress = state.accountAddress as string;
  el('account-short').textContent = shortAddress(opaqueAddress);
  el('account-address').textContent = opaqueAddress;
  el('receive-address').textContent = opaqueAddress;
  el<HTMLAnchorElement>('open-explorer').href = `${ARC_EXPLORER}/address/${opaqueAddress}`;
  const max = Number(state.maxUses);
  const left = Math.max(0, max - Number(state.localSigningReservations));
  const low = left <= Math.ceil(max / 4);

  el('sig-left').textContent = String(left);
  el('sig-max').textContent = `of ${max}`;
  // How far through the key we are, 0 → 1. The panel draws a fracture across
  // itself from this: the landing page's argument is that everything breaks
  // eventually, and for a few-time key that is not a metaphor — it is the
  // number above. Spent budget is literally how far the crack has got.
  const spent = max === 0 ? 1 : (max - left) / max;
  el('budget').style.setProperty('--spent', spent.toFixed(3));

  // One cell per signature, not a percentage bar. With a few-time scheme the
  // count is small enough to be countable, and "2 left" versus "3 left"
  // matters far more than twelve percent of a bar does.
  const meter = el('meter');
  meter.classList.toggle('low', low);
  meter.replaceChildren(...Array.from({ length: max }, (_, i) => {
    const cell = document.createElement('i');
    if (i < left) cell.className = 'on';
    return cell;
  }));

  const funds = await rt.accountFunds(opaqueAddress as `0x${string}`).catch(() => undefined);
  const balance = funds === undefined ? '' : ` · ${funds.usdc.toFixed(2)} USDC`;
  if (funds !== undefined) {
    accountUsdc = funds.usdc;
    // USDC sent to the address from outside: offer it, and drop a stale
    // "send USDC first" from before it arrived.
    const ready = Math.floor(accountUsdc - DEPOSIT_GAS_USDC);
    const field = el<HTMLInputElement>('deposit-count');
    if (ready >= 1 && field.value.trim() === '') { field.value = String(ready); renderDepositSplit(); }
    if (ready >= 1 && /^Send /.test(el('deposit-status').textContent ?? '')) el('deposit-status').textContent = '';
    renderBalance();
  }
  el('account-state').textContent = state.active
    ? `Active${balance} · deposits are signed by its PQ key`
    : `Not on chain yet${balance} · your first deposit sets it up`;
  el('withdraw-box').hidden = (funds?.usdc ?? 0) === 0;
  // Two signatures are held back for exactly this, so a key can always rotate.
  const rotate = el<HTMLButtonElement>('rotate');
  rotate.hidden = !state.active;
  rotate.textContent = low ? 'Rotate key now: few signatures left' : 'Rotate key';
}

async function onRotate(): Promise<void> {
  if (!rt.hasWallet) {
    setStatus('rotate-status', 'Rotating is still paid by a funding wallet, which this browser has none of. Back up, restore on opaque.credit with MetaMask, rotate there, and restore back.');
    return;
  }
  if (!await connectFundingWallet()) return;
  const button = el<HTMLButtonElement>('rotate');
  button.disabled = true;
  setStatus('rotate-status', 'Signing the rotation with the current key; your funding wallet submits it…');
  try {
    const before = (await rt.app.walletState()).pkCommitment;
    await rt.app.rotateWallet();
    await settle(async () => (await rt.app.walletState()).pkCommitment !== before);
    setStatus('rotate-status', 'Rotated. The next key is active, with a fresh budget, and another is committed behind it.');
    await renderBudget();
  } catch (error) {
    setStatus('rotate-status', isRejected(error) ? '' : `Could not rotate: ${(error as Error).message}`);
  } finally { button.disabled = false; }
}

async function onWithdraw(): Promise<void> {
  let to = el<HTMLInputElement>('withdraw-to').value.trim().toLowerCase();
  if (to === '') {
    if (!await connectFundingWallet()) return;
    to = fundingAddress.toLowerCase();
  }
  if (!/^0x[0-9a-f]{40}$/.test(to)) { setStatus('wallet-status', 'Enter an Arc address to withdraw to.'); return; }
  const button = el<HTMLButtonElement>('withdraw');
  button.disabled = true;
  setStatus('wallet-status', 'Signing the withdrawal with your PQ key; it goes to the bundler through the mesh…');
  try {
    const tx = await rt.withdraw(opaqueAddress as `0x${string}`, to as `0x${string}`);
    setStatus('wallet-status', `Withdrawn to ${shortAddress(to)} in ${shortAddress(tx)}.`);
    await renderBudget();
  } catch (error) {
    setStatus('wallet-status', `Could not withdraw: ${(error as Error).message}`);
  } finally { button.disabled = false; }
}

async function onBackupExport(): Promise<void> {
  const pass = el<HTMLInputElement>('backup-pass');
  try {
    const url = URL.createObjectURL(await rt.exportBackup(pass.value));
    const link = document.createElement('a');
    link.href = url;
    link.download = `opaque-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    pass.value = '';
    setStatus('backup-status', 'Saved. Keep the file and the passphrase in different places.');
  } catch (error) {
    setStatus('backup-status', (error as Error).message);
  }
}

async function onBackupImport(file: File): Promise<void> {
  // A key used from two browsers can sign one index twice; restore replaces, it does not copy.
  if (!window.confirm('Restore switches this browser to the account in the backup. The current account stays in storage but is no longer shown. Use a backup on one device at a time. Continue?')) return;
  try {
    const added = await rt.restoreBackup(file, el<HTMLInputElement>('backup-pass').value);
    setStatus('backup-status', `Restored, with ${added} note${added === 1 ? '' : 's'} new to this browser. Reloading…`);
    window.setTimeout(() => window.location.reload(), 800);
  } catch (error) {
    setStatus('backup-status', `Could not restore: ${(error as Error).message}`);
  }
}

/**
 * Mined is not yet visible: the exit reads a load-balanced RPC whose next
 * answer can be a block behind the one that mined it. Look a few times.
 */
async function settle(done: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 10 && !await done().catch(() => false); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

// ── notes ─────────────────────────────────────────────────────────────────
//
// A note is 1, 2, 5, 10, 20, 50 or 100 USDC, each in its own pool (§6.6: a ring is formed
// only among notes of one size). A pool fills from anyone's deposits, and a
// note in it can be spent once it holds a ring's worth.

const usdcOf = (n: NoteSummary): number => Number(n.scope.denomination) / 1e6;
// Deposits are whole USDC into fixed-denomination pools. The field is a text input rather than
// type=number because a number input still accepts "1.5", "-3" and "1e5",
// and reports them as an empty value — which reads as 0, not as a mistake.
const MAX_AMOUNT_DIGITS = 6;
/** The whole USDC in an amount field, or undefined when it is not one ≥ 1. */
function wholeAmount(id: string): number | undefined {
  const raw = el<HTMLInputElement>(id).value.trim();
  if (!/^\d+$/.test(raw)) return undefined;
  const amount = Number(raw);
  return Number.isSafeInteger(amount) && amount >= 1 ? amount : undefined;
}
const depositAmount = (): number | undefined => wholeAmount('deposit-count');

function localDateTime(ms: number): string {
  const local = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function syncPrivacyWait(): void {
  const wait = el<HTMLInputElement>('wait-for-privacy').checked;
  const deadline = el<HTMLInputElement>('privacy-deadline');
  el('privacy-deadline-wrap').hidden = !wait;
  el('immediate-settlement').hidden = wait;
  deadline.disabled = !wait;
  deadline.required = wait;
  if (wait && deadline.value === '') deadline.value = localDateTime(Date.now() + 3_600_000);
}

function requestedDeadline(): UnixSeconds {
  const waitForPrivacy = el<HTMLInputElement>('wait-for-privacy').checked;
  const nowMs = Date.now();
  if (!waitForPrivacy) return paymentDeadline({ waitForPrivacy, nowMs }) as UnixSeconds;
  return paymentDeadline({ waitForPrivacy, selectedMs: el<HTMLInputElement>('privacy-deadline').valueAsNumber, nowMs }) as UnixSeconds;
}

/**
 * Keeps an amount field to digits only. The fields are type=text: a number
 * input still accepts "1.5", "-3" and "1e5", reports them as an empty value —
 * which reads as 0, not as a mistake — and paints spinner arrows that have no
 * place on an amount.
 */
function onlyWholeAmounts(input: HTMLInputElement, after: () => void): void {
  input.addEventListener('input', () => {
    // Strip as it arrives, typed or pasted; leading zeros go too, so "007"
    // does not read as an amount of its own.
    const cleaned = input.value.replace(/\D+/g, '').replace(/^0+(?=\d)/, '').slice(0, MAX_AMOUNT_DIGITS);
    if (cleaned !== input.value) {
      // Keep the caret where the user was typing, not thrown to the end.
      const at = input.selectionStart ?? cleaned.length;
      const removed = input.value.length - cleaned.length;
      input.value = cleaned;
      const to = Math.max(0, at - removed);
      input.setSelectionRange(to, to);
    }
    after();
  });
  // An empty or 0 field left behind on blur returns to the smallest amount.
  input.addEventListener('blur', () => {
    if (wholeAmount(input.id) === undefined) { input.value = '1'; after(); }
  });
}

const denominations = (): number[] => rt.scopes.map((s) => Number(s.denomination) / 1e6);
const countByValue = (list: readonly NoteSummary[]): Map<number, number> => {
  const counts = new Map<number, number>();
  for (const n of list) counts.set(usdcOf(n), (counts.get(usdcOf(n)) ?? 0) + 1);
  return counts;
};
/** 100 → 1, 1 → 3 reads "1×100 + 3×1". */
const describe = (counts: ReadonlyMap<number, number>): string =>
  [...counts].sort((a, b) => b[0] - a[0]).map(([usdc, n]) => `${n}×${usdc}`).join(' + ');
/**
 * The note sizes a deposit makes: those whose pool already holds a ring, so
 * every note can be sent at once. A newer pool joins as soon as it fills (from
 * anyone's deposits); until then a note there would only wait. 1 USDC is
 * always offered, so a deposit always works.
 */
const readySizes = (): number[] => rt.scopes
  .filter((s) => Number(s.denomination) === 1_000_000 || (poolSizes.get(s.pool) ?? 0) >= RING_SIZE)
  .map((s) => Number(s.denomination) / 1e6);
/** Unknown size counts as filled: a read that failed is no reason to alarm. */
const ringReady = (n: NoteSummary): boolean => (poolSizes.get(n.scope.pool) ?? RING_SIZE) >= RING_SIZE;

/** A sentence on the pools, among these values, with under a ring of deposits counting `adding` more. */
function fillNote(values: Iterable<number>, adding: ReadonlyMap<number, number> = new Map()): string {
  const wanted = new Set(values);
  const short = rt.scopes.flatMap((s) => {
    const usdc = Number(s.denomination) / 1e6;
    const size = (poolSizes.get(s.pool) ?? RING_SIZE) + (adding.get(usdc) ?? 0);
    return wanted.has(usdc) && size < RING_SIZE ? [`the ${usdc}-USDC pool has ${size}`] : [];
  });
  if (short.length === 0) return '';
  const text = `${short.join(' and ')} of the ${RING_SIZE} deposits a ring needs, counting yours: notes there can be sent once others deposit.`;
  return ` ${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/** Deposits in each pool, through the mesh. One that fails keeps its last reading. */
async function refreshPools(): Promise<void> {
  await Promise.all(rt.scopes.map(async (s) => {
    try { poolSizes.set(s.pool, (await rt.readRing(s)).candidates.length); } catch { /* retried next time */ }
  }));
  renderBalance();
  renderDepositSplit();
}

async function refreshNotes(): Promise<void> {
  notes = (await Promise.all(rt.scopes.map((s) => rt.app.listNotes(s)))).flat();
  renderBalance();
}

function renderBalance(): void {
  const available = notes.filter((n) => n.state === 'AVAILABLE');
  const total = available.reduce((sum, n) => sum + usdcOf(n), 0);
  const waiting = available.filter((n) => !ringReady(n)).reduce((sum, n) => sum + usdcOf(n), 0);
  const count = `${available.length} note${available.length === 1 ? '' : 's'}`;
  const parts = [count, ...(waiting > 0 ? [`${waiting} USDC waits for its pool to fill`] : [])];
  if (accountUsdc >= 1 + DEPOSIT_GAS_USDC) parts.push(`${accountUsdc.toFixed(2)} USDC at your address, ready to deposit`);
  el('balance').textContent = `${total}.00`;
  el('note-count').textContent = parts.join(' · ');
  el('asset-balance').textContent = `${total}.00`;
  el('asset-notes').textContent = `${available.length} private note${available.length === 1 ? '' : 's'}`;
  el<HTMLButtonElement>('arm').disabled = available.length === 0;
}

function renderDepositSplit(): void {
  if (rt === undefined) return; // typed before the wallet started: rendered once it has
  const amount = depositAmount();
  if (amount === undefined) { el('deposit-split').textContent = 'Whole USDC only, 1 or more.'; return; }
  const counts = makeAmount(amount, readySizes())!;
  const notes = [...counts.values()].reduce((a, b) => a + b, 0);
  // Sizes the ideal split would use but whose pools are still filling.
  const filling = [...makeAmount(amount, denominations())!.keys()].filter((d) => !counts.has(d)).sort((a, b) => a - b);
  const later = filling.length === 0 ? '' : ` ${filling.join('-, ')}-USDC notes join once their pools hold ${RING_SIZE} deposits.`;
  // Say it here, while the amount is being typed, rather than letting the
  // deposit fail on a cap the field gives no hint of.
  if (notes > MAX_NOTES_PER_DEPOSIT) {
    el('deposit-split').textContent = `That is ${notes} notes (${describe(counts)}); one deposit holds up to ${MAX_NOTES_PER_DEPOSIT}.${later}`;
    return;
  }
  el('deposit-split').textContent = `As ${describe(counts)} USDC notes, each sendable at once.${later}`;
}

async function onDeposit(): Promise<void> {
  const button = el<HTMLButtonElement>('deposit');
  const status = el('deposit-status');
  const amount = depositAmount();
  if (amount === undefined) {
    status.textContent = 'Choose a whole amount of USDC, 1 or more.';
    return;
  }
  // The fewest notes, largest first, from pools that can hide them now.
  await refreshPools();
  const counts = makeAmount(amount, readySizes())!;
  const count = [...counts.values()].reduce((a, b) => a + b, 0);
  if (count > MAX_NOTES_PER_DEPOSIT) {
    status.textContent = `That is ${count} notes (${describe(counts)}); one deposit holds up to ${MAX_NOTES_PER_DEPOSIT}. Deposit it in two parts.`;
    return;
  }
  const notes = count === 1 ? 'one note' : `${count} notes`;
  button.disabled = true;
  try {
    // Deposits come from the account: ONE transaction however many notes,
    // signed by its PQ key, where a plain wallet would need a confirmation
    // per note. The first one also deploys the account, paid from the USDC at
    // its address. A funding wallet, if this browser has one, tops the
    // account up in one confirmation; without one (the extension), USDC is
    // sent to the address from anywhere.
    const state = await rt.app.walletState();
    const account = state.accountAddress as `0x${string}`;
    const want = amount + DEPOSIT_GAS_USDC;
    const topUp = Math.ceil((want - (await rt.accountFunds(account)).usdc) * 100) / 100;
    if (topUp > 0) {
      if (!rt.hasWallet) {
        status.textContent = `Send ${topUp.toFixed(2)} USDC to your Opaque address (${notes} and gas) from any wallet, then press Deposit again.`;
        el<HTMLDialogElement>('receive-dialog').showModal();
        return;
      }
      // This also verifies/switches the chain when an account was already exposed.
      if (!await connectFundingWallet()) return;
      status.textContent = `Confirm in your funding wallet: ${topUp.toFixed(2)} USDC to your account, for ${notes} and gas…`;
      await rt.fundAccount(account, topUp);
      // A lagging RPC node can still show the old balance; the deposit checks it.
      await settle(async () => (await rt.accountFunds(account)).usdc >= want - 0.005);
    }
    status.textContent = state.active
      ? `Signing one deposit of ${notes} with your account's PQ key; a public bundler submits it…`
      : `Signing your account's first operation with its PQ key: it sets the account up on chain and deposits ${notes}…`;
    const made = await rt.app.depositNotes(rt.scopes
      .filter((s) => counts.has(Number(s.denomination) / 1e6))
      .map((s) => ({ scope: s, count: counts.get(Number(s.denomination) / 1e6)! })));
    const waiting = made.filter((n) => n.state !== 'AVAILABLE').length;
    await refreshPools();
    status.textContent = waiting === 0
      ? `Deposited ${amount} USDC as ${describe(counts)}, on chain.${fillNote(counts.keys()) || ' Spendable now.'}`
      : `Deposit sent; ${waiting} of ${notes} still wait for the chain to confirm them.`;
    await Promise.all([refreshNotes(), renderBudget().catch(() => undefined)]);
  } catch (error) {
    status.textContent = isRejected(error) ? '' : `Deposit failed: ${(error as Error).message}`;
    // A deposit stopped halfway (a later popup rejected) still funded the
    // notes before it; listing finds them, so the balance shows what landed.
    await refreshNotes().catch(() => undefined);
  } finally {
    button.disabled = false;
  }
}

// ── the ring, through the mesh ────────────────────────────────────────────

function renderRingSvg(): void {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 190 190');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Ring of ${RING_SIZE} identical members`);
  const orbit = document.createElementNS(SVG_NS, 'circle');
  orbit.setAttribute('cx', '95'); orbit.setAttribute('cy', '95'); orbit.setAttribute('r', '68');
  orbit.setAttribute('class', 'ring-orbit');
  svg.append(orbit);
  // Identical radius, identical fill, identical everything. Marking the user's
  // own member would leak it the moment anyone screen-shares, and a UI that
  // knows which member signed is a UI that can be made to say so.
  for (let i = 0; i < RING_SIZE; i++) {
    const angle = (i / RING_SIZE) * Math.PI * 2 - Math.PI / 2;
    const node = document.createElementNS(SVG_NS, 'circle');
    node.setAttribute('cx', (95 + Math.cos(angle) * 68).toFixed(1));
    node.setAttribute('cy', (95 + Math.sin(angle) * 68).toFixed(1));
    node.setAttribute('r', '8');
    node.setAttribute('class', 'ring-node');
    svg.append(node);
  }
  const label = document.createElementNS(SVG_NS, 'text');
  label.setAttribute('x', '95'); label.setAttribute('y', '101'); label.setAttribute('class', 'ring-q');
  label.textContent = 'one signed';
  svg.append(label);
  el('ring-wrap').replaceChildren(svg);
}

function renderHops(): void {
  const row = el('hops');
  row.replaceChildren();
  hops.forEach((hop, i) => {
    if (i > 0) {
      const arrow = document.createElement('span');
      arrow.className = 'hop-arrow';
      arrow.textContent = '→';
      row.append(arrow);
    }
    const cell = document.createElement('span');
    cell.className = 'hop';
    cell.textContent = hop;
    row.append(cell);
  });
}

async function refreshRing(): Promise<void> {
  try {
    // Once a pool holds a ring, its score is the mesh's: the 1-USDC one stands for all.
    const [privacy, path] = await Promise.all([rt.readPrivacy(rt.scopes[rt.scopes.length - 1]!), rt.pathFor(), refreshPools()]);
    // Seven pools do not fit one stat: the total, then the pools holding any.
    const smallFirst = [...rt.scopes].reverse();
    const held = smallFirst.filter((s) => (poolSizes.get(s.pool) ?? 0) > 0);
    const total = held.reduce((sum, s) => sum + poolSizes.get(s.pool)!, 0);
    const empty = smallFirst.length - held.length;
    el('pool-size').innerHTML = '';
    el('pool-size').append(
      `${total.toLocaleString('en-US')} `,
      Object.assign(document.createElement('small'), {
        textContent: [...held.map((s) => `${poolSizes.get(s.pool)!.toLocaleString('en-US')} at ${Number(s.denomination) / 1e6} USDC`), ...(empty > 0 ? [`${empty} empty`] : [])].join(' · '),
      }),
    );
    el('freshness-now').textContent = String(Math.round(Number(privacy.privacyScore) / 100));
    // A sample path, drawn fresh. Each payment draws its own; this one only
    // shows the shape — three distinct relays under three distinct operators.
    hops = path.map((n) => n.id as string);
    renderHops();
  } catch (error) {
    el('freshness-now').textContent = '—';
    el('pool-size').textContent = `unreachable: ${(error as Error).message}`;
  }
}

// ── sending ───────────────────────────────────────────────────────────────

async function onSend(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const status = el('send-status');
  const recipient = el<HTMLInputElement>('recipient').value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(recipient)) {
    el('recipient').focus();
    status.textContent = 'Enter a recipient address (0x followed by 40 hex characters).';
    return;
  }
  // Paid in whole notes, each its own payment, the fewest that make the
  // amount exactly: a note is spent whole, with no change (§6.6).
  const amount = wholeAmount('send-amount');
  const available = notes.filter((n) => n.state === 'AVAILABLE');
  const total = available.reduce((sum, n) => sum + usdcOf(n), 0);
  if (amount === undefined) {
    status.textContent = 'Send a whole amount of USDC, 1 or more.';
    return;
  }
  if (amount > total) {
    status.textContent = total === 0 ? 'No spendable note. Deposit first.' : `You hold ${total} USDC in notes. Deposit more to send ${amount}.`;
    return;
  }
  let deadline: UnixSeconds;
  try {
    deadline = requestedDeadline();
  } catch (error) {
    status.textContent = (error as Error).message;
    el<HTMLInputElement>('privacy-deadline').focus();
    return;
  }

  const button = el<HTMLButtonElement>('arm');
  button.disabled = true;
  let done = 0;
  let count = 0;
  try {
    // Only notes whose pool already holds a ring's worth of deposits.
    status.textContent = 'Checking which of your notes their pools can hide…';
    await refreshPools();
    const ready = available.filter(ringReady);
    const pick = makeAmount(amount, denominations(), countByValue(ready));
    if (pick === undefined) {
      const waiting = available.filter((n) => !ringReady(n));
      status.textContent = `Your notes can't make exactly ${amount} USDC: each is sent whole, with no change.`
        + (ready.length > 0 ? ` Ready to send: ${describe(countByValue(ready))}.` : '')
        + (waiting.length > 0 ? ` Waiting for their pool to fill: ${describe(countByValue(waiting))}.` : '');
      return;
    }
    const queue = [...pick].flatMap(([usdc, n]) => ready.filter((note) => usdcOf(note) === usdc).slice(0, n));
    count = queue.length;

    // Out of band, BEFORE paying: the authority learns a recipient, never a
    // payment, and cannot tie the credential to the moment it is used.
    status.textContent = 'Getting a policy credential for this recipient…';
    const credentialHandle = await rt.obtainCredential(recipient as `0x${string}`);

    // Each note is its own payment, with its own proof and ~1 MB upload,
    // PAYMENT_LANES at a time.
    const group = `send-${Date.now()}`;
    status.textContent = count === 1
      ? 'Building the ring proof in this browser (a few seconds — the note secret never leaves the page)…'
      : `Building ${count} ring proofs in this browser and sending each across the mesh (the note secrets never leave the page)…`;
    // Immediate: settle on arrival (score 0), with a deadline taken per note
    // so a long queue cannot outlive it. Waiting: the user's score and time.
    const waitForPrivacy = el<HTMLInputElement>('wait-for-privacy').checked;
    const results = await runPaymentLanes(queue, PAYMENT_LANES, async (note) => {
      const ref = await rt.app.submitPayment({
          noteId: note.id,
          recipient: recipient as never,
          minPrivacyScore: (waitForPrivacy ? MIN_FRESHNESS * 100 : 0) as PrivacyScore,
          deadline: waitForPrivacy ? deadline : requestedDeadline(),
          credentialHandle,
          idempotencyKey: `pay-${note.id}-${Date.now()}` as never,
      });
      // Recorded as each one goes, so a failure later still shows these.
      sent.unshift({ handle: ref.statusHandle as string, recipient, at: Date.now(), group, usdc: usdcOf(note) });
      saveSent();
      done++;
      if (count > 1) status.textContent = `Sent ${done} of ${count} across the mesh…`;
    });
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length > 0) {
      const first = failures[0]!.reason as Error;
      throw new Error(`${failures.length} of ${count} note payments failed: ${first.message}`);
    }
    status.textContent = count === 1
      ? 'Sent across the mesh. It usually settles within seconds; Activity shows when it lands.'
      : `Sent ${amount} USDC as ${count} payments across the mesh. Each usually settles within seconds; Activity shows when they land.`;
    el<HTMLInputElement>('recipient').value = '';
    await refreshNotes();
    showView('activity');
    renderActivity();
  } catch (error) {
    status.textContent = done === 0
      ? `Not sent: ${(error as Error).message}`
      : `Sent ${done} of ${count}; the remaining note payments failed: ${(error as Error).message}`;
    if (done > 0) { await refreshNotes().catch(() => undefined); renderActivity(); }
  } finally {
    button.disabled = notes.every((n) => n.state !== 'AVAILABLE');
  }
}

// ── activity, through the mesh ────────────────────────────────────────────

function renderActivity(): void {
  const list = el('intent-list');
  if (sent.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Nothing sent yet.';
    list.replaceChildren(empty);
    return;
  }
  // One row per send, however many notes it took; payments from before
  // sends were grouped stand alone. `sent` is newest first, and a send's
  // payments are adjacent in it.
  const sends = new Map<string, SentPayment[]>();
  for (const p of sent) {
    const key = p.group ?? p.handle;
    sends.set(key, [...(sends.get(key) ?? []), p]);
  }
  list.replaceChildren(...[...sends.values()].map((payments) => {
    const row = document.createElement('div');
    row.className = 'intent';
    const head = document.createElement('div');
    head.className = 'intent-head';
    const amount = document.createElement('span');
    amount.className = 'intent-amt';
    amount.textContent = `${payments.reduce((sum, p) => sum + (p.usdc ?? 1), 0)}.00 USDC`;
    const badge = document.createElement('span');
    const settled = payments.filter((p) => p.state === 'SETTLED').length;
    const failed = payments.filter((p) => p.state === 'FAILED').length;
    const state = payments.length === 1 ? (payments[0]!.state ?? 'WAITING_FOR_PRIVACY').replaceAll('_', ' ').toLowerCase()
      : settled === payments.length ? 'settled'
      : failed > 0 ? `${failed} of ${payments.length} failed`
      : settled > 0 ? `${settled} of ${payments.length} settled` : 'waiting for privacy';
    badge.className = `intent-state ${state === 'settled' ? 'settled' : 'armed'}`;
    badge.textContent = state;
    head.append(amount, badge);
    const meta = document.createElement('p');
    meta.className = 'intent-meta';
    const short = document.createElement('code');
    const recipient = payments[0]!.recipient;
    short.textContent = `${recipient.slice(0, 6)}…${recipient.slice(-4)}`;
    meta.append('to ', short);
    if (payments.length > 1) meta.append(` · ${payments.length} private payments`);
    // Each note settles in its own transaction.
    const txs = payments.filter((p) => p.txHash !== undefined).reverse();
    txs.forEach((p, i) => {
      const link = document.createElement('a');
      link.href = `https://testnet.arcscan.app/tx/${p.txHash}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = payments.length === 1 ? 'view settlement' : `settlement ${i + 1}`;
      meta.append(i === 0 ? document.createElement('br') : ' · ', link);
    });
    row.append(head, meta);
    return row;
  }));
}

let polling = false;
async function pollActivity(): Promise<void> {
  // A round can outlast the interval when many payments are in flight.
  if (polling) return;
  polling = true;
  let changed = false;
  try {
    for (const p of sent) {
      if (p.state !== undefined && TERMINAL.has(p.state)) continue;
      try {
        const s = await rt.readStatus(p.handle as StatusHandle);
        if (s.state !== p.state || s.txHash !== p.txHash) {
          p.state = s.state;
          if (s.txHash !== undefined) p.txHash = s.txHash;
          changed = true;
        }
      } catch { /* a missed poll is retried next tick; it is not a failure */ }
    }
  } finally { polling = false; }
  if (changed) { saveSent(); renderActivity(); }
}

// ── wiring ────────────────────────────────────────────────────────────────

type View = 'home' | 'send' | 'ring' | 'activity';
function showView(name: View): void {
  for (const view of ['home', 'send', 'ring', 'activity'] as const) {
    el(`view-${view}`).hidden = view !== name;
    el(`tab-${view}`).setAttribute('aria-selected', String(view === name));
  }
}

async function init(): Promise<void> {
  el('tab-home').addEventListener('click', () => showView('home'));
  el('tab-send').addEventListener('click', () => showView('send'));
  el('tab-ring').addEventListener('click', () => { showView('ring'); void refreshRing(); });
  el('tab-activity').addEventListener('click', () => { showView('activity'); void pollActivity(); });
  el<HTMLFormElement>('send-form').addEventListener('submit', (e) => void onSend(e as SubmitEvent));
  el<HTMLInputElement>('wait-for-privacy').addEventListener('change', syncPrivacyWait);
  syncPrivacyWait();
  el('deposit').addEventListener('click', () => void onDeposit());
  onlyWholeAmounts(el<HTMLInputElement>('deposit-count'), renderDepositSplit);
  onlyWholeAmounts(el<HTMLInputElement>('send-amount'), () => undefined);
  el('action-send').addEventListener('click', () => showView('send'));
  el('action-receive').addEventListener('click', () => el<HTMLDialogElement>('receive-dialog').showModal());
  el('account-button').addEventListener('click', () => el<HTMLDialogElement>('account-dialog').showModal());
  el('copy-address').addEventListener('click', (event) => void copyText(opaqueAddress, event.currentTarget as HTMLButtonElement));
  el('refresh-balance').addEventListener('click', () => { void refreshNotes(); void renderBudget().catch(() => undefined); });
  el('connect-wallet').addEventListener('click', () => void connectFundingWallet());
  el('rotate').addEventListener('click', () => void onRotate());
  el('withdraw').addEventListener('click', () => void onWithdraw());
  el('backup-export').addEventListener('click', () => void onBackupExport());
  el('backup-import').addEventListener('click', () => el<HTMLInputElement>('backup-file').click());
  el<HTMLInputElement>('backup-file').addEventListener('change', (event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (file !== undefined) void onBackupImport(file);
    (event.currentTarget as HTMLInputElement).value = '';
  });
  el('network-button').addEventListener('click', () => void connectFundingWallet());
  document.querySelectorAll<HTMLElement>('[data-back]').forEach((node) => node.addEventListener('click', () => showView('home')));
  renderRingSvg();
  renderActivity();

  try {
    rt = await startWallet();
  } catch (error) {
    showBootError(`Could not start: ${(error as Error).message}`);
    return;
  }
  // The PQ account key lives in this browser; create one the first time.
  try { await rt.app.walletState(); } catch { await rt.app.createWallet(); }

  // One failed read must not stop the rest of the page from starting.
  await Promise.all([
    refreshNotes().catch(() => { el('note-count').textContent = 'Could not read notes — Refresh to retry'; }),
    renderBudget().catch(() => undefined),
  ]);
  renderDepositSplit();
  void refreshPools();
  await readFundingWallet().catch(() => undefined);
  provider()?.on?.('accountsChanged', () => void readFundingWallet());
  provider()?.on?.('chainChanged', () => void readFundingWallet());
  void refreshRing();
  void pollActivity();
  setInterval(() => void pollActivity(), 5_000);
  // USDC sent to the address from any wallet shows up without a refresh.
  setInterval(() => void renderBudget().catch(() => undefined), 20_000);
  // Exposed for the end-to-end test and for poking at in devtools.
  (globalThis as { opaque?: WalletRuntime }).opaque = rt;
}

void init();
