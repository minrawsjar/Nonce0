// FFI test helper. Only deterministic, public fixture seeds are supported.
import { keyGen, sign, encodeSignature, pkCommitment } from '../src/fors.ts';
import { asBytes32 } from '@opaque/protocol-types/codecs.js';
const seedId = Number(process.argv[3] ?? '1');
if (!Number.isInteger(seedId) || seedId < 1 || seedId > 4) throw new Error('Public test seed IDs 1..4 only');
const pair = keyGen(new Uint8Array(32).fill(seedId), { k: 32, a: 8 });
process.stdout.write(process.argv[2] === 'commitment' ? pkCommitment(pair.publicKey)
  : encodeSignature(pair.publicKey, sign(pair.secretKey, asBytes32(process.argv[2]))));
