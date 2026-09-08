/**
 * Swarnim publishes implementations of these adapter contracts here.
 * Manya's pages import only from this file; they must not call Graph, RPC,
 * relay, CRE, or contract endpoints directly.
 */
export function createProtocolAdapters({ wallet, ring, graph, transport, policy, timedExecutor }) {
  for (const [name, value] of Object.entries({ wallet, ring, graph, transport, policy, timedExecutor })) {
    if (!value) throw new TypeError(`${name} adapter is required`);
  }
  return Object.freeze({ wallet, ring, graph, transport, policy, timedExecutor });
}
