// The (2,3)-decomposition of ZKBoo, as three interchangeable evaluators.
//
// The circuit is written ONCE, against `Gates`, and run under a different
// backend per role: plain evaluation (which also counts AND gates), proving
// (three shares at once), and verification (the two shares a challenge opens).
//
// Writing it once is the whole point. A prover and a verifier that are two
// separate transcriptions of "the same" circuit are one typo away from a proof
// system that accepts nothing — or, far worse, one that accepts anything.
//
// A wire is a plain `number` carrying the packed shares, so XOR costs one
// machine XOR across all parties at once. Only a real AND gate has to unpack.

/** A wire. Bit i of the packed value is party i's share of the real bit. */
export type Bit = number;

export interface Gates {
  xor(a: Bit, b: Bit): Bit;
  and(a: Bit, b: Bit): Bit;
  /** XOR with a PUBLIC constant: only party 0 applies it. */
  xorConst(a: Bit, c: number): Bit;
  /** AND with a PUBLIC constant: linear in the shares, so it costs no randomness. */
  andConst(a: Bit, c: number): Bit;
  konst(c: number): Bit;
}

export const bitAt = (buf: Uint8Array, i: number): number => (buf[i >> 3]! >> (i & 7)) & 1;

export function setBit(buf: Uint8Array, i: number, v: number): void {
  if (v) buf[i >> 3] = buf[i >> 3]! | (1 << (i & 7));
}

/** Cleartext evaluation. Doubles as the gate counter, since control flow in the
 *  circuit never depends on a wire value — the count is the same every run. */
export function plainGates(): Gates & { andCount(): number; xorCount(): number } {
  let ands = 0;
  let xors = 0;
  return {
    xor: (a, b) => {
      xors++;
      return a ^ b;
    },
    and: (a, b) => {
      ands++;
      return a & b;
    },
    xorConst: (a, c) => a ^ c,
    andConst: (a, c) => a & -c,
    konst: (c) => c,
    andCount: () => ands,
    xorCount: () => xors,
  };
}

/**
 * Three shares in bits 0..2. Party 0 holds bit 0, which is why it is the party
 * that absorbs public constants: (a0^c) ^ a1 ^ a2 == (a0^a1^a2) ^ c.
 */
export function proverGates(tapes: readonly Uint8Array[], views: readonly Uint8Array[]): Gates {
  let c = 0;
  const [t0, t1, t2] = [tapes[0]!, tapes[1]!, tapes[2]!];
  const [v0, v1, v2] = [views[0]!, views[1]!, views[2]!];
  return {
    xor: (a, b) => a ^ b,
    xorConst: (a, k) => a ^ k,
    andConst: (a, k) => a & -k,
    konst: (k) => k,
    and(a, b) {
      const a0 = a & 1;
      const a1 = (a >> 1) & 1;
      const a2 = (a >> 2) & 1;
      const b0 = b & 1;
      const b1 = (b >> 1) & 1;
      const b2 = (b >> 2) & 1;
      const r0 = bitAt(t0, c);
      const r1 = bitAt(t1, c);
      const r2 = bitAt(t2, c);
      // Summed over the three parties, the nine (a_i & b_j) terms reconstruct
      // a*b exactly once each, and every r appears twice and cancels.
      const z0 = (a0 & b1) ^ (a1 & b0) ^ (a0 & b0) ^ r0 ^ r1;
      const z1 = (a1 & b2) ^ (a2 & b1) ^ (a1 & b1) ^ r1 ^ r2;
      const z2 = (a2 & b0) ^ (a0 & b2) ^ (a2 & b2) ^ r2 ^ r0;
      setBit(v0, c, z0);
      setBit(v1, c, z1);
      setBit(v2, c, z2);
      c++;
      return z0 | (z1 << 1) | (z2 << 2);
    },
  };
}

export interface VerifierTape {
  /** The opened challenge: parties e and e+1 mod 3. */
  readonly e: number;
  readonly tapeE: Uint8Array;
  readonly tapeE1: Uint8Array;
  /** Party e+1's AND outputs, taken from the proof — it cannot be recomputed. */
  readonly viewE1: Uint8Array;
  /** Party e's AND outputs, recomputed here. This is the consistency check. */
  readonly recomputed: Uint8Array;
}

/**
 * Two shares in bits 0..1: position 0 is party e, position 1 is party e+1.
 * Party e's AND outputs ARE recomputable from the two opened tapes; party
 * e+1's are not, because that would need party e+2's wires. That asymmetry is
 * exactly why the proof has to carry a transcript at all.
 */
export function verifierGates(tape: VerifierTape): Gates {
  let c = 0;
  // Party 0 sits at position 0 when e==0 and at position 1 when e==2. When
  // e==1 the opened pair is {1,2} and party 0 is absent, so a public constant
  // must be applied to NEITHER opened share.
  const p0 = tape.e === 0 ? 1 : tape.e === 2 ? 2 : 0;
  return {
    xor: (a, b) => a ^ b,
    xorConst: (a, k) => (k ? a ^ p0 : a),
    andConst: (a, k) => a & -k,
    konst: (k) => (k ? p0 : 0),
    and(a, b) {
      const a0 = a & 1;
      const a1 = (a >> 1) & 1;
      const b0 = b & 1;
      const b1 = (b >> 1) & 1;
      const z0 =
        (a0 & b1) ^ (a1 & b0) ^ (a0 & b0) ^ bitAt(tape.tapeE, c) ^ bitAt(tape.tapeE1, c);
      const z1 = bitAt(tape.viewE1, c);
      setBit(tape.recomputed, c, z0);
      c++;
      return z0 | (z1 << 1);
    },
  };
}
