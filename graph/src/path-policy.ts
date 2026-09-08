// §8.2 — relay hop selection as a short-run Markov chain over the node pool.
//
//   P(hop1 = j)  ∝ batchOccupancy(j) / (1 + recentSelectionCount(j))
//   P(i → j)     = 0 for j == i and for j below the reliability floor,
//                  ∝ the same ratio otherwise, row-normalised.
//
// Deliberately NOT a deterministic top-3: always drawing the three objectively
// best nodes replaces a random pattern with a permanent static one, which is
// the exact failure `recentSelectionCount` exists to prevent.
//
// One deviation from the spec's transition rule, and it is a widening: the
// spec zeroes j == i, while assertRelayPath (protocol-types) also requires
// three distinct OPERATORS. Three nodes run by one operator are one hop's
// worth of protection, so the row zeroes every node of an already-used
// operator, not just the used node itself.

import {
  ProtocolFailure,
  type PathSelectionPolicy,
  type PrivacyScore,
  type RelayNode,
  type RelayPath,
  type RelaySnapshot,
} from '@opaque/protocol-types';
import { asPrivacyScore, assertRelayPath } from '@opaque/protocol-types/codecs.js';

/** 50% of recent batch windows served. Tuning knob, not a protocol constant. */
export const DEFAULT_RELIABILITY_FLOOR: PrivacyScore = asPrivacyScore(5_000);

export interface MarkovPathPolicyOptions {
  /** Injected so tests are deterministic. Must return a value in [0, 1). */
  readonly random?: () => number;
  /** Nodes scoring below this are excluded from every row, including hop 1. */
  readonly reliabilityFloor?: number;
}

interface Weighted {
  readonly node: RelayNode;
  readonly weight: number;
}

function weigh(node: RelayNode): Weighted {
  const { batchOccupancy: occupancy, recentSelectionCount: recent } = node;
  if (!Number.isFinite(occupancy) || occupancy < 0) {
    throw new ProtocolFailure('INVALID_INPUT', 'batchOccupancy must be a non-negative finite number');
  }
  if (!Number.isInteger(recent) || recent < 0) {
    throw new ProtocolFailure('INVALID_INPUT', 'recentSelectionCount must be a non-negative integer');
  }
  return { node, weight: occupancy / (1 + recent) };
}

/** Index of the drawn row entry. `total` is passed in so it is computed once. */
function draw(row: readonly Weighted[], total: number, r: number): number {
  if (!(r >= 0 && r < 1)) {
    throw new ProtocolFailure('INVALID_INPUT', 'random source must return a value in [0, 1)');
  }
  const target = r * total;
  let acc = 0;
  for (let i = 0; i < row.length; i++) {
    acc += row[i]!.weight;
    if (target < acc) return i;
  }
  // Only reachable through floating-point drift at the very top of the range.
  return row.length - 1;
}

export class MarkovPathPolicy implements PathSelectionPolicy {
  readonly #random: () => number;
  readonly #floor: PrivacyScore;

  constructor(options: MarkovPathPolicyOptions = {}) {
    this.#random = options.random ?? Math.random;
    this.#floor =
      options.reliabilityFloor === undefined
        ? DEFAULT_RELIABILITY_FLOOR
        : asPrivacyScore(options.reliabilityFloor);
  }

  selectPath(snapshot: RelaySnapshot): {
    readonly nodes: RelayPath;
    readonly probabilities: readonly [number, number, number];
  } {
    // A node at weight 0 (no batch cover) can never be drawn, so it is not
    // capacity — counting it toward feasibility would let selectPath commit to
    // a path it cannot finish.
    const eligible = snapshot.nodes
      .map(weigh)
      .filter((w) => w.node.reliabilityScore >= this.#floor && w.weight > 0);

    const operators = new Set(eligible.map((w) => w.node.operatorId));
    if (operators.size < 3) {
      throw new ProtocolFailure(
        'INSUFFICIENT_RELAYS',
        `need 3 distinct operators above the reliability floor, have ${operators.size}`,
        true,
      );
    }

    // With >= 3 distinct operators available, no row can empty out after two
    // draws, so the walk below cannot dead-end.
    const chosen: RelayNode[] = [];
    const probabilities: number[] = [];
    const used = new Set<string>();

    for (let hop = 0; hop < 3; hop++) {
      const row = eligible.filter((w) => !used.has(w.node.operatorId));
      const total = row.reduce((sum, w) => sum + w.weight, 0);
      const picked = row[draw(row, total, this.#random())]!;
      chosen.push(picked.node);
      probabilities.push(picked.weight / total);
      used.add(picked.node.operatorId);
    }

    assertRelayPath(chosen);
    return {
      nodes: chosen,
      probabilities: [probabilities[0]!, probabilities[1]!, probabilities[2]!],
    };
  }
}
