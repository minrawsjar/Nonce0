#!/usr/bin/env node
// A REAL private ring payment on Arc, through every component.
//
//   set -a; . ./.env; set +a; node chain/e2e-ring-payment.ts
//
// Spends a real seeded note and burns ONE of the attester's 32 FORS indices
// per run — so it is a script you run on purpose, not a test that runs itself.
//
//   note (seeded)  →  219-rep ZKBoo proof  →  sealed to CRE key  →  ~35 chunks
//   through six relays  →  reassembled at the exit  →  CRE stand-in: open,
//   credential, verify, FORS-attest at the registry's LIVE useCount  →  release
//   →  egress  →  PrivatePool.spend on Arc  →  AttestedRingVerifier  →
//   PQKeyRegistry.consume verifies the post-quantum signature  →  1 USDC moves
//   →  evidence from the chain  →  SETTLED  →  status read back through the mesh

import type { AddressInfo } from 'node:net';

import { createPublicClient, http, parseAbi, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type {
  ApprovedRelease,
  CredentialHandle,
  IdempotencyKey,
  NoteId,
  PrivacyScore,
  RelayPath,
  TxHash,
  UnixSeconds,
} from '@opaque/protocol-types';
import { asChainId, fromHex, spendHash } from '@opaque/protocol-types/codecs.js';

import { deployment, poolFor, requireContract } from '../../deployments/index.ts';
import { issueCredential } from '../cre/credential.ts';
import { createExecutorServer } from '../cre/executor-server.ts';
import { createIntentSealer, generateIntentKeypair } from '../cre/seal-client.ts';
import { createCreSimulator } from '../cre/simulator.ts';
import { createMeshTransport } from '../mesh/client.ts';
import { createEgress } from '../mesh/egress.ts';
import { buildLocalMesh, serveLocalMesh } from '../mesh/local-mesh.ts';
import type { MeshMessageKind } from '../mesh/transport.ts';
import { buildRingSpend, deriveCommitment } from '../zk/spend.ts';
import { registryAttesterKeys } from './attester-registry.ts';
import { ARC_TESTNET, createPoolClient, poolSubmitter } from './pool.ts';
import { createChainRingSource } from './ring-source.ts';
import { evaluatePublicReadiness } from '../../graph/src/privacy-score.ts';

const env = (name: string): string => {
  const v = process.env[name];
  if (v === undefined) throw new Error(`${name} must be set in the environment (backend/.env)`);
  return v;
};
const nowS = (): UnixSeconds => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds;
const usdc = (n: bigint) => `${n / 1_000_000n}.${String(n % 1_000_000n).padStart(6, '0')}`;
const log = (s: string) => process.stdout.write(`${s}\n`);

const ring8 = poolFor(1_000_000, 'RING_8');
const REGISTRY = requireContract('pqKeyRegistry');
const ATTESTER = deployment.accounts.attester;
const scope = { chainId: asChainId(BigInt(deployment.network.chainId)), pool: ring8.address, denomination: ring8.denomination } as never;
const publicClient = createPublicClient({ chain: ARC_TESTNET, transport: http() });
const RECIPIENT = ATTESTER; // an address we control, so the USDC is not lost

// Secrets from the environment only. None is ever printed.
const decoySecrets = env('RING_DECOY_SECRETS').split(',').map((h) => fromHex(h as `0x${string}`));
const attesterMaster = fromHex(env('ATTESTER_FORS_MASTER') as `0x${string}`);
const egressKey = env('EGRESS_PRIVATE_KEY') as `0x${string}`;
// Local stand-ins for the CRE's Vault DON secrets. Fresh per run.
const intentKeys = generateIntentKeypair();
const credentialMac = crypto.getRandomValues(new Uint8Array(32));
const KEY_ID = 'opaque-intent-key-v1';
const POLICY = 'opaque-policy-v1';

const usdcAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
const registryAbi = parseAbi(['function stateOf(address) view returns ((bytes32,bytes32,uint64,uint64,uint64,uint64))']);
const poolAbi = parseAbi([
  'function isNullifierSpent(bytes32) view returns (bool)',
  'event Spent(bytes32 indexed nullifier, address indexed recipient, uint256 amount)',
]);
const balance = async () => publicClient.readContract({ address: deployment.tokens.usdc.address, abi: usdcAbi, functionName: 'balanceOf', args: [RECIPIENT] });
const useCount = async () => (await publicClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: 'stateOf', args: [ATTESTER] }))[2];

