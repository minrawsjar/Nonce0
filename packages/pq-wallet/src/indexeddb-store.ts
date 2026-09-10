import { ProtocolFailure, type Bytes32 } from '@opaque/protocol-types';
import { asBytes32 } from '@opaque/protocol-types/codecs.js';
import { validateSignerRecord, validateTransition, unsafeState, type SignerRecord, type SignerStore } from './signer-state.ts';
import { validateWalletRecord, validateWalletTransition, type WalletRecord, type WalletStateStore } from './wallet-state.ts';

const safeError = (error: unknown): ProtocolFailure => error instanceof ProtocolFailure ? error : unsafeState();

/** One read-write transaction covers the entire read/validate/append/write operation. */
export class IndexedDbSignerStore implements SignerStore, WalletStateStore {
  #name: string;
  #factory: IDBFactory;
  #connection: Promise<IDBDatabase> | undefined;

  constructor(name: string, factory: IDBFactory = globalThis.indexedDB) {
    if (!name || !factory) throw unsafeState();
    this.#name = name; this.#factory = factory;
  }

  async #open(): Promise<IDBDatabase> {
    if (!this.#connection) {
      this.#connection = new Promise((resolve, reject) => {
        const request = this.#factory.open(this.#name, 1);
        let blocked = false;
        request.onupgradeneeded = () => { request.result.createObjectStore('signers'); request.result.createObjectStore('wallets'); };
        request.onerror = () => { this.#connection = undefined; reject(unsafeState()); };
        request.onblocked = () => { blocked = true; this.#connection = undefined; reject(unsafeState()); };
        request.onsuccess = () => {
          const db = request.result;
          if (blocked) { db.close(); return; }
          db.onversionchange = () => { db.close(); this.#connection = undefined; };
          resolve(db);
        };
      });
    }
    return this.#connection;
  }

  async read(id: Bytes32): Promise<SignerRecord | undefined> {
    asBytes32(id);
    try {
      const db = await this.#open();
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('signers', 'readonly');
        const request = transaction.objectStore('signers').get(id);
        let record: SignerRecord | undefined;
        let failure: unknown;
        request.onsuccess = () => {
          try {
            record = request.result;
            if (record !== undefined) validateSignerRecord(record, id);
          } catch (error) { failure = error; transaction.abort(); }
        };
        transaction.oncomplete = () => resolve(record);
        transaction.onabort = () => reject(safeError(failure));
        transaction.onerror = () => { /* onabort settles the promise */ };
      });
    } catch (error) { throw safeError(error); }
  }

  async transact<T>(id: Bytes32, update: (current: SignerRecord | undefined) => { record: SignerRecord; result: T }): Promise<T> {
    asBytes32(id);
    try {
      const db = await this.#open();
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('signers', 'readwrite', { durability: 'strict' });
        const objectStore = transaction.objectStore('signers');
        const request = objectStore.get(id);
        let result: T;
        let failure: unknown;
        request.onsuccess = () => {
          try {
            const before: SignerRecord | undefined = request.result;
            // A detached clone prevents mutation of the baseline used for transition validation.
            const change = update(before && structuredClone(before));
            validateTransition(before, change.record, id);
            result = structuredClone(change.result);
            objectStore.put(change.record, id);
          } catch (error) { failure = error; transaction.abort(); }
        };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(safeError(failure));
        transaction.onerror = () => { /* onabort settles the promise */ };
      });
    } catch (error) { throw safeError(error); }
  }

  async readWallet(id: string): Promise<WalletRecord | undefined> {
    try {
      const db = await this.#open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('wallets', 'readonly');
        const request = tx.objectStore('wallets').get(id);
        let record: WalletRecord | undefined;
        request.onsuccess = () => {
          try { record = request.result; if (record !== undefined) validateWalletRecord(record); }
          catch { tx.abort(); }
        };
        tx.oncomplete = () => resolve(record);
        tx.onabort = () => reject(unsafeState());
      });
    } catch (error) { throw safeError(error); }
  }

  async compareAndSwapWallet(id: string, revision: bigint | undefined, record: WalletRecord): Promise<boolean> {
    try {
      const db = await this.#open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('wallets', 'readwrite', { durability: 'strict' });
        const objectStore = tx.objectStore('wallets');
        const request = objectStore.get(id);
        let written = false;
        request.onsuccess = () => {
          try {
            const before: WalletRecord | undefined = request.result;
            if (before?.revision !== revision) return;
            validateWalletTransition(before, record);
            objectStore.put(record, id); written = true;
          } catch { tx.abort(); }
        };
        tx.oncomplete = () => resolve(written);
        tx.onabort = () => reject(unsafeState());
      });
    } catch (error) { throw safeError(error); }
  }

  async close(): Promise<void> {
    const connection = this.#connection; this.#connection = undefined;
    if (connection) (await connection).close();
  }
}
