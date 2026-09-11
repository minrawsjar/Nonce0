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
// verified relay directory, payment status through the mesh. Nothing is
// simulated in the page — what IS simulated (the CRE enclave, a one-operator
// mesh) is named in #caps, read from the stack.

import type { IntentStatus, NoteSummary, PrivacyScore, StatusHandle, UnixSeconds } from '@opaque/protocol-types';

import { MAX_NOTES_PER_DEPOSIT } from './lib/protocol/index.js';
import { startWallet, type WalletRuntime } from './lib/runtime.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_SIZE = 8;

/** Throws rather than returning null: a missing id is a broken build, not a runtime case. */
function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`app.html is missing #${id}`);
  return node as T;
}

let rt: WalletRuntime;
let notes: readonly NoteSummary[] = [];
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
/**
 * Timing protection, fixed rather than asked for. A payment goes as soon as
 * the privacy score (the lower of pool coverage and relay health) reaches
 * MIN_FRESHNESS of 100 — in practice at once — and waits only while relays
 * look unhealthy or their health is unknown, for MAX_WAIT_SECONDS at most.
 */
const MIN_FRESHNESS = 70;
/** Payments of one send in flight at once. ponytail: fixed; tune to the relays' capacity if sends grow. */
const PAYMENT_LANES = 3;
const MAX_WAIT_SECONDS = 3_600;
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
  document.querySelector('.network .live-dot')?.classList.toggle('wrong', !correct);
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
  const note = el('budget-note');
  note.replaceChildren();
  const code = document.createElement('code');
  code.textContent = state.pkCommitment.slice(0, 18) + '…';
  note.append('Account key ', code, ' — FORS+C, few-time, kept in this browser only. It signs deposits from the account; ring payments are authorised by the proof.');

  const funds = await rt.accountFunds(opaqueAddress as `0x${string}`).catch(() => undefined);
  const balance = funds === undefined ? '' : ` · ${funds.usdc.toFixed(2)} USDC`;
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

async function refreshNotes(): Promise<void> {
  notes = await rt.app.listNotes(rt.scope);
  const available = notes.filter((n) => n.state === 'AVAILABLE');
  el('balance').textContent = `${available.length}.00`;
  el('note-count').textContent = `${available.length} note${available.length === 1 ? '' : 's'}`;
  el('asset-balance').textContent = `${available.length}.00`;
  el('asset-notes').textContent = `${available.length} private note${available.length === 1 ? '' : 's'}`;
  el<HTMLButtonElement>('arm').disabled = available.length === 0;
  el<HTMLInputElement>('send-amount').max = String(Math.max(1, available.length));
}

