#!/usr/bin/env node
// The whole backend a wallet needs, on one machine, against the REAL Arc pool.
//
//   cd backend && set -a && . ./.env && set +a && node stack.ts
//
// On a public box, behind deploy/Caddyfile (docs/hosting.md):
//
//   PUBLIC_URL=https://mesh.example.com node stack.ts            six relays here
//   PUBLIC_URL=… MESH_CONFIG=mesh/deploy/config node stack.ts    six elsewhere
//
// Six relays, the mesh exit (executor + query answering + the CRE stand-in),
// the release egress, and a test credential authority. The exit reads the
// subgraph (§8); on a public box the relays announce themselves and report
// health to RelayDirectory, which is what the subgraph indexes. Writes the wallet's
// public config to frontend/public/stack.json — the signed relay directory,
// its trust root, the CRE's public key — so `npm run dev` in frontend/ talks to
// this and nothing else.
//
// ── What this is NOT ─────────────────────────────────────────────────────
//
// One machine is one operator: six relays here collude by construction. The
// CRE stand-in holds INTENT_KEY in an ordinary process, so nothing it opens is
// confidential. The credential authority issues for any recipient. Every one of
// those is labelled in the capabilities the wallet reads, and every one is a
// deployment step, not a code change — see docs/deployment-arc-testnet.md.
//
// A built wallet pins the relay directory's trust root at compile time
// (deployments/arc-testnet.json) and walks directoryChain from it: a root
// fetched from a server an attacker controls is a root the attacker chose.
// With MESH_MASTER set, this box derives that chain. Only a dev server's
// wallet takes the root written here, for the random mesh an unset master gives.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPublicClient, http, nonceManager, parseAbi, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ProtocolFailure, type ApprovedRelease, type GraphSelectionClient, type PoolScope, type RelaySnapshot, type RingSnapshot, type TxHash, type UnixSeconds } from '@opaque/protocol-types';
import { asChainId, fromHex, spendHash, toHex } from '@opaque/protocol-types/codecs.js';

import { deployment, meshTrustRoot, poolFor, requireContract, requireService, type PoolDeployment } from '../deployments/index.ts';
import { GraphHttpClient } from '../graph/src/client.ts';
import { evaluatePublicReadiness } from '../graph/src/privacy-score.ts';
import { registryAttesterKeys } from './chain/attester-registry.ts';
import { ARC_TESTNET, createPoolClient, poolSubmitter } from './chain/pool.ts';
import { ARC_AUTHORITY } from './chain/pq-wallet-chain.ts';
import { relayDirectoryReporter } from './chain/relay-directory.ts';
import { createChainRingSource } from './chain/ring-source.ts';
import { createWalletRpcAnswerer } from './chain/wallet-rpc.ts';
import { issueCredential } from './cre/credential.ts';
import { createExecutorServer } from './cre/executor-server.ts';
import { generateIntentKeypair } from './cre/seal-client.ts';
import { createCreSimulator } from './cre/simulator.ts';
import { createEgress } from './mesh/egress.ts';
import type { DirectoryTrustRoot, SignedDirectory } from './mesh/contracts.ts';
import { chainTo, verify } from './mesh/directory.ts';
import { createGraphHealth } from './mesh/graph-health.ts';
import { buildLocalMesh, meshRootAt, serveLocalMesh } from './mesh/local-mesh.ts';
import type { MeshMessageKind } from './mesh/transport.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, '.stack');
const OUT = join(HERE, '..', 'frontend', 'public', 'stack.json');
const PORTS = { relays: 18_101, exit: 18_200, egress: 18_201, credentials: 18_202 } as const;
const KEY_ID = 'opaque-intent-key-v1';
const POLICY = 'opaque-policy-v1';
// Every listener binds loopback. On a public box only the TLS proxy in front
// (deploy/Caddyfile) is reachable, and the egress — which signs — never is.
const LOOPBACK = '127.0.0.1';
// Where the WALLET reaches this box. Unset: loopback, one laptop. Set to e.g.
// https://mesh.example.com and the directory names the proxy's /r1…/r6.
// Railway names its domain in RAILWAY_PUBLIC_DOMAIN, so there it needs no setting.
const RAILWAY = process.env['RAILWAY_PUBLIC_DOMAIN'];
const PUBLIC_URL = (process.env['PUBLIC_URL'] ?? (RAILWAY && `https://${RAILWAY}`))?.replace(/\/+$/, '');
// A PaaS gives a service ONE port and one TLS name, and sets PORT. Everything
// the wallet and remote relays reach is then routed on it — see the bottom.
const PORT = process.env['PORT'];

