// chaff wallet — the UI.
//
// Two rules kept strictly, because these exact bytes ship as the extension
// popup as well as the hosted page:
//
//   * every handler is attached with addEventListener — Manifest V3 forbids
//     inline handlers, so app.html has none to attach;
//   * nothing is eval'd or built from a string.
//
// extension/build.mjs fails the build if app.html ever breaks the first rule,
// because Chrome's symptom is a silently blank popup.

import {
  RING_VERIFY_GAS,
  armIntent,
  drawHops,
  drawRing,
  formatUsdc,
  gasCost,
  getBalance,
  getIntents,
  getKey,
  getPool,
  parseUsdc,
  tick,
  weiToUsdc,
  type Hex,
} from './chain.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Throws rather than returning null: a missing id is a broken build, not a runtime case. */
function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`app.html is missing #${id}`);
  return node as T;
}

let ring: readonly Hex[] = [];
let hops: readonly string[] = [];

// ── the signature budget ──────────────────────────────────────────────────

function renderBudget(): void {
  const key = getKey();
  const left = Math.max(0, key.maxUses - key.useCount);
  const low = left <= Math.ceil(key.maxUses / 4);

  el('sig-left').textContent = String(left);
  el('sig-max').textContent = `of ${key.maxUses}`;

  // One cell per signature, not a percentage bar. With a few-time scheme the
  // count is small enough to be countable, and "2 left" versus "3 left"
  // matters far more than twelve percent of a bar does.
  const meter = el('meter');
  meter.classList.toggle('low', low);
  meter.replaceChildren(
    ...Array.from({ length: key.maxUses }, (_, i) => {
      const cell = document.createElement('i');
      if (i < left) cell.className = 'on';
      return cell;
    }),
  );

  el('budget-note').innerHTML = low
    ? `<b>Rotate soon.</b> FORS+C is few-time: signing past the cap is a break, not a warning. The next key must be pre-registered by ${key.rotationDeadline}.`
    : `Key <code>${key.pkCommitment}</code> — rotate by ${key.rotationDeadline}.`;
}

// ── the ring ──────────────────────────────────────────────────────────────

function renderRing(): void {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 190 190');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Ring of ${ring.length} identical members`);

  const orbit = document.createElementNS(SVG_NS, 'circle');
  orbit.setAttribute('cx', '95');
  orbit.setAttribute('cy', '95');
  orbit.setAttribute('r', '68');
  orbit.setAttribute('class', 'ring-orbit');
  svg.append(orbit);

  // Identical radius, identical fill, identical everything. Marking the user's
  // own member would leak it the moment anyone screen-shares, and a UI that
  // knows which member signed is a UI that can be made to say so.
  ring.forEach((_, i) => {
    const angle = (i / ring.length) * Math.PI * 2 - Math.PI / 2;
    const node = document.createElementNS(SVG_NS, 'circle');
    node.setAttribute('cx', (95 + Math.cos(angle) * 68).toFixed(1));
    node.setAttribute('cy', (95 + Math.sin(angle) * 68).toFixed(1));
    node.setAttribute('r', '8');
    node.setAttribute('class', 'ring-node');
    svg.append(node);
  });

  const label = document.createElementNS(SVG_NS, 'text');
  label.setAttribute('x', '95');
  label.setAttribute('y', '101');
  label.setAttribute('class', 'ring-q');
  label.textContent = 'one signed';
  svg.append(label);

  el('ring-wrap').replaceChildren(svg);

  const pool = getPool();
  el('freshness-now').textContent = String(Math.round(pool.freshnessScore));
  el('pool-size').innerHTML = `${pool.poolSize.toLocaleString('en-US')} <small>commitments</small>`;

  const hopRow = el('hops');
  hopRow.replaceChildren();
  hops.forEach((hop, i) => {
    if (i > 0) {
      const arrow = document.createElement('span');
      arrow.className = 'hop-arrow';
      arrow.textContent = '→';
      hopRow.append(arrow);
    }
    const cell = document.createElement('span');
    cell.className = 'hop';
    cell.textContent = hop;
    hopRow.append(cell);
  });
}

// ── intents ───────────────────────────────────────────────────────────────

function renderIntents(): void {
  const list = el('intent-list');
  const intents = getIntents();

  if (intents.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Nothing armed yet.';
    list.replaceChildren(empty);
    return;
  }

  list.replaceChildren(
    ...intents.map((intent) => {
      const row = document.createElement('div');
      row.className = 'intent';

      const head = document.createElement('div');
      head.className = 'intent-head';

      const amount = document.createElement('span');
      amount.className = 'intent-amt';
      amount.textContent = `${formatUsdc(intent.amount)} USDC`;

      const badge = document.createElement('span');
      badge.className = `intent-state ${intent.status}`;
      badge.textContent = intent.status;

      head.append(amount, badge);

      const short = `${intent.recipient.slice(0, 6)}…${intent.recipient.slice(-4)}`;
      const meta = document.createElement('p');
      meta.className = 'intent-meta';
      meta.innerHTML =
        intent.status === 'settled'
          ? `to <code>${short}</code><br>fired at freshness ${intent.firedAt} · nullifier <code>${intent.nullifier}</code>`
          : `to <code>${short}</code><br>waiting for freshness ≥ ${intent.minFreshnessScore}, or ${intent.deadlineHours}h`;

      row.append(head, meta);
      return row;
    }),
  );
}

// ── wiring ────────────────────────────────────────────────────────────────

type View = 'send' | 'ring' | 'activity';

function showView(name: View): void {
  for (const view of ['send', 'ring', 'activity'] as const) {
    el(`view-${view}`).hidden = view !== name;
    el(`tab-${view}`).setAttribute('aria-selected', String(view === name));
  }
}

function onArm(event: SubmitEvent): void {
  event.preventDefault();

  const amount = parseUsdc(el<HTMLInputElement>('amount').value);
  const recipient = el<HTMLInputElement>('recipient').value.trim();

  if (amount === null || amount <= 0n) {
    el('amount').focus();
    return;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    el('recipient').focus();
    return;
  }

  armIntent({
    recipient: recipient as Hex,
    amount,
    minFreshnessScore: Number(el<HTMLInputElement>('freshness').value),
    deadlineHours: Number(el<HTMLInputElement>('deadline').value),
  });

  el<HTMLInputElement>('recipient').value = '';
  showView('activity');
  renderIntents();
}

function render(): void {
  renderBudget();
  renderRing();
  renderIntents();
  el('balance').textContent = formatUsdc(getBalance());
}

function init(): void {
  ring = drawRing();
  hops = drawHops();

  const fee = formatUsdc(weiToUsdc(gasCost(RING_VERIFY_GAS)));
  el('fee-note').innerHTML =
    `Ring verification is budgeted at ${RING_VERIFY_GAS / 1_000_000n}M gas — Arc's per-block ceiling, ` +
    `and the worst case for this design. At Arc's 20 Gwei floor that is <b>${fee} USDC</b>, paid by the ` +
    `relay and reimbursed from the pool in the same asset. The real number lands with the §6.3 spike.`;

  el('tab-send').addEventListener('click', () => showView('send'));
  el('tab-ring').addEventListener('click', () => showView('ring'));
  el('tab-activity').addEventListener('click', () => showView('activity'));
  el<HTMLFormElement>('send-form').addEventListener('submit', onArm as EventListener);

  render();
  setInterval(() => {
    tick();
    render();
  }, 2000);
}

init();
