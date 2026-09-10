// The wallet's composition root: every port the payment application needs,
// built from the running stack's config. The page imports this and the barrel.
//
// Where each piece comes from — and the one rule that matters most:
//
//   relay keys   the SIGNED directory, walked from a root compiled into this
//                build (deployments/arc-testnet.json) before a single relay
//                is contacted. Never a root from the network.
//   ring         a mesh query, answered at the exit: members from the pool's
//                own events, their §8.1 weights from the subgraph.
//   relay health a mesh query too (the subgraph, via the exit), clamped.
//   proof        built HERE, in a Web Worker of this page: the note secret
//                never leaves the origin, and the tab does not freeze.
//   account and  WALLET_RPC through the mesh: the account's registry state,
//   note reads   balances, nonce, a note's nullifier, the pool's capabilities.
//                No RPC or bundler learns which wallet asked.
//   funding      the wallet's transactions, and the reads they need, through
//   wallet       its own provider. The page opens no connection to an RPC.
//   intent       sealed here to the CRE key, then chunked across the mesh.
//   status       a mesh query. The page never opens a connection to the exit.
//   account      LIVE on Arc: FORS keys in IndexedDB, the account deployed by
//                PQAccountFactory. The funding wallet only pays for that.
//   deposit      from the account once activated (a UserOperation its PQ key
//                signs), from the funding wallet before. Attributable either way.

import type {
  CredentialHandle,
  Hex,
  IntentRef,
  IntentStatus,
  PoolScope,
  PrivacyConditions,
  RelayPath,
  RelaySnapshot,
  RingSnapshot,
  StatusHandle,
  TxHash,
} from '@opaque/protocol-types';

import { createMeshBootstrap } from '../../../backend/mesh/bootstrap.ts';
import { chainTo } from '../../../backend/mesh/directory.ts';
import { createGraphHealth } from '../../../backend/mesh/graph-health.ts';
import type { DirectoryTrustRoot, SignedDirectory } from '../../../backend/mesh/contracts.ts';
import { createIntentSealer } from '../../../backend/cre/seal-client.ts';
import { ARC_AUTHORITY, createLivePqWallet, createPqAccountOps } from '../../../backend/chain/pq-wallet-chain.ts';
import { browserPayer, createBrowserPool, createMeshChainObserver } from '../../../backend/chain/wallet-chain.ts';
import { capabilitiesOf } from '../../../backend/chain/pool.ts';
import { readOne, type WalletRpcSend } from '../../../backend/chain/wallet-rpc.ts';
import { MarkovPathPolicy } from '../../../graph/src/path-policy.ts';
import { createNoteVault, createRingClient } from '../../../packages/ring-client/src/index.ts';
import { IndexedDbSignerStore } from '../../../packages/pq-wallet/src/indexeddb-store.ts';
import { deployment, meshTrustRoot } from '../../../deployments/index.ts';
import { exportBackup, keyStoreName, restoreBackup } from './backup.ts';
import { createWorkerProver } from './prover.ts';
import { createPaymentApplication, type AdapterPorts } from './protocol/index.ts';
import { localNoteStorage } from './note-storage.ts';

export interface StackConfig {
  /** From the pinned root to the directory in force. Older stacks sent only signedDirectory. */
  readonly directoryChain?: readonly SignedDirectory[];
  readonly signedDirectory: SignedDirectory;
  /** A dev server's root, for its random mesh. A built wallet never reads it. */
  readonly trustRoot: DirectoryTrustRoot;
  readonly cre: { readonly publicKey: `0x${string}`; readonly encryptionKeyId: string; readonly policyVersion: string };
  readonly credentialUrl: string;
  readonly pool: { readonly address: `0x${string}`; readonly denomination: number; readonly proofMode: string };
  readonly capabilities: { readonly pqWallet: 'MOCK' | 'LIVE'; readonly graph: 'LIVE' | 'FIXTURE'; readonly confidentialExecution: 'ATTESTED' | 'SIMULATED'; readonly policyScope: 'CRE_WORKFLOW_ONLY' };
}

const reviver = (_k: string, v: unknown) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);

