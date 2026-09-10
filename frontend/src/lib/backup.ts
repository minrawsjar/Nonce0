// A backup of everything this browser holds that is money: the PQ account's
// keys, with their signing logs, and the private notes. Encrypted under a
// passphrase before it leaves the page, because both are bearer secrets.
//
// Restore writes into a NEW key store and points the page at it; it never
// overwrites keys the browser already holds. A backup older than the account's
// chain state restores, and then the wallet refuses to sign with it: its
// signing log is behind the chain, and signing from it could use an index
// twice. Restore on one device at a time, for the same reason.

import type { Bytes32 } from '@opaque/protocol-types';
import { fromHex, toHex } from '@opaque/protocol-types/codecs.js';

import { IndexedDbSignerStore } from '../../../packages/pq-wallet/src/indexeddb-store.ts';
import { exportSigner, restoreSigner, type ExportedSigner } from '../../../packages/pq-wallet/src/signer-state.ts';
import type { WalletRecord } from '../../../packages/pq-wallet/src/wallet-state.ts';

export const WALLET_ID = 'opaque-account';
export const NOTES_KEY = 'opaque:notes:v1';
const STORE_POINTER = 'opaque:pq-account-db';
const DEFAULT_STORE = 'opaque-pq-account-v1';
const FORMAT = 'opaque-backup-v1';
const ITERATIONS = 600_000;

/** Which IndexedDB this browser's account lives in: the default, or the last restore. */
export const keyStoreName = (): string => {
  try { return localStorage.getItem(STORE_POINTER) ?? DEFAULT_STORE; } catch { return DEFAULT_STORE; }
};

interface Contents {
  readonly version: 1;
  readonly wallet: WalletRecord;
  readonly signers: readonly ExportedSigner[];
  readonly notes: string;
}

const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v);
const reviver = (_k: string, v: unknown) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
const utf8 = (s: string) => new TextEncoder().encode(s);

async function keyFrom(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (passphrase.length < 12) throw new Error('use a passphrase of at least 12 characters');
  const base = await crypto.subtle.importKey('raw', utf8(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** The encrypted backup, as a file to save. */
export async function exportBackup(store: IndexedDbSignerStore, passphrase: string): Promise<Blob> {
  const wallet = await store.readWallet(WALLET_ID);
  if (wallet === undefined) throw new Error('this browser holds no account to back up');
  const ids = [wallet.active, wallet.next, ...(wallet.pendingRotation ? [wallet.pendingRotation.next] : [])] as Bytes32[];
  const contents: Contents = {
    version: 1, wallet,
    signers: await Promise.all(ids.map((id) => exportSigner(store, id))),
    notes: localStorage.getItem(NOTES_KEY) ?? '{}',
  };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(passphrase, salt),
    utf8(JSON.stringify(contents, replacer))));
  return new Blob([JSON.stringify({
    format: FORMAT, kdf: { name: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: toHex(salt) }, iv: toHex(iv), ciphertext: toHex(ciphertext),
  })], { type: 'application/json' });
}

/**
 * Restores a backup into a fresh key store and merges its notes; the caller
 * reloads the page to open it. Returns how many notes were new here.
 */
export async function restoreBackup(file: Blob, passphrase: string): Promise<number> {
  const outer = JSON.parse(await file.text()) as { format?: string; kdf?: { iterations?: number; salt?: string }; iv?: string; ciphertext?: string };
  if (outer.format !== FORMAT || outer.kdf?.iterations !== ITERATIONS) throw new Error('this is not an Opaque backup');
  let contents: Contents;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(fromHex(outer.iv as `0x${string}`)) },
      await keyFrom(passphrase, new Uint8Array(fromHex(outer.kdf.salt as `0x${string}`))), new Uint8Array(fromHex(outer.ciphertext as `0x${string}`)));
    contents = JSON.parse(new TextDecoder().decode(plain), reviver) as Contents;
  } catch {
    throw new Error('wrong passphrase, or the file is damaged');
  }

  const name = `${DEFAULT_STORE}-restored-${Date.now()}`;
  const store = new IndexedDbSignerStore(name);
  try {
    for (const signer of contents.signers) await restoreSigner(store, signer);
    if (!await store.compareAndSwapWallet(WALLET_ID, undefined, { ...contents.wallet, revision: 0n })) throw new Error('could not write the restored account');
  } finally { await store.close(); }

  // Notes this browser does not have are added; ones it has keep their local state.
  const here = JSON.parse(localStorage.getItem(NOTES_KEY) ?? '{}', reviver) as Record<string, unknown>;
  const incoming = JSON.parse(contents.notes, reviver) as Record<string, unknown>;
  let added = 0;
  for (const [id, note] of Object.entries(incoming)) if (!(id in here)) { here[id] = note; added++; }
  localStorage.setItem(NOTES_KEY, JSON.stringify(here, replacer));
  localStorage.setItem(STORE_POINTER, name);
  return added;
}
