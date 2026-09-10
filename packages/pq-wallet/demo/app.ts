import { runDemo, type DemoAction, type DemoView } from './adapter.ts';

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let view: DemoView | undefined;
let busy = false;
const messages: Partial<Record<DemoAction, string>> = {
  create: 'Wallet created. Activate it on the demo network to begin.', register: 'Your demo wallet is active.',
  sign: 'Action signed. Its signing capacity is now reserved.', submit: 'The demo network accepted your signed action.',
  rotate: 'Key rotated. Your new signing key is active.', disable: 'Key disable scheduled. The 30-day demo waiting period has started.',
  advance: 'The demo clock advanced by 30 days.',
};
function notice(message: string, error = false): void {
  const box = element('notice'); box.textContent = message; box.className = error ? 'error' : ''; box.hidden = false;
}
function render(): void {
  const state = view?.wallet;
  element('empty').hidden = !!state; element('wallet').hidden = !state;
  const disabled = !!view?.disableAfter && view.now >= view.disableAfter;
  const usable = !!state?.active && !!view?.registered;
  element<HTMLButtonElement>('create').disabled = busy;
  element<HTMLButtonElement>('sign').disabled = busy || !usable || state!.localSigningReservations >= state!.maxUses - 2n;
  element<HTMLButtonElement>('rotate').disabled = busy || !usable;
  element<HTMLButtonElement>('disable').disabled = busy || !usable || !!view?.disableAfter;
  element<HTMLButtonElement>('copy').disabled = busy || !state;
  element<HTMLTextAreaElement>('message').disabled = busy || !usable;
  element<HTMLButtonElement>('register').disabled = busy;
  element('register').hidden = !state || !!view?.registered;
  element<HTMLButtonElement>('submit').disabled = busy || !usable;
  element<HTMLButtonElement>('advance').disabled = busy;
  const status = element('status');
  status.textContent = disabled ? 'Disabled' : view?.disableAfter ? 'Disable scheduled' : view?.registered ? state?.active ? 'Active' : 'Capacity used' : state ? 'Not activated' : 'Not created';
  status.className = `pill${usable && !view?.disableAfter ? ' active' : view?.disableAfter ? ' warning' : ''}`;
  if (state) {
    element('address').textContent = state.accountAddress;
    const remaining = state.maxUses - state.localSigningReservations - 2n;
    element('available').textContent = String(remaining > 0n ? remaining : 0n);
    element('epoch').textContent = String(state.keyEpoch + 1n).padStart(2, '0');
    element('local-count').textContent = `${state.localSigningReservations} / ${state.maxUses}`;
    element('chain-count').textContent = String(state.chainUseCount);
    const budget = element('budget'); budget.replaceChildren();
    for (let i = 0; i < Number(state.maxUses); i++) {
      const slot = document.createElement('i'); slot.className = i < Number(state.localSigningReservations) ? 'used' : i >= Number(state.maxUses) - 2 ? 'reserved' : '';
      slot.setAttribute('aria-hidden', 'true'); budget.append(slot);
    }
    budget.setAttribute('aria-label', `${state.localSigningReservations} of ${state.maxUses} signing slots used`);
  }
  element('signed').hidden = !view?.pending;
  if (view?.pending) {
    element('digest').textContent = view.pending.digest;
    element('signature-size').textContent = `${((view.pending.signature.length - 2) / 2).toLocaleString()} bytes`;
  }
  element('sign-help').textContent = disabled ? 'This key is disabled. Recovery is not available in this demo.'
    : usable ? 'Signing happens locally. Submitting updates the simulated network.' : 'Create and activate a wallet to sign your first action.';
  element('timelock').hidden = !view?.disableAfter;
  element('timelock-text').textContent = disabled ? 'The waiting period has elapsed. This key is now disabled.' : 'Disable is scheduled. The current key still works during the waiting period.';
  element('advance').hidden = disabled;
  const activity = element('activity'); activity.replaceChildren();
  for (const message of view?.activity.length ? view.activity : ['Your demo transactions will appear here.']) {
    const item = document.createElement('li'); item.textContent = message;
    if (!view?.activity.length) item.className = 'no-activity'; activity.append(item);
  }
  document.body.setAttribute('aria-busy', String(busy));
}
async function act(action: DemoAction): Promise<boolean> {
  if (busy) return false;
  busy = true; render();
  if (action !== 'refresh') notice(action === 'create' ? 'Generating your signing keys…' : 'Working on your wallet…');
  // Let the browser paint before the synchronous cryptographic computation starts.
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  try {
    view = await runDemo(action, element<HTMLTextAreaElement>('message').value);
    if (messages[action]) notice(messages[action]!);
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    notice(code === 'SIGNER_STATE_UNSAFE' ? 'The stored wallet state could not be safely restored. No new signature was issued. Do not reset or restore an old backup.'
      : code === 'KEY_EXHAUSTED' ? 'There is no signing capacity for this action. Rotate the key while lifecycle capacity remains.'
      : error instanceof Error ? error.message : 'This action could not be completed.', true);
    return false;
  } finally { busy = false; render(); }
}
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
  button.addEventListener('click', () => void act(button.dataset['action'] as DemoAction));
}
element('copy').addEventListener('click', async () => {
  if (!view?.wallet) return;
  try { await navigator.clipboard.writeText(view.wallet.accountAddress); notice('Wallet address copied.'); }
  catch { notice('Copy is unavailable. Select the address to copy it manually.', true); }
});
const dialog = element<HTMLDialogElement>('disable-dialog');
element('disable').addEventListener('click', () => dialog.showModal());
element('confirm-disable').addEventListener('click', () => { dialog.close(); void act('disable'); });
window.addEventListener('focus', () => { if (!busy) void act('refresh'); });
window.addEventListener('storage', () => { if (!busy) void act('refresh'); });
void act('refresh');

// Optional page-scoped tooling; ordinary browsers use the visible controls.
type ModelContext = {
  registerTool(tool: {
    name: string; description: string; inputSchema: object;
    annotations: { readOnlyHint: boolean };
    execute(input: unknown): Promise<unknown>;
  }, options: { signal: AbortSignal }): void | Promise<void>;
};
const context = (document as Document & { modelContext?: ModelContext }).modelContext;
if (context?.registerTool) {
  const lifecycle = new AbortController();
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  try {
    void Promise.resolve(context.registerTool({
      name: 'create_demo_wallet',
      description: 'Create a local demo wallet and show it on this page. Uses browser storage; no real funds or network registration.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false },
      async execute(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) {
          throw new Error('Expected an empty object.');
        }
        if (busy) throw new Error('Wallet is busy. Retry after the current action completes.');
        if (!await act('create') || !view?.wallet) throw new Error('Wallet creation failed; see the page for details.');
        return { mode: 'MOCK', accountAddress: view.wallet.accountAddress, registered: view.registered };
      },
    }, { signal: lifecycle.signal })).catch(() => { /* Optional browser capability. */ });
  } catch { /* Unsupported implementations leave the visible controls available. */ }
}
