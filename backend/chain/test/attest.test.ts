import assert from 'node:assert/strict';
import test from 'node:test';

import { createPublicClient, http, parseAbi, toHex as viemHex } from 'viem';

import type { Address, Bytes32 } from '@opaque/protocol-types';
import { asAddress, asChainId, derivePaymentContext } from '@opaque/protocol-types/codecs.js';
import { FORS_C_DEFAULT, forsSchemeId, utf8 } from '@opaque/pq-wallet';

import { deployment, poolFor, requireContract } from '../../../deployments/index.ts';
import { attestationDigest, attestationPayload, ringVerifierId, type AttesterIdentity } from '../../cre/attest.ts';

// LIVE. The attester signs a digest it computes itself (see attest.ts, rule 2).
// That is only useful if what it computes is what the DEPLOYED verifier and
// registry will recompute — so each derivation is checked here against the
// contracts' own view functions, not against a fixture or a local build.
//
// If any of these drift, every attested spend reverts with BadSignature and
// no offline test notices, because both sides are internally consistent.

const client = createPublicClient({ transport: http(deployment.network.rpcUrl) });
const ring8 = poolFor(1_000_000, 'RING_8');
const VERIFIER = requireContract('attestedRingVerifier');
const REGISTRY = requireContract('pqKeyRegistry');

const identity: AttesterIdentity = {
  chainId: BigInt(deployment.network.chainId),
  registry: REGISTRY as Address,
  attester: deployment.accounts.attester as Address,
  pool: ring8.address as Address,
  denomination: ring8.denomination,
};

const RING = Array.from({ length: 8 }, (_, i) => viemHex(i + 1, { size: 32 })) as unknown as Bytes32[];
const NULLIFIER = viemHex(0xabcdef, { size: 32 }) as unknown as Bytes32;
const RECIPIENT = asAddress('0x000000000000000000000000000000000000b0b0');

const verifierAbi = parseAbi([
  'function verifierId() view returns (bytes32)',
  'function attestation(bytes32[] ring, bytes32 nullifier, bytes32 paymentContext) view returns (bytes)',
]);

test('the attester computes the verifier id the deployed verifier reports', async () => {
  const onChain = await client.readContract({ address: VERIFIER, abi: verifierAbi, functionName: 'verifierId' });
  assert.equal(ringVerifierId(identity), onChain);
});

test('paymentContext matches what the deployed pool derives for the recipient', async () => {
  const onChain = await client.readContract({
    address: ring8.address,
    abi: parseAbi(['function paymentContext(address) view returns (bytes32)']),
    functionName: 'paymentContext',
    args: [RECIPIENT],
  });
  const scope = { chainId: asChainId(identity.chainId), pool: identity.pool, denomination: identity.denomination } as never;
  assert.equal(derivePaymentContext(scope, RECIPIENT), onChain);
});

test('the attestation payload is byte-identical to AttestedRingVerifier.attestation()', async () => {
  const scope = { chainId: asChainId(identity.chainId), pool: identity.pool, denomination: identity.denomination } as never;
  const paymentContext = derivePaymentContext(scope, RECIPIENT);
  const onChain = await client.readContract({
    address: VERIFIER, abi: verifierAbi, functionName: 'attestation',
    args: [RING as `0x${string}`[], NULLIFIER as `0x${string}`, paymentContext as `0x${string}`],
  });
  const local = attestationPayload(ringVerifierId(identity), RING, NULLIFIER, paymentContext);
  assert.equal(viemHex(local), onChain);
});

test('the signed digest is exactly what PQKeyRegistry.consume will recompute', async () => {
  const scope = { chainId: asChainId(identity.chainId), pool: identity.pool, denomination: identity.denomination } as never;
  const payload = attestationPayload(ringVerifierId(identity), RING, NULLIFIER, derivePaymentContext(scope, RECIPIENT));
  // consume() prefixes the action domain before digesting — the half that a
  // bare digest() comparison cannot see, which is why it is included here.
  const wrapped = new Uint8Array([...utf8('opaque/v1/pq-wallet/action'), ...payload]);
  for (const useCount of [0n, 7n, 31n]) {
    const onChain = await client.readContract({
      address: REGISTRY,
      abi: parseAbi(['function digest(address,string,uint64,bytes) view returns (bytes32)']),
      functionName: 'digest',
      args: [identity.attester, forsSchemeId(FORS_C_DEFAULT), useCount, viemHex(wrapped)],
    });
    assert.equal(attestationDigest(identity, payload, useCount), onChain, `useCount ${useCount}`);
  }
});