// ── the ring, from the chain ──────────────────────────────────────────────
const exitGraph = createChainRingSource({
  publicClient: publicClient as never, scope, deployedAtBlock: BigInt(ring8.deployedAtBlock),
  relaySnapshot: () => ({ nodes: [], directoryVersion: 'local', observedAt: nowS() }),
});
const snapshot = await exitGraph.getRingSnapshot(scope);
log(`ring pool ${ring8.address}: ${snapshot.candidates.length} deposits on chain`);

// Spend the first seeded note; it must be one the pool has actually seen.
const mine = decoySecrets[0]!;
const myCommitment = deriveCommitment(mine, scope);
const onChain = new Set(snapshot.candidates.map((c) => c.commitment as string));
if (!onChain.has(myCommitment as string)) throw new Error('the note to spend is not a deposit in this pool');
const decoys = snapshot.candidates.map((c) => c.commitment).filter((c) => c !== myCommitment).slice(0, 7);

const before = { balance: await balance(), useCount: await useCount() };
log(`recipient ${RECIPIENT}: ${usdc(before.balance)} USDC   attester useCount ${before.useCount}/32`);

// ── the spend, sealed ─────────────────────────────────────────────────────
const t0 = Date.now();
const spend = buildRingSpend({ scope, recipient: RECIPIENT as never, noteSecret: mine, decoys });
log(`ZKBoo proof built: ${fromHex(spend.proof).length} bytes, ${Date.now() - t0} ms`);
if (await publicClient.readContract({ address: ring8.address, abi: poolAbi, functionName: 'isNullifierSpent', args: [spend.nullifier as `0x${string}`] })) {
  throw new Error('this note is already spent — seed fresh decoys or spend another');
}

const credential = issueCredential({ recipient: RECIPIENT as never, policyVersion: POLICY, expiresAt: (nowS() + 3600n) as UnixSeconds }, credentialMac);
const seal = createIntentSealer({
  crePublicKey: intentKeys.publicKey, encryptionKeyId: KEY_ID,
  resolveCredential: async () => JSON.stringify(credential, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)),
});
const deadline = (nowS() + 60n) as UnixSeconds;
const intent = await seal({
  scope, spendHash: spendHash(spend), spend,
  request: {
    noteId: 'seeded-0' as NoteId, recipient: RECIPIENT as never, minPrivacyScore: 5_000 as PrivacyScore, deadline,
    credentialHandle: 'local' as CredentialHandle, idempotencyKey: `e2e-${Date.now()}` as IdempotencyKey,
  },
});
log(`sealed intent: ${fromHex(intent.encryptedPayload).length} bytes`);

// ── egress, exit, six relays ──────────────────────────────────────────────
const egress = createEgress({
  secret: credentialMac,
  submitter: poolSubmitter(createPoolClient({
    account: privateKeyToAccount(egressKey),
    offChain: { pqWallet: 'MOCK', graph: 'LIVE', confidentialExecution: 'SIMULATED', policyScope: 'CRE_WORKFLOW_ONLY' },
  })),
});
const egressPort = ((await egress.listen(0)).address() as AddressInfo).port;
const exit = createExecutorServer({ graph: exitGraph });
const exitPort = ((await exit.listen(0)).address() as AddressInfo).port;
const mesh = buildLocalMesh(19_601);
const relays = await serveLocalMesh(mesh, new Map<MeshMessageKind, string>([
  ['PAYMENT', `http://127.0.0.1:${exitPort}/v1/mesh/payment`],
  ['QUERY', `http://127.0.0.1:${exitPort}/v1/mesh/query`],
]));