const env = (name: string): string => {
  const v = process.env[name];
  if (v === undefined) throw new Error(`${name} must be set — run with: set -a && . ./.env && set +a`);
  return v;
};
const nowS = (): UnixSeconds => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds;
const log = (s: string) => process.stdout.write(`${s}\n`);
const bigintReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v);

// ── dev secrets, persisted so a sealed intent survives a restart ─────────
mkdirSync(STATE, { recursive: true, mode: 0o700 });
const intentKeyFile = join(STATE, 'intent-key.json');
const macFile = join(STATE, 'credential.mac');
if (!existsSync(intentKeyFile)) {
  const k = generateIntentKeypair();
  writeFileSync(intentKeyFile, JSON.stringify({ publicKey: k.publicKey, secretKey: k.secretKey }), { mode: 0o600 });
}
if (!existsSync(macFile)) writeFileSync(macFile, toHex(crypto.getRandomValues(new Uint8Array(32))), { mode: 0o600 });
const intentKeys = JSON.parse(readFileSync(intentKeyFile, 'utf8')) as { publicKey: `0x${string}`; secretKey: `0x${string}` };
const credentialMac = fromHex(readFileSync(macFile, 'utf8').trim() as `0x${string}`);

// ── chain ────────────────────────────────────────────────────────────────
// Every RING_8 pool, one per denomination; one attester signs for all of them.
// A wallet splits an amount into these notes, so 100 USDC is one payment.
const ringPools = deployment.pools.filter((p) => p.proofMode === 'RING_8');
const ring8 = poolFor(1_000_000, 'RING_8');
const REGISTRY = requireContract('pqKeyRegistry');
const ATTESTER = deployment.accounts.attester;
const scopeOf = (p: PoolDeployment): PoolScope => ({ chainId: asChainId(BigInt(deployment.network.chainId)), pool: p.address, denomination: p.denomination }) as never;
const poolAt = (s: PoolScope): PoolDeployment => {
  const pool = ringPools.find((p) => p.address === s.pool.toLowerCase());
  if (pool === undefined) throw new ProtocolFailure('INVALID_INPUT', `no RING_8 pool at ${s.pool}`);
  return pool;
};
const publicClient = createPublicClient({ chain: ARC_TESTNET, transport: http() });
const poolAbi = parseAbi([
  'function isNullifierSpent(bytes32) view returns (bool)',
  'event Spent(bytes32 indexed nullifier, address indexed recipient, uint256 amount)',
]);

// ── the mesh ─────────────────────────────────────────────────────────────
// Relays on six other hosts: MESH_CONFIG=mesh/deploy/config, the directory and
// root make-config.ts wrote for them. Unset: six relays in this process.
const MESH_CONFIG = process.env['MESH_CONFIG'];
// Set on a public deployment: every relay key and directory derives from this
// one secret, week by week from the genesis in deployments/arc-testnet.json,
// so the root compiled into the wallet verifies across restarts. Unset: a
// fresh random mesh each boot, whose root only a dev server may hand out.
// Public only: a loopback mesh from the same master would put a second
// directory under each few-time signer, with endpoints no wallet can reach.
const MESH_MASTER = PUBLIC_URL === undefined ? undefined : process.env['MESH_MASTER'];
const readConfig = <T>(name: string): T => JSON.parse(readFileSync(join(MESH_CONFIG!, name), 'utf8'),
  (_k, v: unknown) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) as T;
const mesh = MESH_CONFIG === undefined
  ? buildLocalMesh({
    basePort: PORTS.relays,
    endpointFor: (_id, i, port) =>
      PUBLIC_URL === undefined ? `http://${LOOPBACK}:${port}/v1/relay` : `${PUBLIC_URL}/r${i + 1}/v1/relay`,
    ...(MESH_MASTER === undefined ? {} : { master: fromHex(MESH_MASTER as `0x${string}`), genesis: BigInt(deployment.mesh.genesis) }),
  })
  : (() => {
    const signed = readConfig<SignedDirectory>('directory.json');
    return { signed, root: readConfig<DirectoryTrustRoot>('trust-root.json'), chain: [signed] };
  })();
