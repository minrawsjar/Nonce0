// Chain list for the exposure oracle.
//
// .js and not .json deliberately: no ESM import-attributes friction, no extra
// entry in package.json files[], and comments survive.
//
// Each chain carries an ORDERED list of endpoints, not one URL. This is not
// defensive programming, it is measured: probing nine popular Ethereum mainnet
// endpoints on 2026-09-07, six failed — one returned an HTML error page, two
// rejected JSON-RPC batch arrays, three failed DNS. Public RPC is unreliable
// enough that a single-endpoint oracle reports garbage on a normal afternoon.
//
// `subgraph: null` everywhere IS the Graph go/no-go hedge (docs/sponsor-plan.md
// §4.1). The RPC nonce path is always primary and always sufficient; subgraph
// enrichment only ever ADDS evidence fields (recovered key, first exposing block,
// linkable tx hash). If the indexer never ships, nothing here changes.
//
// THE INVARIANT THAT MATTERS: a failed RPC call must never render as nonce 0.
// Exposure is three-valued — exposed | not-exposed | unknown — and `unknown` must
// be loud. A network blip that reads as "your keys are safe" is the worst bug
// this tool could have. Same failure mode as PQG-000 unresolved authority.

export const CHAINS = [
  { name: 'ethereum',     chainId: 1,        testnet: false, subgraph: null,
    rpc: ['https://rpc.flashbots.net', 'https://gateway.tenderly.co/public/mainnet', 'https://1rpc.io/eth'] },
  { name: 'base',         chainId: 8453,     testnet: false, subgraph: null,
    rpc: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org'] },
  { name: 'arbitrum',     chainId: 42161,    testnet: false, subgraph: null,
    rpc: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.drpc.org'] },
  { name: 'optimism',     chainId: 10,       testnet: false, subgraph: null,
    rpc: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io', 'https://optimism.drpc.org'] },
  { name: 'polygon',      chainId: 137,      testnet: false, subgraph: null,
    rpc: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'] },
  { name: 'bsc',          chainId: 56,       testnet: false, subgraph: null,
    rpc: ['https://bsc-rpc.publicnode.com'] },
  // Testnets are not a lesser check. One throwaway Sepolia transaction publishes
  // the key permanently, on every chain at once. This is the finding nobody else
  // computes, so testnets are scanned by default.
  { name: 'sepolia',      chainId: 11155111, testnet: true,  subgraph: null,
    rpc: ['https://ethereum-sepolia-rpc.publicnode.com'] },
  { name: 'base-sepolia', chainId: 84532,    testnet: true,  subgraph: null,
    rpc: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'] },
];

/** Env override wins: NONCE0_RPC_<chainId>. See .env.example. */
export function endpointsFor(chain, env = process.env) {
  const override = env[`NONCE0_RPC_${chain.chainId}`];
  return override ? [override, ...chain.rpc] : chain.rpc;
}

export const EXPOSURE = { EXPOSED: 'exposed', NOT_EXPOSED: 'not-exposed', UNKNOWN: 'unknown' };