const ROOT_KEY = 'opaque:mesh-root:v1';
/** The compiled-in root, or a later one this browser has already walked to. */
function pinnedRoot(): DirectoryTrustRoot {
  const compiled = meshTrustRoot() as DirectoryTrustRoot;
  try {
    const stored = JSON.parse(localStorage.getItem(ROOT_KEY) ?? 'null', reviver) as { root: DirectoryTrustRoot; from: string } | null;
    // Honoured only if walked from THIS build's root, and only forward of it:
    // a floor, never a way around the pin. A build with a new root starts over.
    if (stored !== null && stored.from === compiled.signerCommitment && typeof stored.root.minVersion === 'bigint'
      && stored.root.minVersion > compiled.minVersion && /^0x[0-9a-f]{64}$/.test(stored.root.signerCommitment)) return stored.root;
  } catch { /* unreadable storage falls back to the compiled root */ }
  return compiled;
}
function savePinnedRoot(root: DirectoryTrustRoot): void {
  const entry = { root, from: meshTrustRoot().signerCommitment };
  try { localStorage.setItem(ROOT_KEY, JSON.stringify(entry, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))); } catch { /* best effort */ }
}

// A wallet hosted apart from its backend (Vercel) sets VITE_STACK_URL at build
// time, e.g. https://api.example.com/stack.json. docs/hosting.md.
export async function loadStack(url: string = import.meta.env['VITE_STACK_URL'] ?? 'stack.json'): Promise<StackConfig> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`no stack config at ${url} — is backend/stack.ts running?`);
  return JSON.parse(await response.text(), reviver) as StackConfig;
}

export interface WalletRuntime {
  readonly app: ReturnType<typeof createPaymentApplication>;
  readonly scope: PoolScope;
  readonly config: StackConfig;
  /** A fresh 3-hop path, drawn from the verified directory. */
  pathFor(): Promise<RelayPath>;
  /** Asks the policy authority for a credential ONCE, before paying. */
  obtainCredential(recipient: `0x${string}`): Promise<CredentialHandle>;
  readRing(): Promise<RingSnapshot>;
  readPrivacy(): Promise<PrivacyConditions>;
  readStatus(handle: StatusHandle): Promise<IntentStatus>;
  /** The account's USDC, and the gas it has prepaid to the EntryPoint. */
  accountFunds(address: `0x${string}`): Promise<{ readonly usdc: number; readonly prepaidGas: number }>;
  /** Everything the account holds, less this operation's gas, to `to`. */
  withdraw(address: `0x${string}`, to: `0x${string}`): Promise<TxHash>;
  exportBackup(passphrase: string): Promise<Blob>;
  /** Into a new key store; reload the page to open it. Returns the notes it added. */
  restoreBackup(file: Blob, passphrase: string): Promise<number>;
  hasWallet: boolean;
}

