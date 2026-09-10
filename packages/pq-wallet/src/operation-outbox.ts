import type { Address, Bytes32, Hex } from '@opaque/protocol-types';
import { asAddress, asBytes32 } from '@opaque/protocol-types/codecs.js';
import { accountDigest, operationHash, type PackedOperation, type OperationContext } from './user-operation.ts';
import type { OperationReceipt } from './bundler-client.ts';
import { unsafeState } from './signer-state.ts';

export interface PendingOperation {
  phase: 'prepared' | 'signed' | 'submitted' | 'unknown' | 'confirmed' | 'failed';
  operation: PackedOperation; context: OperationContext; digest: Bytes32; hash: Bytes32;
  signer: Bytes32; signature?: Hex; receipt?: OperationReceipt;
  replacement?: { next: Bytes32; deadline: bigint };
}
export interface AccountRecord {
  version: 1; revision: bigint; configId: Bytes32; account: Address; active: Bytes32; next: Bytes32;
  salt: Bytes32; initialDeadline: bigint; initialActive: Bytes32; initialNext: Bytes32;
  epoch: bigint; lastBlock: bigint; chainCount: bigint; registered: boolean;
  pending?: PendingOperation; abandoned?: PendingOperation[]; history: OperationReceipt[];
}
export function validateAccountRecord(r: AccountRecord): void {
  try {
    if (!r || r.version !== 1 || typeof r.registered !== 'boolean' ||
        [r.revision, r.epoch, r.lastBlock, r.chainCount, r.initialDeadline].some(n => typeof n !== 'bigint' || n < 0n) ||
        r.chainCount > 8n || !Array.isArray(r.history)) throw unsafeState();
    asAddress(r.account);
    for (const n of [r.configId, r.active, r.next, r.initialActive, r.initialNext, r.salt]) asBytes32(n);
    if (r.active === r.next) throw unsafeState();
    const p = r.pending;
    if (p) {
      if (!['prepared', 'signed', 'submitted', 'unknown', 'confirmed', 'failed'].includes(p.phase) || p.operation.sender.toLowerCase() !== r.account.toLowerCase() ||
          p.hash !== operationHash(p.operation, p.context.entryPoint, p.context.chainId) || p.digest !== accountDigest(p.operation, p.context)) throw unsafeState();
      if (p.phase !== 'prepared' && (!p.signature || p.operation.signature === '0x')) throw unsafeState();
      if (p.receipt && p.receipt.userOpHash !== p.hash) throw unsafeState();
    }
  } catch { throw unsafeState(); }
}
export interface AccountStore {
  read(): Promise<AccountRecord | undefined>;
  write(expectedRevision: bigint | undefined, record: AccountRecord): Promise<void>;
}
function validateWrite(before: AccountRecord | undefined, revision: bigint | undefined, after: AccountRecord): void {
  validateAccountRecord(after);
  if (before?.revision !== revision || after.revision !== (revision === undefined ? 0n : revision + 1n)) throw unsafeState();
  if (before && (before.configId !== after.configId || before.account !== after.account || after.lastBlock < before.lastBlock || after.epoch < before.epoch ||
      (after.epoch === before.epoch && after.chainCount < before.chainCount))) throw unsafeState();
}
export class MemoryAccountStore implements AccountStore {
  private record: AccountRecord | undefined;
  async read(): Promise<AccountRecord | undefined> { return this.record && structuredClone(this.record); }
  async write(revision: bigint | undefined, record: AccountRecord): Promise<void> {
    validateWrite(this.record, revision, record); this.record = structuredClone(record);
  }
}
/** Separate durable account/outbox database; existing signer records are never migrated. */
export class IndexedDbAccountStore implements AccountStore {
  readonly name: string; readonly factory: IDBFactory;
  constructor(name: string, factory: IDBFactory = indexedDB) { this.name = name; this.factory = factory; }
  private async open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.factory.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('account');
      request.onerror = () => reject(unsafeState());
      let blocked = false;
      request.onblocked = () => { blocked = true; reject(unsafeState()); };
      request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    });
  }
  async read(): Promise<AccountRecord | undefined> {
    const db = await this.open();
    try { return await new Promise((resolve, reject) => {
      const tx = db.transaction('account', 'readonly'); const request = tx.objectStore('account').get('wallet');
      let record: AccountRecord | undefined;
      request.onsuccess = () => { try { record = request.result; if (record) validateAccountRecord(record); } catch { tx.abort(); } };
      tx.oncomplete = () => resolve(record); tx.onabort = () => reject(unsafeState());
    }); } finally { db.close(); }
  }
  async write(revision: bigint | undefined, record: AccountRecord): Promise<void> {
    const db = await this.open();
    try { await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('account', 'readwrite', { durability: 'strict' }); const store = tx.objectStore('account'); const request = store.get('wallet');
      request.onsuccess = () => { try { validateWrite(request.result, revision, record); store.put(record, 'wallet'); } catch { tx.abort(); } };
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(unsafeState());
    }); } finally { db.close(); }
  }
}
