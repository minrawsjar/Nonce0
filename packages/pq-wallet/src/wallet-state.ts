import type { Address, Bytes32 } from '@opaque/protocol-types';
import { asAddress, asBytes32 } from '@opaque/protocol-types/codecs.js';
import { unsafeState } from './signer-state.ts';
import { uint64 } from './registry.ts';

export interface WalletRecord {
  readonly version: 1;
  readonly revision: bigint;
  readonly accountAddress: Address;
  readonly authorityId: Bytes32;
  readonly active: Bytes32;
  readonly next: Bytes32;
  readonly rotationDeadline: bigint;
  readonly lastChainUseCount: bigint;
  readonly lastObservedBlock: bigint;
  readonly registered: boolean;
  readonly pendingRotation?: { readonly next: Bytes32; readonly deadline: bigint };
}
export interface WalletStateStore {
  readWallet(id: string): Promise<WalletRecord | undefined>;
  compareAndSwapWallet(id: string, revision: bigint | undefined, record: WalletRecord): Promise<boolean>;
}
export function validateWalletRecord(record: WalletRecord): void {
  try {
    if (!record || record.version !== 1 || typeof record.revision !== 'bigint' || record.revision < 0n ||
        typeof record.registered !== 'boolean' || typeof record.lastObservedBlock !== 'bigint' || record.lastObservedBlock < 0n) throw unsafeState();
    asAddress(record.accountAddress); asBytes32(record.authorityId); asBytes32(record.active); asBytes32(record.next);
    uint64(record.rotationDeadline); uint64(record.lastChainUseCount);
    if (record.active === record.next) throw unsafeState();
    if (record.pendingRotation) { asBytes32(record.pendingRotation.next); uint64(record.pendingRotation.deadline); }
  } catch { throw unsafeState(); }
}
export function validateWalletTransition(before: WalletRecord | undefined, after: WalletRecord): void {
  validateWalletRecord(after);
  if (!before) { if (after.revision !== 0n) throw unsafeState(); return; }
  validateWalletRecord(before);
  if (after.revision !== before.revision + 1n || after.accountAddress !== before.accountAddress || after.authorityId !== before.authorityId ||
      after.lastObservedBlock < before.lastObservedBlock || (before.registered && !after.registered)) throw unsafeState();
  if (after.active === before.active) {
    if (after.next !== before.next || after.lastChainUseCount < before.lastChainUseCount ||
        (before.pendingRotation && (after.pendingRotation?.next !== before.pendingRotation.next ||
          after.pendingRotation.deadline !== before.pendingRotation.deadline))) throw unsafeState();
  } else if (!before.pendingRotation || after.active !== before.next || after.next !== before.pendingRotation.next || after.pendingRotation) {
    throw unsafeState();
  }
}
export class MemoryWalletStateStore implements WalletStateStore {
  #records = new Map<string, WalletRecord>();
  async readWallet(id: string): Promise<WalletRecord | undefined> {
    const current = this.#records.get(id); return current && structuredClone(current);
  }
  async compareAndSwapWallet(id: string, revision: bigint | undefined, record: WalletRecord): Promise<boolean> {
    const before = this.#records.get(id);
    if (before?.revision !== revision) return false;
    validateWalletTransition(before, record); this.#records.set(id, structuredClone(record)); return true;
  }
}