const pinned = meshTrustRoot();
if (MESH_MASTER !== undefined) {
  // Refuse to serve a mesh the deployed wallet cannot verify.
  const derived = meshRootAt(fromHex(MESH_MASTER as `0x${string}`), pinned.minVersion);
  if (derived.signerCommitment !== pinned.signerCommitment) {
    throw new Error('MESH_MASTER does not derive the trust root pinned in deployments/arc-testnet.json');
  }
}
// The links a wallet needs: from the pinned root to the directory in force.
const directoryChain = MESH_MASTER === undefined ? mesh.chain : mesh.chain.filter((l) => l.directory.version > pinned.minVersion);
// At boot, not at the first payment: an expired directory stops here, and so
// does a chain the wallet could not walk.
const inForce = chainTo(directoryChain, MESH_MASTER === undefined ? mesh.root : (pinned as DirectoryTrustRoot));
verify(inForce.signed, inForce.root, nowS());

// ── the Graph (§8), asked here at the exit and nowhere else ──────────────
// The subgraph indexes RelayDirectory and the pool. Keys and ring membership
// still come from the signed directory and the chain; the Graph weighs them.
// Relays report every 10 minutes (each report is a transaction), so a health
// observation is fresh for 15: one missed report plus indexing lag.
const HEALTH_MAX_AGE = 900n;
const graph = new GraphHttpClient({ endpoint: requireService('graphUrl'), pinnedRelays: mesh.signed.directory.entries, maxObservationAgeSeconds: HEALTH_MAX_AGE });
// Clamped, so a hostile index can steer load but never exclude a relay.
const relayHealth = createGraphHealth({ fetchSnapshot: () => graph.getRelaySnapshot(), maxAgeSeconds: HEALTH_MAX_AGE });
void relayHealth.refresh();
setInterval(() => void relayHealth.refresh(), 90_000).unref();
const relaySnapshot = (): RelaySnapshot => ({
  nodes: mesh.signed.directory.entries.map((e) => ({
    id: e.id, endpoint: e.endpoint, kemPublicKey: e.kemPublicKey, keyEpoch: e.keyEpoch, operatorId: e.operatorId,
    ...relayHealth.health(e), lastSeenAt: nowS(),
  })),
  directoryVersion: mesh.signed.directory.version.toString(),
  observedAt: nowS(),
});
// Studio's query endpoint is rate-limited, and the stand-in asks for a score
// every 3 s per waiting intent: one index read per pool per 30 s.
const indexed = new Map<string, { at: number; ring: Promise<RingSnapshot> }>();
const ringSources = new Map(ringPools.map((p) => [p.address, createChainRingSource({
  publicClient: publicClient as never, scope: scopeOf(p), deployedAtBlock: BigInt(p.deployedAtBlock), relaySnapshot,
  indexed: (s) => {
    const hit = indexed.get(p.address);
    if (hit !== undefined && Date.now() - hit.at < 30_000) return hit.ring;
    const ring = graph.getRingSnapshot(s);
    indexed.set(p.address, { at: Date.now(), ring });
    return ring;
  },
})]));
// Each question goes to the source for its pool; each source refuses any other.
const ringSource: GraphSelectionClient = {
  getRingSnapshot: async (s) => ringSources.get(poolAt(s).address)!.getRingSnapshot(s),
  getRelaySnapshot: async () => relaySnapshot(),
  getPrivacyConditions: async (s) => ringSources.get(poolAt(s).address)!.getPrivacyConditions(s),
};

// ── egress, exit, stand-in ───────────────────────────────────────────────
const egress = createEgress({
  secret: credentialMac,
  submitter: poolSubmitter(createPoolClient({
    account: privateKeyToAccount(env('EGRESS_PRIVATE_KEY') as `0x${string}`),
    offChain: { pqWallet: 'LIVE', graph: 'LIVE', confidentialExecution: 'SIMULATED', policyScope: 'CRE_WORKFLOW_ONLY' },
  })),
});
await egress.listen(PORTS.egress, LOOPBACK);

// WALLET_RPC (§7.5): the wallet's account and note reads, and its account's
// UserOperations, so the RPC and the bundler see this box and not the wallet.
const exit = createExecutorServer({
  graph: ringSource,
  walletRpc: createWalletRpcAnswerer({
    publicClient: publicClient as never, bundlerUrl: ARC_AUTHORITY.bundlerUrl,
    entryPoint: ARC_AUTHORITY.entryPoint, accountImplementation: ARC_AUTHORITY.accountImplementation, factory: ARC_AUTHORITY.factory,
  }),
});
await exit.listen(PORTS.exit, LOOPBACK);

