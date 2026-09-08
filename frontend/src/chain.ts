// The seam between the UI and the chain.
//
// Every type here mirrors a struct in docs/project-x-spec-v2.md so that wiring
// this up is a swap of function bodies, not a rewrite. Each function that will
// need a real call is marked WIRE: with the spec section that defines it.
//
// Until then the state below is local and the UI says so on screen.

// ── money ─────────────────────────────────────────────────────────────────
//
// Arc exposes ONE balance through two interfaces with different precision:
// native USDC has 18 decimals (gas, msg.value) and the ERC-20 interface has 6
// (transfers, allowances). Mixing them is a factor of 10^12 — a $50 payment
// becomes $50 trillion, or dust.
//
// The two brands below make that mistake a compile error rather than a
// post-mortem. They cost nothing at runtime: a brand is erased entirely, and
// both values are plain bigints once the type checker is done.

declare const brand: unique symbol;
type Branded<T, B extends string> = T & { readonly [brand]: B };

/** USDC through the ERC-20 interface — 6 decimals. Balances and payments. */
export type Usdc6 = Branded<bigint, 'Usdc6'>;
/** Native USDC on Arc — 18 decimals. Gas accounting and msg.value only. */
export type Wei18 = Branded<bigint, 'Wei18'>;

export const usdc6 = (raw: bigint): Usdc6 => raw as Usdc6;
export const wei18 = (raw: bigint): Wei18 => raw as Wei18;

/** Parse human input ("50.00") into the 6-decimal ERC-20 unit. */
export function parseUsdc(input: string): Usdc6 | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(input.trim());
  if (!match) return null;
  const whole = match[1] ?? '0';
  const frac = (match[2] ?? '').padEnd(6, '0');
  return usdc6(BigInt(whole) * 1_000_000n + BigInt(frac));
}

export function formatUsdc(value: Usdc6): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 1_000_000n;
  const cents = (abs % 1_000_000n) / 10_000n;
  return `${negative ? '-' : ''}${whole.toLocaleString('en-US')}.${String(cents).padStart(2, '0')}`;
}

/** Native wei (18dp) down to the ERC-20 unit (6dp). Truncates, as the EVM does. */
export const weiToUsdc = (value: Wei18): Usdc6 => usdc6(value / 1_000_000_000_000n);

// ── the fee ───────────────────────────────────────────────────────────────
//
// Arc's protocol floor is a 20 Gwei base fee and its per-block ceiling is 30M
// gas. The ring verifier is the only thing in this design big enough to care:
// at the floor, a full 30M-gas verification costs 0.60 USDC. The real figure
// arrives with the §6.3 spike — until then this is the honest worst case.

export const RING_VERIFY_GAS = 30_000_000n;
export const ARC_MIN_BASE_FEE = 20_000_000_000n; // 20 Gwei, in wei

export const gasCost = (gas: bigint): Wei18 => wei18(gas * ARC_MIN_BASE_FEE);

// ── spec types ────────────────────────────────────────────────────────────

export type Hex = `0x${string}`;

/** §5.2 PQKeyState. `useCount` is monotonic and checked on every verification. */
export interface KeyState {
  pkCommitment: Hex;
  useCount: number;
  maxUses: number;
  /** ISO date. Rotation must be authorised by the current PQ key, never a fallback. */
  rotationDeadline: string;
  /** 0 = active; otherwise the timestamp the 30-day disable timelock elapses. */
  disableAfter: number;
}

/** §9.1 PaymentIntent, held encrypted in the CRE enclave until it fires. */
export interface PaymentIntent {
  recipient: Hex;
  amount: Usdc6;
  deadlineHours: number;
  minFreshnessScore: number;
  status: 'armed' | 'settled';
  /** Set on settlement: §6.4's linkability tag, which prevents double-spend. */
  nullifier?: Hex;
  firedAt?: number;
}

/** §8.1 RingPool — aggregate only. Never index which member signed what. */
export interface RingPool {
  poolSize: number;
  freshnessScore: number;
}

// ── local state ───────────────────────────────────────────────────────────

const random = (bytes: number): Hex =>
  `0x${Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;

const state = {
  // WIRE: PQKeyRegistry.keyOf(wallet) — §5.2.
  key: {
    pkCommitment: '0x7c1ae93f' as Hex,
    useCount: 6,
    maxUses: 24,
    rotationDeadline: '2026-10-08',
    disableAfter: 0,
  } satisfies KeyState,

  // WIRE: USDC balanceOf through the ERC-20 interface at
  // 0x3600000000000000000000000000000000000000 — §Arc contract addresses.
  balance: usdc6(1_240_500_000n),

  // WIRE: the RingPool entity from the subgraph — §8.1.
  pool: { poolSize: 1284, freshnessScore: 62 } satisfies RingPool,

  intents: [] as PaymentIntent[],
};

export const getKey = (): KeyState => ({ ...state.key });
export const getBalance = (): Usdc6 => state.balance;
export const getPool = (): RingPool => ({ ...state.pool });
export const getIntents = (): readonly PaymentIntent[] => state.intents;

/**
 * WIRE: §8.1. The real draw queries RingMember entities, excludes anything
 * above the reuse threshold, weights toward enrolment-age diversity, and
 * samples 7 decoys plus the signer — client-side, never server-side.
 *
 * The return carries no "this one is mine" flag, by construction. A renderer
 * cannot leak a distinction the data does not contain.
 */
export const drawRing = (size = 8): readonly Hex[] =>
  Array.from({ length: size }, () => random(4));

/** WIRE: §8.2. Three hops drawn from the Markov chain over the six-node pool. */
export function drawHops(): readonly string[] {
  const pool = ['N1', 'N2', 'N3', 'N4', 'N5', 'N6'];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0]! % (i + 1);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, 3);
}

export function armIntent(
  intent: Omit<PaymentIntent, 'status' | 'nullifier' | 'firedAt'>,
): void {
  state.intents.unshift({ ...intent, status: 'armed' });
}

/**
 * Advance the simulation one step.
 *
 * WIRE: none of this belongs on the client. The trigger below is evaluated
 * INSIDE the Chainlink CRE enclave (§9.2) precisely so that the recipient, the
 * amount and the threshold are not public before execution. Running it here is
 * what makes the waiting-intent behaviour visible in a demo, and is exactly
 * what must not ship.
 */
export function tick(): void {
  const drift = (Math.random() - 0.45) * 9;
  state.pool.freshnessScore = Math.min(100, Math.max(0, state.pool.freshnessScore + drift));

  for (const intent of state.intents) {
    if (intent.status !== 'armed') continue;
    if (state.pool.freshnessScore < intent.minFreshnessScore) continue;
    if (state.key.maxUses - state.key.useCount <= 0) continue;

    intent.status = 'settled';
    intent.firedAt = Math.round(state.pool.freshnessScore);
    intent.nullifier = random(8);
    state.key.useCount += 1; // the signature budget is finite; spending is real
    state.balance = usdc6(state.balance - intent.amount);
  }
}
