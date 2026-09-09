// Turning a pinned directory into a usable mesh.
//
// client.ts can build an onion for any path. directory.ts can say which relays
// exist and prove it. Nothing joined them, so the transport had no way to be
// constructed and the frontend's `transport` port stayed empty. This is the
// join.
//
// ── Bootstrap order is the security property ─────────────────────────────
//
// The directory is verified against a root PINNED IN THE APPLICATION before
// any relay is contacted, and before the Graph is asked anything at all. That
// ordering is not incidental: the Graph is reached THROUGH the mesh, so if
// relay keys came from a Graph response the first query would be answered by
// whoever wanted to answer it, and every layer after that would be encrypted
// to their keys. An untrusted response can never replace a key.
//
// ── A fresh path per call ────────────────────────────────────────────────
//
// selectPath runs per request, not once per session. Two reads by one wallet
// therefore share no route, and a relay that happens to sit on both sees two
// unrelated messages instead of one client's session. A cached path is a
// standing circuit, which is the thing three hops exist to avoid.
//
// Which is why the pool floor (MIN_POOL_RELAYS) is twice the hop count. Drawing
// three hops from exactly three relays is not a draw, and the graph feed's
// ranking would decide nothing — every payment would take the one route that
// exists. Six running relays make the route a per-payment property.

import {
  ProtocolFailure,
  type PathSelectionPolicy,
  type PrivacyTransport,
  type PrivacyScore,
  type RelayNode,
  type RelayPath,
  type RelaySnapshot,
  type UnixSeconds,
} from '@opaque/protocol-types';
import { assertRelayPath } from '@opaque/protocol-types/codecs.js';

import { createMeshTransport, type MeshClientOptions } from './client.ts';
import { MIN_POOL_RELAYS, PATH_HOPS } from './contracts.ts';
import type { DirectoryTrustRoot, RelayDirectory, SignedDirectory } from './contracts.ts';
import { accept } from './directory.ts';

export interface MeshBootstrapOptions {
  /** Shipped with the client and pinned. Never fetched. */
  readonly root: DirectoryTrustRoot;
  readonly signed: SignedDirectory;
  readonly pathPolicy: PathSelectionPolicy;
  /**
   * The §8.2 health feed. Called per relay, per snapshot — so a relay that
   * fills up between two payments is seen as full on the second.
   *
   * It observes; it never adds or removes. A feed that could introduce a relay
   * would be a feed that could put its own relay on every path, and the whole
   * bootstrap order exists to stop exactly that: keys come from the pinned
   * directory and nothing reached over the network can replace one.
   */
  readonly health?: (entry: RelayDirectory['entries'][number]) => RelayHealth;
  readonly now?: () => UnixSeconds;
  readonly client?: MeshClientOptions;
}

export interface MeshBootstrap {
  readonly transport: PrivacyTransport;
  /** The verified directory, and the root to pin from here on. */
  readonly directory: RelayDirectory;
  readonly nextRoot: DirectoryTrustRoot;
  /** Draws a FRESH path. Called once per request, never cached. */
  pathFor(): Promise<RelayPath>;
  /** What the policy sees. Live entries only, as of `now`. */
  snapshot(): RelaySnapshot;
}

/**
 * What a health feed reports about one relay. Supplied by the Graph observer
 * (§8.2); absent until one is wired, which is what UNIFORM_PRIOR is for.
 */
export interface RelayHealth {
  readonly reliabilityScore: PrivacyScore;
  readonly batchOccupancy: number;
  readonly recentSelectionCount: number;
}

/**
 * NOT a measurement, and the naming says so. A directory says who a relay is
 * and which key it holds; it says nothing about how busy or how reliable that
 * relay is, and inventing a number per relay would let the policy weight on
 * noise while looking informed.
 *
 * So every relay gets the SAME number, which is a uniform prior rather than an
 * observation: the §8.2 chain degrades to drawing uniformly at random from the
 * pool, under the distinct-operator rule. That is a defensible selection and,
 * more to the point, an honest one.
 *
 * `batchOccupancy` is 1 rather than 0 for a reason worth stating, because 0 is
 * what it used to be. MarkovPathPolicy weights on `occupancy / (1 + recent)`
 * and drops every node at weight 0, so a pool reported as uniformly idle is a
 * pool it refuses entirely — six live relays and `need 3 distinct operators
 * above the reliability floor, have 0`. Flat-zero was not a neutral default; it
 * was an unusable one.
 */
const UNIFORM_PRIOR: RelayHealth = {
  reliabilityScore: 5_000 as PrivacyScore,
  batchOccupancy: 1,
  recentSelectionCount: 0,
};

/** A directory entry, as the path policy wants to see it. */
const toNode = (
  entry: RelayDirectory['entries'][number],
  observedAt: UnixSeconds,
  health: RelayHealth,
): RelayNode => ({
  id: entry.id,
  endpoint: entry.endpoint,
  kemPublicKey: entry.kemPublicKey,
  keyEpoch: entry.keyEpoch,
  operatorId: entry.operatorId,
  reliabilityScore: health.reliabilityScore,
  batchOccupancy: health.batchOccupancy,
  recentSelectionCount: health.recentSelectionCount,
  lastSeenAt: observedAt,
});

export function createMeshBootstrap(options: MeshBootstrapOptions): MeshBootstrap {
  const now = options.now ?? (() => BigInt(Math.floor(Date.now() / 1000)) as UnixSeconds);

  // VERIFY FIRST. Throws UNTRUSTED_DIRECTORY rather than returning a flag,
  // so a caller that forgets to check cannot end up with a working mesh and
  // no trust. accept() also walks the hash chain, so nextRoot is what the
  // application pins from here and replaying this version is refused next time.
  const { directory, nextRoot } = accept(options.signed, options.root, now());

  const transport = createMeshTransport({
    ...options.client,
    // subscribe() polls, and each poll must draw its own path for the same
    // reason every other call does.
    pathFor: async () => pathFor(),
  });

  function snapshot(): RelaySnapshot {
    const at = now();
    const nodes = directory.entries
      // Live only. An expired entry cannot carry a message, and offering it to
      // the policy would let a dead relay dilute the selection it weights over.
      .filter((entry) => at >= entry.validFrom && at < entry.validUntil)
      .map((entry) => toNode(entry, at, options.health?.(entry) ?? UNIFORM_PRIOR));
    return { nodes, directoryVersion: directory.version.toString(10), observedAt: at };
  }

  async function pathFor(): Promise<RelayPath> {
    const live = snapshot();
    // Checked against the POOL floor, not the hop count. Three live relays
    // would build a path — the same path, every time, because there is nothing
    // else to draw. That is a standing circuit with extra steps, so it is
    // refused here rather than served as a working mesh.
    if (live.nodes.length < MIN_POOL_RELAYS) {
      throw new ProtocolFailure(
        'INSUFFICIENT_RELAYS',
        `the directory has ${live.nodes.length} live relays; ` +
          `a ${PATH_HOPS}-hop path must be drawn from at least ${MIN_POOL_RELAYS}`,
      );
    }
    const { nodes } = options.pathPolicy.selectPath(live);
    // Checked here even though the policy is trusted: assertRelayPath is what
    // enforces no repeated relay AND no repeated operator, and a policy bug
    // that returned one operator three times would otherwise build a path that
    // colludes with itself and still looks like three hops.
    assertRelayPath(nodes);
    return nodes;
  }

  return { transport, directory, nextRoot, pathFor, snapshot };
}