const simulator = createCreSimulator({
  executor: exit.executor,
  intentSecretKey: intentKeys.secretKey,
  encryptionKeyId: KEY_ID,
  credentialMac,
  policyVersion: POLICY,
  releaseTtlSeconds: 900n,
  async readFreshScore(scope) {
    const c = evaluatePublicReadiness(await ringSource.getRingSnapshot(scope), relaySnapshot());
    return { score: c.privacyScore, observedAt: c.observedAt };
  },
  attester: {
    identity: (scope) => ({ chainId: BigInt(deployment.network.chainId), registry: REGISTRY as never, attester: ATTESTER as never, pool: poolAt(scope).address as never, denomination: poolAt(scope).denomination }),
    // Rotates itself near the end of each key's budget; see cre/attester-keys.ts.
    current: registryAttesterKeys({
      publicClient: publicClient as never,
      payer: privateKeyToAccount(env('EGRESS_PRIVATE_KEY') as `0x${string}`),
      registry: REGISTRY as never,
      attester: ATTESTER as never,
      master: fromHex(env('ATTESTER_FORS_MASTER') as `0x${string}`),
      chainId: BigInt(deployment.network.chainId),
    }).current,
  },
  async deliver(release: ApprovedRelease) {
    const response = await fetch(`http://127.0.0.1:${PORTS.egress}/v1/release`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(release, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)),
    });
    const body = (await response.json()) as { txHash?: string; message?: string };
    if (body.txHash === undefined) throw new Error(`egress refused: ${response.status} ${body.message}`);
    return body.txHash as TxHash;
  },
  // Evidence from the chain: the receipt succeeded and the spend's own pool
  // emitted a Spent for exactly this nullifier and recipient.
  async evidence(txHash, release) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
    const spent = parseEventLogs({ abi: poolAbi, logs: receipt.logs, eventName: 'Spent' }).find(
      (l) => l.address.toLowerCase() === release.spend.scope.pool.toLowerCase()
        && l.args.nullifier.toLowerCase() === (release.spend.nullifier as string).toLowerCase()
        && l.args.recipient.toLowerCase() === (release.spend.recipient as string).toLowerCase(),
    );
    log(`  settled ${txHash} (${receipt.status})`);
    return { txHash, spendHash: spendHash(release.spend), succeeded: receipt.status === 'success' && spent !== undefined };
  },
  nullifierSpent: async (s) => publicClient.readContract({ address: s.scope.pool, abi: poolAbi, functionName: 'isNullifierSpent', args: [s.nullifier as `0x${string}`] }),
  onError: (id, error) => log(`  ! intent ${String(id).slice(0, 8)}… will retry: ${(error as Error).message}`),
});
simulator.start(3_000);

const relays = !('secretKeys' in mesh) ? [] : await serveLocalMesh(mesh, new Map<MeshMessageKind, string>([
  ['PAYMENT', `http://127.0.0.1:${PORTS.exit}/v1/mesh/payment`],
  ['QUERY', `http://127.0.0.1:${PORTS.exit}/v1/mesh/query`],
]), LOOPBACK);

// ── §8.2: this box's relays, announced and reported on chain ─────────────
// Public deployments only: a loopback endpoint on a public chain would
// overwrite the hosted relays' entries with addresses nobody can reach.
const RELAY_OPERATOR_KEY = process.env['RELAY_OPERATOR_KEY'];
if (PUBLIC_URL !== undefined && RELAY_OPERATOR_KEY !== undefined && relays.length > 0) {
  const reporter = relayDirectoryReporter({
    publicClient: publicClient as never,
    operator: privateKeyToAccount(RELAY_OPERATOR_KEY as `0x${string}`, { nonceManager }),
    directory: requireContract('relayDirectory') as never,
    entries: mesh.signed.directory.entries,
    relays,
  });
  // In the background: the wallet can use the mesh before the Graph sees it.
  void reporter.announce().then(async (sent) => { await reporter.report(); return sent; }).then(
    (sent) => {
      log(`  relays ${sent === 0 ? 'already announced' : `announced (${sent})`} in RelayDirectory; reporting health every 10 min`);
      // ~0.0018 USDC a report: about 0.26 USDC a day at this cadence.
      setInterval(() => void reporter.report().catch((e: Error) => log(`  ! relay report failed: ${e.message}`)), 600_000).unref();
    },
    (e: Error) => log(`  ! relay announce failed, no health will be reported: ${e.message}`),
  );
}