async function onDeposit(): Promise<void> {
  const button = el<HTMLButtonElement>('deposit');
  const status = el('deposit-status');
  // An amount is a count of notes: every note is the pool's one denomination.
  const count = Number(el<HTMLInputElement>('deposit-count').value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_NOTES_PER_DEPOSIT) {
    status.textContent = `Choose a whole amount from 1 to ${MAX_NOTES_PER_DEPOSIT} USDC.`;
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
    const want = count + DEPOSIT_GAS_USDC;
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
    const made = await rt.app.depositNotes(rt.scope, count);
    const waiting = made.filter((n) => n.state !== 'AVAILABLE').length;
    status.textContent = waiting === 0
      ? `Deposited ${count} USDC as ${notes}, on chain and spendable.`
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
    const [ring, privacy, path] = await Promise.all([rt.readRing(), rt.readPrivacy(), rt.pathFor()]);
    el('pool-size').innerHTML = '';
    el('pool-size').append(`${ring.candidates.length.toLocaleString('en-US')} `, Object.assign(document.createElement('small'), { textContent: 'deposits' }));
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
  // An amount is a count of notes, each spent as its own payment: a note is
  // always the pool's one denomination (§6.6), so there is no change to make.
  const count = Number(el<HTMLInputElement>('send-amount').value);
  const available = notes.filter((n) => n.state === 'AVAILABLE');
  if (!Number.isInteger(count) || count < 1) {
    status.textContent = 'Send a whole amount of USDC: every note is exactly 1 USDC.';
    return;
  }
  if (count > available.length) {
    status.textContent = available.length === 0
      ? 'No spendable note. Deposit first.'
      : `You hold ${available.length} USDC in notes. Deposit more to send ${count}.`;
    return;
  }

  const button = el<HTMLButtonElement>('arm');
  button.disabled = true;
  let done = 0;
  try {
    // Out of band, BEFORE paying: the authority learns a recipient, never a
    // payment, and cannot tie the credential to the moment it is used.
    status.textContent = 'Getting a policy credential for this recipient…';
    const credentialHandle = await rt.obtainCredential(recipient as `0x${string}`);

    // Each note is its own payment, with its own proof and upload. A few at
    // once: the proof of one overlaps the ~1 MB upload of another, and the
    // relays see several unrelated uploads rather than one long one.
    const group = `send-${Date.now()}`;
    const queue = available.slice(0, count);
    status.textContent = count === 1
      ? 'Building the ring proof in this browser (a few seconds — the note secret never leaves the page)…'
      : `Building ${count} ring proofs in this browser and sending each across the mesh (the note secrets never leave the page)…`;
    let failure: unknown;
    const lane = async (): Promise<void> => {
      for (let note = queue.shift(); note !== undefined && failure === undefined; note = queue.shift()) {
        const ref = await rt.app.submitPayment({
          noteId: note.id,
          recipient: recipient as never,
          minPrivacyScore: (MIN_FRESHNESS * 100) as PrivacyScore,
          deadline: (BigInt(Math.floor(Date.now() / 1000) + MAX_WAIT_SECONDS)) as UnixSeconds,
          credentialHandle,
          idempotencyKey: `pay-${note.id}-${Date.now()}` as never,
        });
        // Recorded as each one goes, so a failure later still shows these.
        sent.unshift({ handle: ref.statusHandle as string, recipient, at: Date.now(), group });
        saveSent();
        done++;
        if (count > 1) status.textContent = `Sent ${done} of ${count} across the mesh…`;
      }
    };
    await Promise.all(Array.from({ length: Math.min(PAYMENT_LANES, count) }, () => lane().catch((error: unknown) => { failure ??= error; })));
    if (failure !== undefined) throw failure;
    status.textContent = count === 1
      ? 'Sent across the mesh. It usually settles within seconds; Activity shows when it lands.'
      : `Sent ${count} payments across the mesh. Each usually settles within seconds; Activity shows when they land.`;
    el<HTMLInputElement>('recipient').value = '';
    await refreshNotes();
    showView('activity');
    renderActivity();
  } catch (error) {
    status.textContent = done === 0
      ? `Not sent: ${(error as Error).message}`
      : `Sent ${done} of ${count}; the rest were not sent: ${(error as Error).message}`;
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
    amount.textContent = `${payments.length}.00 USDC`;
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
    if (payments.length > 1) meta.append(` · ${payments.length} private payments of 1 USDC`);
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

// ── what this build is, read not assumed ──────────────────────────────────

async function renderCapabilities(): Promise<void> {
  const caps = await rt.app.capabilities(rt.scope);
  const stack = rt.config.capabilities;
  const parts = [
    `Pool ${caps.proofMode === 'RING_8' ? `RING_8 — ${caps.ringSize}-member ring, verified off chain by an attester` : caps.proofMode}`,
    `CRE ${stack.confidentialExecution === 'SIMULATED' ? 'SIMULATED (not an enclave)' : 'attested'}`,
    'mesh: six relays, one operator',
    `PQ account ${stack.pqWallet === 'MOCK' ? 'on a mock chain' : 'live'}`,
  ];
  el('caps').textContent = parts.join(' · ');
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
  el('deposit').addEventListener('click', () => void onDeposit());
  el<HTMLInputElement>('deposit-count').max = String(MAX_NOTES_PER_DEPOSIT);
  el('action-send').addEventListener('click', () => showView('send'));
  el('action-receive').addEventListener('click', () => el<HTMLDialogElement>('receive-dialog').showModal());
  el('account-button').addEventListener('click', () => el<HTMLDialogElement>('account-dialog').showModal());
  el('copy-address').addEventListener('click', (event) => void copyText(opaqueAddress, event.currentTarget as HTMLButtonElement));
  el('refresh-balance').addEventListener('click', () => void refreshNotes());
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
    el('caps').textContent = `Could not start: ${(error as Error).message}`;
    return;
  }
  // The PQ account key lives in this browser; create one the first time.
  try { await rt.app.walletState(); } catch { await rt.app.createWallet(); }

  // One failed read must not stop the rest of the page from starting.
  await Promise.all([
    renderCapabilities().catch((error: Error) => { el('caps').textContent = `Could not read the pool: ${error.message}`; }),
    refreshNotes().catch(() => { el('note-count').textContent = 'Could not read notes — Refresh to retry'; }),
    renderBudget().catch(() => undefined),
  ]);
  await readFundingWallet().catch(() => undefined);
  provider()?.on?.('accountsChanged', () => void readFundingWallet());
  provider()?.on?.('chainChanged', () => void readFundingWallet());
  void refreshRing();
  void pollActivity();
  setInterval(() => void pollActivity(), 5_000);
  // Exposed for the end-to-end test and for poking at in devtools.
  (globalThis as { opaque?: WalletRuntime }).opaque = rt;
}

void init();
