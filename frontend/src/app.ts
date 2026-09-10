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
    el('funding-state').textContent = 'No browser wallet found';
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
    : `Not activated${balance} · deposits come from your funding wallet`;
  el('activate').hidden = state.active;
  el('withdraw-box').hidden = !state.active || (funds?.usdc ?? 0) === 0;
  // Two signatures are held back for exactly this, so a key can always rotate.
  const rotate = el<HTMLButtonElement>('rotate');
  rotate.hidden = !state.active;
  rotate.textContent = low ? 'Rotate key now: few signatures left' : 'Rotate key';
}

async function onRotate(): Promise<void> {
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

async function onActivate(): Promise<void> {
  const button = el<HTMLButtonElement>('activate');
  if (!await connectFundingWallet()) return;
  button.disabled = true;
  setStatus('wallet-status', 'Confirm in your funding wallet: it pays to deploy the account, and gets no power over it…');
  try {
    await rt.app.registerWallet();
    await settle(async () => (await rt.app.walletState()).active);
    setStatus('wallet-status', 'Activated. Send USDC to the account address, and deposits come from it.');
    await renderBudget();
  } catch (error) {
    setStatus('wallet-status', isRejected(error) ? '' : `Could not activate: ${(error as Error).message}`);
  } finally { button.disabled = false; }
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
}

async function onDeposit(): Promise<void> {
  const button = el<HTMLButtonElement>('deposit');
  const status = el('deposit-status');
  // An activated account deposits by itself; only the funding-wallet path needs one connected.
  const fromAccount = (await rt.app.walletState().catch(() => undefined))?.active === true;
  if (!fromAccount) {
    if (!rt.hasWallet) {
      await connectFundingWallet();
      return;
    }
    // This also verifies/switches the chain when an account was already exposed.
    if (!await connectFundingWallet()) return;
  }
  button.disabled = true;
  status.textContent = fromAccount
    ? 'Signing the deposit with your account\'s PQ key; a public bundler submits it…'
    : 'Approve exactly 1 USDC, then confirm the deposit in your funding wallet…';
  try {
    const note = await rt.app.deposit(rt.scope);
    status.textContent = note.state === 'AVAILABLE'
      ? 'Deposited. The note is on chain and spendable.'
      : `Deposit sent; the note is ${note.state} until the chain confirms it.`;
    await Promise.all([refreshNotes(), renderBudget().catch(() => undefined)]);
  } catch (error) {
    status.textContent = isRejected(error) ? '' : `Deposit failed: ${(error as Error).message}`;
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
  const note = notes.find((n) => n.state === 'AVAILABLE');
  if (note === undefined) {
    status.textContent = 'No spendable note. Deposit 1 USDC first.';
    return;
  }

  const button = el<HTMLButtonElement>('arm');
  button.disabled = true;
  try {
    // Out of band, BEFORE paying: the authority learns a recipient, never a
    // payment, and cannot tie the credential to the moment it is used.
    status.textContent = 'Getting a policy credential for this recipient…';
    const credentialHandle = await rt.obtainCredential(recipient as `0x${string}`);

    status.textContent = 'Building the ring proof in this browser (a few seconds — the note secret never leaves the page)…';
    const hours = Math.max(1, Math.min(72, Number(el<HTMLInputElement>('deadline').value) || 12));
    const freshness = Math.max(0, Math.min(100, Number(el<HTMLInputElement>('freshness').value) || 70));
    const ref = await rt.app.submitPayment({
      noteId: note.id,
      recipient: recipient as never,
      minPrivacyScore: (freshness * 100) as PrivacyScore,
      deadline: (BigInt(Math.floor(Date.now() / 1000) + hours * 3600)) as UnixSeconds,
      credentialHandle,
      idempotencyKey: `pay-${note.id}-${Date.now()}` as never,
    });
    sent.unshift({ handle: ref.statusHandle as string, recipient, at: Date.now() });
    saveSent();
    status.textContent = 'Sent across the mesh. It settles when cover is good enough, or at the deadline.';
    el<HTMLInputElement>('recipient').value = '';
    await refreshNotes();
    showView('activity');
    renderActivity();
  } catch (error) {
    status.textContent = `Not sent: ${(error as Error).message}`;
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
  list.replaceChildren(...sent.map((p) => {
    const row = document.createElement('div');
    row.className = 'intent';
    const head = document.createElement('div');
    head.className = 'intent-head';
    const amount = document.createElement('span');
    amount.className = 'intent-amt';
    amount.textContent = '1.00 USDC';
    const badge = document.createElement('span');
    const state = p.state ?? 'WAITING_FOR_PRIVACY';
    badge.className = `intent-state ${state === 'SETTLED' ? 'settled' : 'armed'}`;
    badge.textContent = state.replaceAll('_', ' ').toLowerCase();
    head.append(amount, badge);
    const meta = document.createElement('p');
    meta.className = 'intent-meta';
    const short = document.createElement('code');
    short.textContent = `${p.recipient.slice(0, 6)}…${p.recipient.slice(-4)}`;
    meta.append('to ', short);
    if (p.txHash !== undefined) {
      const link = document.createElement('a');
      link.href = `https://testnet.arcscan.app/tx/${p.txHash}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'view settlement';
      meta.append(document.createElement('br'), link);
    }
    row.append(head, meta);
    return row;
  }));
}

async function pollActivity(): Promise<void> {
  let changed = false;
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
  el('fee-note').textContent =
    'The ring proof is verified off chain; on chain the pool checks the attester\'s post-quantum signature '
    + 'and that every ring member is a real deposit — about 556k gas, paid by the relay egress.';
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
  el('action-send').addEventListener('click', () => showView('send'));
  el('action-receive').addEventListener('click', () => el<HTMLDialogElement>('receive-dialog').showModal());
  el('account-button').addEventListener('click', () => el<HTMLDialogElement>('account-dialog').showModal());
  el('copy-address').addEventListener('click', (event) => void copyText(opaqueAddress, event.currentTarget as HTMLButtonElement));
  el('refresh-balance').addEventListener('click', () => void refreshNotes());
  el('connect-wallet').addEventListener('click', () => void connectFundingWallet());
  el('activate').addEventListener('click', () => void onActivate());
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

  await Promise.all([renderCapabilities(), refreshNotes(), renderBudget().catch(() => undefined)]);
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