// ── test credential authority ────────────────────────────────────────────
// Issues for ANY recipient: a stand-in for a real policy authority, which the
// wallet asks once, out of band, before paying — never during a payment.
const credentialHandler: RequestListener = (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const chunks: Buffer[] = [];
  let size = 0;
  // Public once PUBLIC_URL is set: a body is one address, so anything big is abuse.
  req.on('data', (c: Buffer) => { size += c.length; if (size > 1024) req.destroy(); else chunks.push(c); });
  req.on('end', () => {
    try {
      const { recipient } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { recipient?: string };
      if (typeof recipient !== 'string' || !/^0x[0-9a-f]{40}$/.test(recipient)) throw new Error('recipient must be a lower-case address');
      const credential = issueCredential({ recipient: recipient as never, policyVersion: POLICY, expiresAt: (nowS() + 86_400n) as UnixSeconds }, credentialMac);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(credential, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: (e as Error).message }));
    }
  });
};
const credentials = createServer(credentialHandler);
await new Promise<void>((r) => credentials.listen(PORTS.credentials, LOOPBACK, r));

// ── what the wallet reads ────────────────────────────────────────────────
const walletConfig = JSON.stringify({
  $comment: 'Written by backend/stack.ts, every start.',
  // A deployed wallet walks directoryChain from the root it compiled in and
  // ignores trustRoot; only a dev server's wallet takes trustRoot from here.
  directoryChain,
  signedDirectory: mesh.signed,
  trustRoot: mesh.root,
  cre: { publicKey: intentKeys.publicKey, encryptionKeyId: KEY_ID, policyVersion: POLICY },
  credentialUrl: `${PUBLIC_URL ?? `http://${LOOPBACK}:${PORTS.credentials}`}/v1/credential`,
  // Wallets built before several pools read this one. Newer ones take every
  // pool from the deployments compiled into them, never from this file.
  pool: { address: ring8.address, denomination: ring8.denomination, proofMode: ring8.proofMode },
  capabilities: { pqWallet: 'LIVE', graph: 'LIVE', confidentialExecution: 'SIMULATED', policyScope: 'CRE_WORKFLOW_ONLY' },
}, bigintReplacer, 2);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, walletConfig);

// ── one public port ──────────────────────────────────────────────────────
// Only what Caddy would route (deploy/Caddyfile): /rN/* to relay N, the exit,
// the credential authority, the wallet config. The egress is not reachable.
// Relays keep their loopback listeners too: listen() is what runs the batch
// clock, and a handler without it would queue forever.
const router = PORT === undefined ? undefined : createServer((req, res) => {
  const url = req.url ?? '/';
  const hop = /^\/r(\d+)(\/.*)$/.exec(url);
  const relay = hop && relays.find((r) => r.relayId === `R${hop[1]}`);
  if (hop && relay) { req.url = hop[2]; relay.handler(req, res); return; }
  if (url.startsWith('/v1/mesh/')) { exit.handler(req, res); return; }
  if (url === '/v1/credential') { credentialHandler(req, res); return; }
  if (url === '/stack.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(walletConfig);
    return;
  }
  res.writeHead(404); res.end();
});
if (router) await new Promise<void>((r) => router.listen(Number(PORT), '0.0.0.0', r));

log('opaque local stack — against the REAL Arc pools');
for (const p of ringPools) {
  const snap = await ringSource.getRingSnapshot(scopeOf(p));
  log(`  pool       ${p.address}  (${p.proofMode}, ${p.denomination / 1e6} USDC, ${snap.candidates.length} deposits)`);
}
log(`  relays     ${mesh.signed.directory.entries.map((e) => e.endpoint.replace('/v1/relay', '')).join('  ')}`);
log(`  exit       http://127.0.0.1:${PORTS.exit}   egress :${PORTS.egress}   credentials :${PORTS.credentials}`);
log(`  wallet cfg ${OUT}${router ? `  and ${PUBLIC_URL ?? ''}/stack.json (all routes on :${PORT})` : ''}`);
log('  THIS IS ONE OPERATOR, AND CRE IS SIMULATED. Not an anonymity set.');

// A derived mesh turns over weekly. The platform restarts a service that
// exits non-zero, and the next boot derives the next generation, so the
// directory in force never lapses while this runs.
if ('generationEndsAt' in mesh && mesh.generationEndsAt !== undefined) {
  const ms = Number(mesh.generationEndsAt - nowS()) * 1000;
  setTimeout(() => { log('  directory generation over: exiting so the next boot serves the next one'); process.exit(75); }, Math.max(ms, 0)).unref();
  log(`  directory  generation ends ${new Date(Number(mesh.generationEndsAt) * 1000).toISOString()} (${directoryChain.length} link${directoryChain.length === 1 ? '' : 's'} from the pinned root)`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    simulator.stop();
    void Promise.all([...relays.map((r) => r.close()), exit.close(), egress.close(), new Promise((r) => credentials.close(r)), new Promise((r) => (router ? router.close(r) : r(undefined)))])
      .then(() => process.exit(0));
  });
}