try {
  const nodes = mesh.signed.directory.entries.map((e) => ({
    id: e.id, endpoint: e.endpoint, kemPublicKey: e.kemPublicKey, keyEpoch: e.keyEpoch, operatorId: e.operatorId,
    reliabilityScore: 5_000 as PrivacyScore, batchOccupancy: 1, recentSelectionCount: 0, lastSeenAt: nowS(),
  }));
  const pathFor = async () => [...nodes].sort(() => Math.random() - 0.5).slice(0, 3) as unknown as RelayPath;
  const transport = createMeshTransport({ pollIntervalMs: 150, pollTimeoutMs: 90_000, pathFor });

  const t1 = Date.now();
  const ref = await transport.submitIntent(intent, await pathFor());
  log(`across the mesh in chunks, reassembled at the exit: ${Date.now() - t1} ms`);

  // ── settle: the stand-in drives everything to the chain ─────────────────
  // The PRIVACY-TIMED branch, on the real clock: the intent fires because
  // cover is good enough now, not because a deadline passed. The score is the
  // public-readiness formula over the real ring and the real six relays.
  const relaySnapshot = { nodes: nodes.map((n) => ({ ...n, reliabilityScore: 9_000 as PrivacyScore })), directoryVersion: 'local', observedAt: nowS() };
  const simulator = createCreSimulator({
    executor: exit.executor, intentSecretKey: intentKeys.secretKey, encryptionKeyId: KEY_ID,
    credentialMac, policyVersion: POLICY, releaseTtlSeconds: 900n,
    async readFreshScore() {
      const conditions = evaluatePublicReadiness(await exitGraph.getRingSnapshot(scope), relaySnapshot);
      log(`privacy score now ${conditions.privacyScore} (ring ${conditions.ringFreshnessScore}, mesh ${conditions.meshHealthScore}) — intent asks for ≥ 5000`);
      return { score: conditions.privacyScore, observedAt: conditions.observedAt };
    },
    attester: {
      identity: { chainId: BigInt(deployment.network.chainId), registry: REGISTRY as never, attester: ATTESTER as never, pool: ring8.address as never, denomination: ring8.denomination },
      // LIVE: the registry's current key and index, rotating near the end.
      current: registryAttesterKeys({
        publicClient: publicClient as never, payer: privateKeyToAccount(egressKey), registry: REGISTRY as never,
        attester: ATTESTER as never, master: attesterMaster, chainId: BigInt(deployment.network.chainId),
      }).current,
    },
    async deliver(release: ApprovedRelease) {
      const response = await fetch(`http://127.0.0.1:${egressPort}/v1/release`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(release, (_k, v) => (typeof v === 'bigint' ? v.toString(10) : v)),
      });
      const body = (await response.json()) as { txHash?: string; message?: string };
      if (body.txHash === undefined) throw new Error(`egress refused: ${response.status} ${body.message}`);
      return body.txHash as TxHash;
    },
    // Evidence FROM THE CHAIN: the receipt succeeded and the pool emitted a
    // Spent for exactly this nullifier and recipient. Not an assertion.
    async evidence(txHash, release) {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
      const spent = parseEventLogs({ abi: poolAbi, logs: receipt.logs, eventName: 'Spent' }).find(
        (l) => l.args.nullifier.toLowerCase() === (release.spend.nullifier as string).toLowerCase()
          && l.args.recipient.toLowerCase() === (release.spend.recipient as string).toLowerCase(),
      );
      return { txHash, spendHash: spendHash(release.spend), succeeded: receipt.status === 'success' && spent !== undefined };
    },
    onError: (_id, error) => log(`  ! settle failed: ${(error as Error).message}`),
    nullifierSpent: async (s) => publicClient.readContract({ address: ring8.address, abi: poolAbi, functionName: 'isNullifierSpent', args: [s.nullifier as `0x${string}`] }),
  });
  await simulator.tick();

  const status = await transport.query({ kind: 'INTENT_STATUS', handle: ref.statusHandle }, await pathFor());
  const after = { balance: await balance(), useCount: await useCount() };
  const tx = status.kind === 'INTENT_STATUS' ? status.value.txHash : undefined;

  log('');
  log(`intent status (read through the mesh): ${status.kind === 'INTENT_STATUS' ? status.value.state : '?'}`);
  log(`settlement tx:   ${tx}`);
  log(`recipient:       ${usdc(before.balance)} → ${usdc(after.balance)} USDC  (+${usdc(after.balance - before.balance)})`);
  log(`attester index:  ${before.useCount} → ${after.useCount} of 32 (the FORS signature burned it on chain)`);
  log(after.balance - before.balance === 1_000_000n && status.kind === 'INTENT_STATUS' && status.value.state === 'SETTLED'
    ? 'RESULT: a private RING_8 payment SETTLED on Arc'
    : 'RESULT: NOT settled — see above');
} finally {
  await Promise.all(relays.map((r) => r.close()));
  await exit.close();
  await egress.close();
}
