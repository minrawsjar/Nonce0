import { createHash } from 'node:crypto';

// Scaffold-only canonical serializer. Replace hashAction with an EVM Keccak-256
// implementation before on-chain deployment; Node's sha3-256 has different padding.
export function createActionDigest({ chainId, walletAddress, schemeId, useCount, payload, hashAction = defaultHash }) {
  if (!walletAddress?.startsWith('0x') || !payload?.startsWith('0x')) throw new TypeError('walletAddress and payload must be hex');
  return hashAction(['OPAQUE_PQ_V1', chainId.toString(), walletAddress.toLowerCase(), String(schemeId), useCount.toString(), payload.toLowerCase()].join('|'));
}

function defaultHash(value) {
  return `0x${createHash('sha3-256').update(value).digest('hex')}`;
}
