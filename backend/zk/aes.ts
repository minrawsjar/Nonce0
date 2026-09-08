// AES-128 as a boolean circuit, written once against `Gates`.
//
// Why AES rather than keccak, when the rest of the protocol hashes with
// keccak: the cost of an MPC-in-the-head proof is dominated by AND gates, and
// keccak is ruinous there. One keccak-f[1600] permutation is ~38,400 AND
// gates; AES-128 is 160 S-boxes. AES also has FIPS-197 test vectors, so
// running THIS SAME CODE under the plain backend proves the circuit itself is
// correct — assurance a hand-transcribed gate list cannot give you.
//
// The S-box is derived, not copied: GF(2^8) inversion by an Itoh-Tsujii
// addition chain (squaring is linear over GF(2), so only the four
// multiplications cost AND gates) then the FIPS-197 affine map. Karatsuba
// brings one GF(2^8) multiply to 27 ANDs, so an S-box costs 108. The published
// Boyar-Peralta circuit does it in 32 and is the obvious next optimisation,
// but it is ~115 hand-copied gates, and a typo in it is invisible until it is
// a soundness bug.

import { plainGates, type Bit, type Gates } from './bits.ts';

/** 8 wires, LSB-first: index i is the coefficient of x^i. */
export type Byte = readonly Bit[];
/** 16 bytes in AES column-major order: index i is row i%4, column i>>2. */
export type Block = readonly Byte[];

const XOR = (g: Gates, a: readonly Bit[], b: readonly Bit[]): Bit[] =>
  a.map((x, i) => g.xor(x, b[i]!));

/** Karatsuba over GF(2)[x]. 8x8 costs 27 ANDs where schoolbook costs 64. */
function polyMul(g: Gates, a: readonly Bit[], b: readonly Bit[]): Bit[] {
  const n = a.length;
  if (n === 1) return [g.and(a[0]!, b[0]!)];
  const h = n >> 1;
  const aLo = a.slice(0, h);
  const aHi = a.slice(h);
  const bLo = b.slice(0, h);
  const bHi = b.slice(h);
  const lo = polyMul(g, aLo, bLo);
  const hi = polyMul(g, aHi, bHi);
  const mid = polyMul(g, XOR(g, aLo, aHi), XOR(g, bLo, bHi));
  const out: Bit[] = Array.from({ length: 2 * n - 1 }, () => g.konst(0));
  for (let i = 0; i < lo.length; i++) {
    out[i] = g.xor(out[i]!, lo[i]!);
    out[h + i] = g.xor(out[h + i]!, g.xor(g.xor(mid[i]!, lo[i]!), hi[i]!));
    out[2 * h + i] = g.xor(out[2 * h + i]!, hi[i]!);
  }
  return out;
}

/** Reduce modulo the AES polynomial x^8 + x^4 + x^3 + x + 1 (0x11b). */
function gfReduce(g: Gates, t: readonly Bit[]): Bit[] {
  const out = t.slice();
  for (let i = out.length - 1; i >= 8; i--) {
    const c = out[i]!;
    out[i - 4] = g.xor(out[i - 4]!, c);
    out[i - 5] = g.xor(out[i - 5]!, c);
    out[i - 7] = g.xor(out[i - 7]!, c);
    out[i - 8] = g.xor(out[i - 8]!, c);
  }
  return out.slice(0, 8);
}

const gfMul = (g: Gates, a: Byte, b: Byte): Byte => gfReduce(g, polyMul(g, a, b));

/** Linear over GF(2): the Frobenius map costs XORs only, never an AND. */
function gfSquare(g: Gates, a: Byte): Byte {
  const spread: Bit[] = Array.from({ length: 15 }, () => g.konst(0));
  for (let i = 0; i < 8; i++) spread[2 * i] = a[i]!;
  return gfReduce(g, spread);
}

export function sbox(g: Gates, a: Byte): Byte {
  const p3 = gfMul(g, gfSquare(g, a), a); //                            x^(2^2-1)
  const p7 = gfMul(g, gfSquare(g, p3), a); //                           x^(2^3-1)
  const p63 = gfMul(g, gfSquare(g, gfSquare(g, gfSquare(g, p7))), p7); // x^(2^6-1)
  const p127 = gfMul(g, gfSquare(g, p63), a); //                        x^(2^7-1)
  const inv = gfSquare(g, p127); // x^254 — the inverse, and 0 maps to 0 as AES requires
  return inv.map((_, i) =>
    g.xorConst(
      g.xor(
        g.xor(inv[i]!, inv[(i + 4) % 8]!),
        g.xor(inv[(i + 5) % 8]!, g.xor(inv[(i + 6) % 8]!, inv[(i + 7) % 8]!)),
      ),
      (0x63 >> i) & 1,
    ),
  );
}

