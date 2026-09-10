import type { Address, Bytes32, Hex, PqWalletState } from '@opaque/protocol-types';
import { toHex } from '@opaque/protocol-types/codecs.js';
import { IndexedDbSignerStore } from '../src/indexeddb-store.ts';
import { createPqWallet } from '../src/wallet.ts';
import { MockWalletChain, mockWalletOptions } from '../src/mock.ts';
import type { SignedOutput, SignerStore } from '../src/signer-state.ts';
import type { WalletStateStore } from '../src/wallet-state.ts';

const ID = 'opaque-browser-demo-v1';
type Event =
  | { kind: 'register'; account: Address; active: Bytes32; next: Bytes32; max: bigint; deadline: bigint }
  | { kind: 'submit'; account: Address; encoded: Hex; signed: SignedOutput }
  | { kind: 'rotate'; account: Address; next: Bytes32; max: bigint; deadline: bigint; signed: SignedOutput }
  | { kind: 'disable'; account: Address; signed: SignedOutput }
  | { kind: 'advance' };
interface Journal {
  version: 1;
  events: Event[];
  pending?: { encoded: Hex; signed: SignedOutput };
}
export interface DemoView {
  wallet: PqWalletState | undefined;
  registered: boolean;
  disableAfter: bigint;
  now: bigint;
  pending: SignedOutput | undefined;
  activity: string[];
}
export type DemoAction = 'refresh' | 'create' | 'register' | 'sign' | 'submit' | 'rotate' | 'disable' | 'advance';
export interface DemoEnvironment {
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  lock<T>(run: () => Promise<T>): Promise<T>;
  openStore(): SignerStore & WalletStateStore & { close(): Promise<void> };
}
const labels: Record<Event['kind'], string> = { register: 'Wallet activated on the demo network',
  submit: 'Signed action accepted by the demo network', rotate: 'Signing key rotated',
  disable: 'Key disable scheduled', advance: 'Demo clock advanced by 30 days' };

/** Public simulation events only. Signer seeds and encryption keys never enter this journal. */
function loadJournal(storage: DemoEnvironment['storage']): Journal {
  const raw = storage.getItem(ID);
  if (!raw) return { version: 1, events: [] };
  const parsed: Journal = JSON.parse(raw, (_, value: unknown) => {
    if (value && typeof value === 'object' && '$bigint' in value) {
      const n = (value as { $bigint: unknown }).$bigint;
      if (typeof n !== 'string' || !/^(0|[1-9][0-9]*)$/.test(n)) throw new Error('Invalid demo history');
      return BigInt(n);
    }
    return value;
  });
  if (parsed.version !== 1 || !Array.isArray(parsed.events)) throw new Error('Invalid demo history');
  return parsed;
}
function saveJournal(journal: Journal, storage: DemoEnvironment['storage']): void {
  storage.setItem(ID, JSON.stringify(journal, (_, value: unknown) => typeof value === 'bigint' ? { $bigint: value.toString() } : value));
}

async function replay(chain: MockWalletChain, event: Event): Promise<void> {
  switch (event.kind) {
    case 'register': await chain.register(event.account, event.active, event.next, event.max, event.deadline); break;
    case 'rotate': await chain.rotate(event.account, event.next, event.max, event.deadline, event.signed); break;
    case 'disable': await chain.disable(event.account, event.signed); break;
    case 'advance': chain.now += 30n * 24n * 60n * 60n; break;
    case 'submit':
      await chain.prepareUserOperation(event.encoded, await chain.observe(event.account), 'FORS+C/keccak256/k=32,a=8');
      await chain.acceptUserOperation(event.signed); break;
    default: throw new Error('Unknown demo history entry');
  }
}

/** Serializes both the simulated chain journal and wallet commands across tabs. */
export async function runDemo(action: DemoAction, message = '', suppliedEnvironment?: DemoEnvironment): Promise<DemoView> {
  if (!suppliedEnvironment && (!navigator.locks || !globalThis.indexedDB)) throw new Error('This wallet needs a browser with IndexedDB and Web Locks.');
  const environment = suppliedEnvironment ?? { storage: localStorage,
    lock: <T>(run: () => Promise<T>): Promise<T> => navigator.locks.request(ID, run), openStore: () => new IndexedDbSignerStore(ID) };
  return environment.lock(async () => {
    const store = environment.openStore();
    try {
      const journal = loadJournal(environment.storage);
      const chain = new MockWalletChain();
      for (const event of journal.events) await replay(chain, event);
      const adapter = {
        mode: chain.mode,
        deriveAccount: chain.deriveAccount.bind(chain), observe: chain.observe.bind(chain),
        prepareUserOperation: chain.prepareUserOperation.bind(chain), verifyUserOperationBinding: chain.verifyUserOperationBinding.bind(chain),
        async register(account: Address, active: Bytes32, next: Bytes32, max: bigint, deadline: bigint) {
          const tx = await chain.register(account, active, next, max, deadline);
          journal.events.push({ kind: 'register', account, active, next, max, deadline }); return tx;
        },
        async rotate(account: Address, next: Bytes32, max: bigint, deadline: bigint, signed: SignedOutput) {
          const tx = await chain.rotate(account, next, max, deadline, signed);
          journal.events.push({ kind: 'rotate', account, next, max, deadline, signed }); delete journal.pending; return tx;
        },
        async disable(account: Address, signed: SignedOutput) {
          const tx = await chain.disable(account, signed);
          journal.events.push({ kind: 'disable', account, signed }); delete journal.pending; return tx;
        },
      };
      const wallet = createPqWallet({ ...mockWalletOptions(chain), chain: adapter, walletId: ID, signerStore: store, walletStore: store });
      if (action === 'create') await wallet.create();
      const existing = await store.readWallet(ID);
      if (!existing) {
        if (action !== 'refresh') throw new Error('Create a wallet first.');
        return { wallet: undefined, registered: false, disableAfter: 0n, now: chain.now, pending: undefined, activity: [] };
      }
      switch (action) {
        case 'register': await wallet.register(); break;
        case 'sign': {
          if (!message.trim() || message.length > 500) throw new Error('Enter an action between 1 and 500 characters.');
          const encoded = toHex(new TextEncoder().encode(message));
          journal.pending = { encoded, signed: await wallet.signUserOperation(encoded) }; break;
        }
        case 'submit': {
          if (!journal.pending) throw new Error('Sign an action first.');
          const state = await wallet.getState(); const pending = journal.pending;
          await chain.prepareUserOperation(pending.encoded, await chain.observe(state.accountAddress), 'FORS+C/keccak256/k=32,a=8');
          await chain.acceptUserOperation(pending.signed);
          journal.events.push({ kind: 'submit', account: state.accountAddress, ...pending }); delete journal.pending; break;
        }
        case 'rotate': await wallet.rotate(); break;
        case 'disable': await wallet.disable(); break;
        case 'advance': chain.now += 30n * 24n * 60n * 60n; journal.events.push({ kind: 'advance' }); delete journal.pending; break;
      }
      // Commit public network facts before reconciling local chain counters.
      saveJournal(journal, environment.storage);
      const state = await wallet.getState(); const observation = await chain.observe(state.accountAddress);
      return { wallet: state, registered: !!observation.state, disableAfter: observation.state?.disableAfter ?? 0n,
        now: chain.now, pending: journal.pending?.signed, activity: journal.events.map(e => labels[e.kind]).reverse().slice(0, 6) };
    } finally { await store.close(); }
  });
}
