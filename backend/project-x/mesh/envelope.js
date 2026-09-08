export function validateMeshEnvelope(envelope, now = Math.floor(Date.now() / 1000)) {
  if (envelope?.version !== 1) throw new Error('unsupported mesh envelope version');
  if (!['PAYMENT', 'QUERY'].includes(envelope.type)) throw new Error('unsupported mesh envelope type');
  if (!envelope.messageId || !envelope.kemCiphertext || !envelope.nonce || !envelope.ciphertext) throw new Error('malformed encrypted mesh envelope');
  if (envelope.expiresAt < now) throw new Error('expired mesh envelope');
  return true;
}
