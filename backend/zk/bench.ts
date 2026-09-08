// The §6.3 mandatory spike, as a runnable script rather than an assertion.
//
//   node zk/bench.ts [reps]
//
// §6.3 asks for proof size, generation time and on-chain verification gas, and
// then a documented go/no-go before anything else depends on the ring. Those
// four things are what this prints. The gas model is deliberately generous to
// the design being measured — see the notes it emits.

import type { PoolScope } from '@opaque/protocol-types';
import { asAddress, asChainId, asRing8, fromHex } from '@opaque/protocol-types/codecs.js';

import { plainGates } from './bits.ts';
import { evaluate, publicInputs, WITNESS_BITS } from './statement.ts';
import { buildRingSpend, deriveCommitment, verifyRingSpend } from './spend.ts';
import { REPS_128 } from './zkboo.ts';

const REPS = Number(process.argv[2] ?? REPS_128);

const scope: PoolScope = {
  chainId: asChainId(5042002n),
  pool: asAddress(`0x${'11'.repeat(20)}`),
  denomination: 1_000_000,
};
const recipient = asAddress(`0x${'aa'.repeat(20)}`);
const secrets = Array.from({ length: 8 }, (_, n) =>
  Uint8Array.from({ length: 16 }, (_, i) => n * 31 + i + 1),
);
const commitments = secrets.map((s) => deriveCommitment(s, scope));
const ring = asRing8([...commitments].sort());

const g = plainGates();
evaluate(g, publicInputs(scope, ring), new Array<number>(WITNESS_BITS).fill(0));
const ands = g.andCount();
const xors = g.xorCount();

const t0 = performance.now();
const spend = buildRingSpend({
  scope, recipient, noteSecret: secrets[0]!, decoys: commitments.slice(1), reps: REPS,
});
const proveMs = performance.now() - t0;

const t1 = performance.now();
const ok = verifyRingSpend(spend);
const verifyMs = performance.now() - t1;

const bytes = fromHex(spend.proof).length;

// Arc: 30,000,000 gas per block, minimum base fee 20 Gwei, USDC-native gas.
const ARC_BLOCK_GAS = 30_000_000;
const ARC_MIN_BASE_FEE_GWEI = 20;

// Calldata only, assuming EVERY byte is non-zero (16 gas). This is the floor:
// it is what submitting the proof costs before a single gate is evaluated.
const calldataGas = bytes * 16;

// One bit-operation per gate, in a 256-bit machine with no bitwise-parallel
// layout, is charity: 3 gas is roughly a single ADD/AND on values already in
// stack slots, with no memory traffic, no loop overhead and no loads. Real
// Solidity would spend 20-50.
const OPTIMISTIC_GAS_PER_GATE = 3;
const verifyGas = REPS * (ands + xors) * OPTIMISTIC_GAS_PER_GATE;

const row = (k: string, v: string): string => `  ${k.padEnd(34)}${v}`;
const usdc = (gas: number): string =>
  `${((gas * ARC_MIN_BASE_FEE_GWEI) / 1e9).toFixed(2)} USDC at the 20 Gwei floor`;

console.log(`\nOpaque §6.3 spike — MPC-in-the-head ring proof (ZKBoo / AES-128 / ring 8)\n`);
console.log(row('repetitions', `${REPS}${REPS === REPS_128 ? '  (soundness 2^-128)' : '  (BENCH ONLY)'}`));
console.log(row('AND gates per repetition', ands.toLocaleString()));
console.log(row('XOR gates per repetition', xors.toLocaleString()));
console.log(row('proof size', `${(bytes / 1024).toFixed(1)} KiB  (${bytes.toLocaleString()} bytes)`));
console.log(row('proof size as 0x-hex', `${((bytes * 2 + 2) / 1024).toFixed(1)} KiB`));
console.log(row('prove', `${proveMs.toFixed(0)} ms`));
console.log(row('verify (off-chain)', `${verifyMs.toFixed(0)} ms  -> ${ok ? 'ACCEPT' : 'REJECT'}`));
console.log();
console.log(row('Arc block gas limit', ARC_BLOCK_GAS.toLocaleString()));
console.log(row('calldata alone', `${calldataGas.toLocaleString()} gas  = ${(calldataGas / ARC_BLOCK_GAS).toFixed(1)}x a full block`));
console.log(row('', usdc(calldataGas)));
console.log(row(`verification at ${OPTIMISTIC_GAS_PER_GATE} gas/gate`, `${verifyGas.toLocaleString()} gas  = ${(verifyGas / ARC_BLOCK_GAS).toFixed(0)}x a full block`));
console.log(row('', usdc(verifyGas)));
console.log(`
  Not modelled, and each one is on its own fatal:
    - the tapes are SHAKE256, and the EVM has no SHAKE and no raw keccak-f
      opcode; KECCAK256 is the padded sponge, so the extendable output would
      have to be built in Solidity from scratch
    - ${(REPS * 2).toLocaleString()} view commitments, each hashing ~${((ands / 8) / 1024).toFixed(1)} KiB
    - the proof exceeds ordinary transaction-size limits before it is priced

  GO/NO-GO: on-chain verification is NO-GO, by a margin no optimisation closes.
  Off-chain verification is GO, and is what the ${verifyMs.toFixed(0)} ms above measures.
  See README.md for what that leaves standing.
`);
