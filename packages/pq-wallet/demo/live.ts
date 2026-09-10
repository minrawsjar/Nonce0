import { formatUnits, parseUnits, decodeAbiParameters } from 'viem';
import { asAddress } from '@opaque/protocol-types/codecs.js';
import { IndexedDbSignerStore } from '../src/indexeddb-store.ts';
import { IndexedDbAccountStore } from '../src/operation-outbox.ts';
import { AccountWalletController } from '../src/account-wallet.ts';
import { ArcChainAdapter } from '../src/arc-chain-adapter.ts';
import { parseAccountConfig } from '../src/account-config.ts';
import { decodeAction, encodeOperation } from '../src/user-operation.ts';
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let controller: AccountWalletController | undefined;
let busy = false;
let nextAction: (() => Promise<unknown>) | undefined;
const controls = ['create', 'activate', 'refresh', 'prepare', 'approve', 'submit', 'abandon', 'rotate', 'disable', 'takeover', 'recipient', 'amount'];
function notice(message: string, error = false): void { el('notice').textContent = message; el('notice').className = error ? 'error' : ''; }
function disabled(value: boolean): void { for (const id of controls) (el(id) as HTMLButtonElement).disabled = value; }
async function render(): Promise<void> {
  disabled(true); if (!controller || busy) return;
  el<HTMLButtonElement>('refresh').disabled = false;
  const stored = await controller.store.read();
  el<HTMLButtonElement>('create').disabled = !!stored;
  if (!stored) return;
  const record = await controller.inspect(); const state = await controller.wallet.getState();
  const observation = await controller.network.observe(state.accountAddress);
  el('address').textContent = state.accountAddress;
  el('balance').textContent = `${formatUnits(await controller.network.client.getBalance({ address: state.accountAddress }), 18)} USDC`;
  el('capacity').textContent = `Key ${state.keyEpoch + 1n} · ${state.localSigningReservations}/8 signing slots used · ${state.chainUseCount} accepted by the network`;
  const pending = record.pending && !record.pending.receipt ? record.pending : undefined;
  el('status').textContent = state.active ? 'Active' : record.registered ? 'Unavailable' : 'Not activated';
  el('pending').textContent = pending ? `Request status: ${pending.phase}. Refresh to check confirmation.` : 'No pending operation.';
  el<HTMLButtonElement>('activate').disabled = record.registered || !!pending && decodeAction(pending.operation.callData).kind !== 0;
  for (const id of ['prepare', 'recipient', 'amount', 'rotate', 'disable']) (el(id) as HTMLButtonElement).disabled = !state.active || !!pending;
  el<HTMLButtonElement>('submit').disabled = !pending || pending.phase === 'prepared';
  el<HTMLButtonElement>('abandon').disabled = !pending;
  const disableAfter = observation.state?.disableAfter ?? 0n;
  el('timer').textContent = disableAfter ? `Disable time: ${new Date(Number(disableAfter) * 1000).toLocaleString()}` : '';
  el<HTMLButtonElement>('disable').disabled ||= disableAfter !== 0n;
  el<HTMLButtonElement>('takeover').disabled = !disableAfter || observation.now < disableAfter || !!pending;
  el('review').hidden = !pending || pending.phase !== 'prepared' || decodeAction(pending.operation.callData).kind !== 1;
  el<HTMLButtonElement>('approve').disabled = !!el('review').hidden;
  if (!el('review').hidden && pending) {
    const { data } = decodeAction(pending.operation.callData);
    const [calls] = decodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }], data);
    if (calls.length !== 1 || calls[0]!.data !== '0x') throw new Error('This screen only approves native USDC transfers');
    el('review-text').textContent = `Send ${formatUnits(calls[0]!.value, 18)} test USDC to ${calls[0]!.target}. Approval expires ${new Date(Number(pending.context.validUntil) * 1000).toLocaleTimeString()}.`;
  }
  const list = el('history'); list.replaceChildren();
  for (const receipt of record.history.slice(-10).reverse()) {
    const item = document.createElement('li'); const link = document.createElement('a');
    link.textContent = `${receipt.success ? 'Executed' : 'Execution failed'} · ${receipt.transactionHash.slice(0, 14)}…`;
    if (controller.network.config.chainId === 5042002) { link.href = `https://testnet.arcscan.app/tx/${receipt.transactionHash}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    item.append(link); list.append(item);
  }
}
async function run(action: () => Promise<unknown>, success: string): Promise<void> {
  if (busy || !controller) return;
  busy = true; disabled(true); notice('Working on your wallet…');
  let failure: unknown;
  try { await action(); } catch (error) { failure = error; }
  busy = false;
  try { await render(); } catch (error) { disabled(true); failure ??= error; }
  notice(failure instanceof Error ? failure.message : failure ? 'The action could not be completed.' : success, !!failure);
}
el('create').onclick = () => void run(() => controller!.wallet.create(), controller!.network.config.sponsorship.mode === 'self-funded' ? 'Keys created. Fund the displayed address with Arc test USDC, refresh, then activate.' : 'Keys created. Activate your account to begin.');
el('activate').onclick = () => void run(() => controller!.wallet.register(), 'Account activation confirmed.');
el('refresh').onclick = () => void run(async () => {}, 'Wallet state refreshed.');
el('send-form').onsubmit = event => { event.preventDefault(); void run(async () => {
  const recipient = asAddress(el<HTMLInputElement>('recipient').value.trim().toLowerCase());
  const amount = el<HTMLInputElement>('amount').value.trim();
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(amount)) throw new Error('Enter a positive USDC amount with at most 18 decimal places');
  return controller!.prepareTransfer(recipient, parseUnits(amount, 18));
}, 'Review the recipient and amount before approving.'); };
el('approve').onclick = () => void run(async () => { const r = await controller!.store.read(); if (!r?.pending) throw new Error('No prepared request'); return controller!.wallet.signUserOperation(encodeOperation(r.pending.operation)); }, 'Signed locally. Submit when ready.');
el('submit').onclick = () => void run(() => controller!.submitPending(), 'Request submitted. Refresh to check confirmation.');
el('abandon').onclick = () => void run(() => controller!.abandonExpired(), 'Request discarded. Previously used signing capacity remains used.');
const dialog = el<HTMLDialogElement>('confirm');
for (const [id, text, action] of [
  ['rotate', 'Activate the next key and keep the same account address.', () => controller!.wallet.rotate()],
  ['disable', 'Schedule this key to stop working 30 days after confirmation. This requires a PQ signature.', () => controller!.wallet.disable()],
  ['takeover', 'Use your stored next key to take over this disabled account.', () => controller!.takeover()],
] as const) el(id).onclick = () => { nextAction = action; el('confirm-text').textContent = text; dialog.showModal(); };
el('confirm-action').onclick = () => { dialog.close(); if (nextAction) void run(nextAction, 'Key-management operation confirmed.'); };
async function start(): Promise<void> {
  try {
    const response = await fetch('/account-config.json'); if (!response.ok) throw new Error('Smart-account deployment and bundler have not been configured yet. The separate local demo remains available.');
    if (!navigator.locks || !indexedDB) throw new Error('This browser needs IndexedDB and Web Locks');
    const config = parseAccountConfig(await response.json());
    const network = new ArcChainAdapter(config); await network.check();
    const id = `opaque-pq-account-v07-${config.chainId}-${config.factory}`;
    controller = new AccountWalletController(network, new IndexedDbSignerStore(`${id}-keys`), new IndexedDbAccountStore(`${id}-outbox`),
      run => navigator.locks.request(id, run));
    el('network').textContent = config.chainId === 5042002 ? 'Arc Testnet' : 'Local chain test';
    el('funding').textContent = config.sponsorship.mode === 'sponsored' ? 'Network fees are sponsored, subject to availability.' : 'You pay network fees from this wallet. Fund this address before activation and keep USDC for future fees. Approval signs the configured gas budget before simulation; even a rejected simulation uses one signing slot.';
    await render(); notice('Account network verified. Your PQ keys stay in this browser.');
  } catch (error) { disabled(true); el('network').textContent = 'Not connected'; notice(error instanceof Error ? error.message : 'Account network unavailable', true); }
}
void start();