export async function startWallet(config?: StackConfig): Promise<WalletRuntime> {
  const cfg = config ?? (await loadStack());
  const scope: PoolScope = {
    chainId: BigInt(deployment.network.chainId) as PoolScope['chainId'],
    pool: cfg.pool.address.toLowerCase() as PoolScope['pool'],
    denomination: cfg.pool.denomination as PoolScope['denomination'],
  };

  // §8.2 health from the Graph, asked through the mesh (the exit queries the
  // subgraph) and clamped: it weighs the directory's relays, never adds one.
  const relayHealth = createGraphHealth({
    fetchSnapshot: async () => (await query<RelaySnapshot>({ kind: 'RELAY_SNAPSHOT' })).value,
  });

  // VERIFY FIRST: throws before any relay is contacted if the directory does
  // not chain to the pinned root. The root is compiled in; this browser then
  // remembers the furthest root it has accepted, so a server cannot roll it
  // back to an older directory. Only a dev server's wallet takes the root the
  // server sends, for the random mesh a local stack makes.
  const devRoot = import.meta.env.DEV ? cfg.trustRoot : undefined;
  const { signed, root } = chainTo(cfg.directoryChain ?? [cfg.signedDirectory], devRoot ?? pinnedRoot());
  const bootstrap = createMeshBootstrap({
    root,
    signed,
    pathPolicy: new MarkovPathPolicy(),
    health: relayHealth.health,
    // Big uploads (a ring intent is ~35 chunks) outlast the default poll.
    client: { pollIntervalMs: 250, pollTimeoutMs: 120_000 },
  });

  if (devRoot === undefined) savePinnedRoot(root);

  const provider = (globalThis as { ethereum?: unknown }).ethereum as never;
  const browserPool = createBrowserPool(provider, cfg.capabilities);
  // Every read that names this wallet's account or notes, and every
  // UserOperation, crosses the mesh (§7.5): see backend/chain/wallet-rpc.ts.
  const walletRpc: WalletRpcSend = async (operation, encodedRequest) =>
    (await query<Hex>({ kind: 'WALLET_RPC', operation, encodedRequest })).value;
  // The account's FORS keys, encrypted under a non-extractable key, in this
  // browser and nowhere else. Back them up (exportBackup), or clearing site
  // data loses the account.
  const keys = new IndexedDbSignerStore(keyStoreName());
  const wallet = createLivePqWallet({
    signerStore: keys, walletStore: keys, publicClient: browserPool.publicClient, payer: browserPayer(provider), walletRpc,
  });
  const opsFor = (account: `0x${string}`) =>
    createPqAccountOps({ wallet, account: account.toLowerCase() as never, authority: ARC_AUTHORITY, walletRpc });
  const pool: typeof browserPool = {
    ...browserPool,
    // Until the account is activated, the funding wallet deposits directly, as
    // before. After, deposits come from the account: a UserOperation its PQ
    // key signs, and no wallet popup.
    async deposit(input) {
      const state = await wallet.getState();
      if (!state.active) return browserPool.deposit(input);
      return opsFor(state.accountAddress as `0x${string}`).deposit(input);
    },
    isNullifierSpent: (s, nullifier) => chain.isNullifierSpent(s, nullifier),
    capabilities: async (p) => capabilitiesOf((await readOne(walletRpc, p, 'capabilities', [])).value as never, cfg.capabilities),
  };
  const chain = createMeshChainObserver({
    walletRpc,
    ringSnapshot: async (s) => (await query<RingSnapshot>({ kind: 'RING_SNAPSHOT', scope: s })).value,
  });
  const vault = createNoteVault({ storage: localNoteStorage(), chain });
  const ring = createRingClient(vault, createWorkerProver());

  const credentials = new Map<string, string>();
  const sealIntent = createIntentSealer({
    crePublicKey: cfg.cre.publicKey,
    encryptionKeyId: cfg.cre.encryptionKeyId,
    resolveCredential: async (handle) => {
      const credential = credentials.get(handle as string);
      if (credential === undefined) throw new Error('no credential for this recipient — obtain one before paying');
      return credential;
    },
  });

  const query = async <T>(request: Parameters<typeof bootstrap.transport.query>[0]) =>
    (await bootstrap.transport.query(request, await bootstrap.pathFor())) as unknown as { value: T };
  // Until the first answer, every relay weighs the same. The polls double as
  // cover traffic (§7.5).
  void relayHealth.refresh();
  setInterval(() => void relayHealth.refresh(), 120_000);

  const ports: AdapterPorts = {
    wallet,
    ring,
    pool,
    // Keys from the verified directory — the rule on AdapterPorts.graph.
    graph: {
      getRelaySnapshot: async () => bootstrap.snapshot(),
      getRingSnapshot: async () => (await query<RingSnapshot>({ kind: 'RING_SNAPSHOT', scope })).value,
      getPrivacyConditions: async () => (await query<PrivacyConditions>({ kind: 'PRIVACY_CONDITIONS', scope })).value,
    },
    transport: bootstrap.transport,
    executor: {
      // Chunked automatically when the sealed intent is too big for one message.
      submit: async (intent): Promise<IntentRef> => bootstrap.transport.submitIntent(intent, await bootstrap.pathFor()),
      getStatus: async (handle) => (await query<IntentStatus>({ kind: 'INTENT_STATUS', handle })).value,
    },
    pathPolicy: new MarkovPathPolicy(),
    sealIntent,
    resolveNoteScope: async () => scope,
  };

  return {
    app: createPaymentApplication(ports),
    scope,
    config: cfg,
    hasWallet: provider !== undefined,
    pathFor: () => bootstrap.pathFor(),
    async obtainCredential(recipient) {
      const response = await fetch(cfg.credentialUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recipient: recipient.toLowerCase() }),
      });
      if (!response.ok) throw new Error(`the credential authority refused: ${response.status}`);
      credentials.set(recipient.toLowerCase(), await response.text());
      return recipient.toLowerCase() as CredentialHandle;
    },
    readRing: async () => (await query<RingSnapshot>({ kind: 'RING_SNAPSHOT', scope })).value,
    readPrivacy: async () => (await query<PrivacyConditions>({ kind: 'PRIVACY_CONDITIONS', scope })).value,
    readStatus: async (handle) => (await query<IntentStatus>({ kind: 'INTENT_STATUS', handle })).value,
    async accountFunds(address) {
      const f = await opsFor(address).funds();
      return { usdc: Number(f.usdc6) / 1e6, prepaidGas: Number(f.prepaidGas) / 1e18 };
    },
    withdraw: (address, to) => opsFor(address).withdraw(to.toLowerCase() as never),
    exportBackup: (passphrase) => exportBackup(keys, passphrase),
    restoreBackup,
  };
}
