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
import type { DirectoryTrustRoot, RelayDirectory, SignedDirectory } from './contracts.ts';
import { accept } from './directory.ts';

export interface MeshBootstrapOptions {
  /** Shipped with the client and pinned. Never fetched. */
  readonly root: DirectoryTrustRoot;
  readonly signed: SignedDirectory;
  readonly pathPolicy: PathSelectionPolicy;
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
 * A directory entry, as the path policy wants to see it.
 *
 * The three scores below are NOT measurements. A directory says who a relay is
 * and which key it holds; it says nothing about how reliable or how busy that
 * relay is. Reporting a made-up number as an observation would let the policy
 * weight on noise while looking informed, so they are flat and the policy
 * chooses on structure alone until a real observer supplies better.
 */
const toNode = (entry: RelayDirectory['entries'][number], observedAt: UnixSeconds): RelayNode => ({
  id: entry.id,
  endpoint: entry.endpoint,
  kemPublicKey: entry.kemPublicKey,
  keyEpoch: entry.keyEpoch,
  operatorId: entry.operatorId,
  reliabilityScore: 5_000 as PrivacyScore,
  batchOccupancy: 0,
  recentSelectionCount: 0,
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
      .map((entry) => toNode(entry, at));
    return { nodes, directoryVersion: directory.version.toString(10), observedAt: at };
  }

  async function pathFor(): Promise<RelayPath> {
    const live = snapshot();
    if (live.nodes.length < 3) {
      throw new ProtocolFailure(
        'INSUFFICIENT_RELAYS',
        `the directory has ${live.nodes.length} live relays and a path needs 3`,
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
