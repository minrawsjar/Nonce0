import { createHash } from 'node:crypto';

export function deriveNullifier({ noteSecret, pool }) {
  assertHex(noteSecret, 'noteSecret');
  assertHex(pool, 'pool');
  return `0x${createHash('sha256').update(`OPAQUE_NULLIFIER_V1|${noteSecret.toLowerCase()}|${pool.toLowerCase()}`).digest('hex')}`;
}

export function derivePaymentContext({ pool, chainId, recipient, denomination }) {
  assertHex(pool, 'pool'); assertHex(recipient, 'recipient');
  return `0x${createHash('sha256').update(`OPAQUE_PAYMENT_V1|${pool.toLowerCase()}|${chainId}|${recipient.toLowerCase()}|${denomination}`).digest('hex')}`;
}

function assertHex(value, name) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw new TypeError(`${name} must be hex`);
}