/** Multiply by x, reducing with 0x1b when the top coefficient overflows. */
function xtime(g: Gates, a: Byte): Byte {
  const c = a[7]!;
  return [c, g.xor(a[0]!, c), a[1]!, g.xor(a[2]!, c), g.xor(a[3]!, c), a[4]!, a[5]!, a[6]!];
}

const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36] as const;

/** 44 words as 176 flat bytes. The key is secret, so this costs 40 S-boxes. */
export function keyExpansion(g: Gates, key: Block): Byte[] {
  const w: Byte[] = key.slice();
  for (let i = 4; i < 44; i++) {
    const p = (i - 1) * 4;
    let t: Byte[] = [w[p]!, w[p + 1]!, w[p + 2]!, w[p + 3]!];
    if (i % 4 === 0) {
      t = [t[1]!, t[2]!, t[3]!, t[0]!].map((b) => sbox(g, b));
      const rc = RCON[i / 4 - 1]!;
      t[0] = t[0]!.map((bit, j) => g.xorConst(bit, (rc >> j) & 1));
    }
    for (let j = 0; j < 4; j++) w.push(XOR(g, w[(i - 4) * 4 + j]!, t[j]!));
  }
  return w;
}

export function cipher(g: Gates, roundKeys: readonly Byte[], block: Block): Byte[] {
  let s: Byte[] = block.map((b, i) => XOR(g, b, roundKeys[i]!));

  for (let r = 1; r <= 10; r++) {
    s = s.map((b) => sbox(g, b));

    const shifted: Byte[] = new Array<Byte>(16);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) shifted[row + 4 * col] = s[row + 4 * ((col + row) % 4)]!;
    }
    s = shifted;

    if (r !== 10) {
      const mixed: Byte[] = new Array<Byte>(16);
      for (let col = 0; col < 4; col++) {
        const a0 = s[4 * col]!;
        const a1 = s[4 * col + 1]!;
        const a2 = s[4 * col + 2]!;
        const a3 = s[4 * col + 3]!;
        const d0 = xtime(g, a0);
        const d1 = xtime(g, a1);
        const d2 = xtime(g, a2);
        const d3 = xtime(g, a3);
        mixed[4 * col] = XOR(g, XOR(g, d0, XOR(g, d1, a1)), XOR(g, a2, a3));
        mixed[4 * col + 1] = XOR(g, XOR(g, a0, d1), XOR(g, XOR(g, d2, a2), a3));
        mixed[4 * col + 2] = XOR(g, XOR(g, a0, a1), XOR(g, d2, XOR(g, d3, a3)));
        mixed[4 * col + 3] = XOR(g, XOR(g, d0, a0), XOR(g, a1, XOR(g, a2, d3)));
      }
      s = mixed;
    }

    s = s.map((b, i) => XOR(g, b, roundKeys[16 * r + i]!));
  }
  return s;
}

// ── plain-backend helpers ─────────────────────────────────────────────────

export const constBytes = (g: Gates, bytes: Uint8Array): Byte[] =>
  Array.from(bytes, (v) => Array.from({ length: 8 }, (_, i) => g.konst((v >> i) & 1)));

export function packBytes(bits: readonly Byte[]): Uint8Array {
  const out = new Uint8Array(bits.length);
  bits.forEach((byte, i) => {
    let v = 0;
    for (let b = 0; b < 8; b++) v |= (byte[b]! & 1) << b;
    out[i] = v;
  });
  return out;
}

/**
 * The cleartext cipher — the identical circuit under the plain backend, which
 * is why a FIPS-197 vector passing here is evidence about the PROVER, not just
 * about a second implementation that happens to agree with the test.
 */
export function aes128Encrypt(key: Uint8Array, block: Uint8Array): Uint8Array {
  const g = plainGates();
  return packBytes(cipher(g, keyExpansion(g, constBytes(g, key)), constBytes(g, block)));
}
