// The wallet's composition root: every port the payment application needs,
// built from the running stack's config. The page imports this and the barrel.
//
// Where each piece comes from — and the one rule that matters most:
//
//   relay keys   the SIGNED directory, verified against a pinned root before a
//                single relay is contacted. Never a network response.
//   ring         a mesh query, answered at the exit: members from the pool's
//                own events, their §8.1 weights from the subgraph.
//   relay health a mesh query too (the subgraph, via the exit), clamped.
//   proof        built HERE, in the page: the note secret never leaves it.
//   intent       sealed here to the CRE key, then chunked across the mesh.
//   status       a mesh query. The page never opens a connection to the exit.
//   account      LIVE on Arc: FORS keys in IndexedDB, the account deployed by
//                PQAccountFactory. The funding wallet only pays for that.
//   deposit      from the account once activated (a UserOperation its PQ key
//                signs), from the funding wallet before. Attributable either way.

import type {
  CredentialHandle,
  IntentRef,
  IntentStatus,
  PoolScope,
  PrivacyConditions,
  RelayPath,
  RelaySnapshot,
  RingSnapshot,
  StatusHandle,
} from '@opaque/protocol-types';

import { createMeshBootstrap } from '../../../backend/mesh/bootstrap.ts';
import { createGraphHealth } from '../../../backend/mesh/graph-health.ts';
import type { DirectoryTrustRoot, SignedDirectory } from '../../../backend/mesh/contracts.ts';
import { createIntentSealer } from '../../../backend/cre/seal-client.ts';
import { ARC_AUTHORITY, createAccountPool, createLivePqWallet } from '../../../backend/chain/pq-wallet-chain.ts';
import { browserPayer, createBrowserPool, createChainObserver } from '../../../backend/chain/wallet-chain.ts';
import { MarkovPathPolicy } from '../../../graph/src/path-policy.ts';
import { createNoteVault, createRingClient } from '../../../packages/ring-client/src/index.ts';
import { IndexedDbSignerStore } from '../../../packages/pq-wallet/src/indexeddb-store.ts';
import { deployment } from '../../../deployments/index.ts';
import { createPaymentApplication, type AdapterPorts } from './protocol/index.ts';
import { localNoteStorage } from './note-storage.ts';

export interface StackConfig {
  readonly signedDirectory: SignedDirectory;
  readonly trustRoot: DirectoryTrustRoot;
  readonly cre: { readonly publicKey: `0x${string}`; readonly encryptionKeyId: string; readonly policyVersion: string };
  readonly credentialUrl: string;
  readonly pool: { readonly address: `0x${string}`; readonly denomination: number; readonly proofMode: string };
  readonly capabilities: { readonly pqWallet: 'MOCK' | 'LIVE'; readonly graph: 'LIVE' | 'FIXTURE'; readonly confidentialExecution: 'ATTESTED' | 'SIMULATED'; readonly policyScope: 'CRE_WORKFLOW_ONLY' };
}

const reviver = (_k: string, v: unknown) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);

/**
 * LOCAL DEVELOPMENT: the trust root arrives in stack.json from the dev server.
 * In a real build it must be a compile-time constant — a root fetched from a
 * server an attacker controls is a root the attacker chose.
 */
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
  /** The account's USDC (Arc's native balance, 18 decimals, is the same money). */
  accountBalance(address: `0x${string}`): Promise<number>;
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
  // not chain to the pinned root.
  const bootstrap = createMeshBootstrap({
    root: cfg.trustRoot,
    signed: cfg.signedDirectory,
    pathPolicy: new MarkovPathPolicy(),
    health: relayHealth.health,
    // Big uploads (a ring intent is ~35 chunks) outlast the default poll.
    client: { pollIntervalMs: 250, pollTimeoutMs: 120_000 },
  });

  const provider = (globalThis as { ethereum?: unknown }).ethereum as never;
  const browserPool = createBrowserPool(provider, cfg.capabilities);
  // The account's FORS keys, encrypted under a non-extractable key, in this
  // browser and nowhere else. Clearing site data loses the account.
  const keys = new IndexedDbSignerStore('opaque-pq-account-v1');
  const wallet = createLivePqWallet({
    signerStore: keys, walletStore: keys, publicClient: browserPool.publicClient, payer: browserPayer(provider),
  });
  const pool: typeof browserPool = {
    ...browserPool,
    // Until the account is activated, the funding wallet deposits directly, as
    // before. After, deposits come from the account: a UserOperation its PQ
    // key signs, and no wallet popup.
    async deposit(input) {
      const state = await wallet.getState();
      if (!state.active) return browserPool.deposit(input);
      return createAccountPool({
        base: browserPool, publicClient: browserPool.publicClient, wallet, account: state.accountAddress, authority: ARC_AUTHORITY,
      }).deposit(input);
    },
  };
  const poolEntry = deployment.pools.find((p) => p.address.toLowerCase() === scope.pool);
  const vault = createNoteVault({
    storage: localNoteStorage(),
    chain: createChainObserver(pool.publicClient, BigInt(poolEntry?.deployedAtBlock ?? 0)),
  });
  const ring = createRingClient(vault);

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
    accountBalance: async (address) => Number(await browserPool.publicClient.getBalance({ address })) / 1e18,
  };
}
