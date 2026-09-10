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
// mesh, the PQ account's chain) is named in #caps, read from the stack.

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
  const max = Number(state.maxUses);
  const left = Math.max(0, max - Number(state.localSigningReservations));
  const low = left <= Math.ceil(max / 4);

  el('sig-left').textContent = String(left);
  el('sig-max').textContent = `of ${max}`;
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
  note.append('Account key ', code, ' — FORS+C, few-time. Ring payments are authorised by the proof, not by this key.');
}

// ── notes ─────────────────────────────────────────────────────────────────

async function refreshNotes(): Promise<void> {
  notes = await rt.app.listNotes(rt.scope);
  const available = notes.filter((n) => n.state === 'AVAILABLE');
  el('balance').textContent = `${available.length}.00`;
  el('note-count').textContent = `${available.length} note${available.length === 1 ? '' : 's'}`;
  el<HTMLButtonElement>('arm').disabled = available.length === 0;
}

async function onDeposit(): Promise<void> {
  const button = el<HTMLButtonElement>('deposit');
  const status = el('send-status');
  if (!rt.hasWallet) {
    status.textContent = 'Depositing needs a wallet on Arc testnet (MetaMask or any EIP-1193 wallet), with USDC from faucet.circle.com.';
    return;
  }
  button.disabled = true;
  status.textContent = 'Approve exactly 1 USDC, then confirm the deposit… (a deposit is public by design)';
  try {
    const note = await rt.app.deposit(rt.scope);
    status.textContent = note.state === 'AVAILABLE'
      ? 'Deposited. The note is on chain and spendable.'
      : `Deposit sent; the note is ${note.state} until the chain confirms it.`;
    await refreshNotes();
  } catch (error) {
    status.textContent = `Deposit failed: ${(error as Error).message}`;
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

type View = 'send' | 'ring' | 'activity';
function showView(name: View): void {
  for (const view of ['send', 'ring', 'activity'] as const) {
    el(`view-${view}`).hidden = view !== name;
    el(`tab-${view}`).setAttribute('aria-selected', String(view === name));
  }
}

async function init(): Promise<void> {
  el('tab-send').addEventListener('click', () => showView('send'));
  el('tab-ring').addEventListener('click', () => { showView('ring'); void refreshRing(); });
  el('tab-activity').addEventListener('click', () => { showView('activity'); void pollActivity(); });
  el<HTMLFormElement>('send-form').addEventListener('submit', (e) => void onSend(e as SubmitEvent));
  el('deposit').addEventListener('click', () => void onDeposit());
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
  void refreshRing();
  void pollActivity();
  setInterval(() => void pollActivity(), 5_000);
  // Exposed for the end-to-end test and for poking at in devtools.
  (globalThis as { opaque?: WalletRuntime }).opaque = rt;
}

void init();
