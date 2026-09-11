#!/usr/bin/env node
// The CRE key ceremony, run once per key version.
//
// Two secrets, written to .env.live (gitignored, 0600) and never printed:
//
//   OPAQUE_SEED_HEX   the 64-byte ML-KEM-768 seed. The Vault DON holds it as
//                     INTENT_KEY_SEED; the enclave derives the decapsulation
//                     key from it (2,400 bytes would not fit a 2 KB secret).
//   OPAQUE_MAC_HEX    32 bytes shared by CRE (CREDENTIAL_MAC) and the executor:
//                     it verifies credentials and tags CRE's decisions.
//
// The public half goes to cre-public-key.hex, for the executor's
// CRE_INTENT_PUBLIC_KEY; the executor publishes it in stack.json.
//
// Refuses to overwrite: .env.live is the one copy outside Vault and Railway,
// and replacing it strands every payment sealed to the old key.

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

import { toHex } from '@opaque/protocol-types/codecs.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.env.live');
if (existsSync(out)) {
  process.stderr.write('.env.live exists: refusing to replace a live key\n');
  process.exit(1);
}
const seed = crypto.getRandomValues(new Uint8Array(64));
const mac = crypto.getRandomValues(new Uint8Array(32));
writeFileSync(out, `OPAQUE_SEED_HEX=${toHex(seed)}\nOPAQUE_MAC_HEX=${toHex(mac)}\n`, { mode: 0o600, flag: 'wx' });

const publicKey = toHex(ml_kem768.keygen(seed).publicKey);
writeFileSync(join(root, 'cre-public-key.hex'), `${publicKey}\n`);
process.stdout.write(`wrote .env.live (0600); public key ${publicKey.slice(0, 18)}… in cre-public-key.hex\n`);
