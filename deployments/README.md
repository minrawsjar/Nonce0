# Deployments: Every Public Address

> **One JSON file, read by the backend, the wallet, the deploy scripts and the subgraph renderer.**

[`arc-testnet.json`](arc-testnet.json) is the single source of truth for every public address and endpoint on Arc testnet: the network, USDC, every contract, every pool, the ERC-4337 EntryPoints and bundler, the relay directory's trust root and the service URLs. Public values only; never a private key, API key or MAC.

## Files

| File | Purpose |
|---|---|
| `arc-testnet.json` | The data |
| `index.ts` | The typed loader: `deployment`, `requireContract`, `requireService`, `poolFor`, `meshTrustRoot`, `entryPoint` |

## Rules

- **`null` means not deployed.** The loader refuses it wherever a value is required. A zero address would fail silently on chain instead.
- **The wallet compiles this file in.** Pools and the relay trust root come from here, never from a server. A server that could name the pools could take the deposits.
- **Checked against the chain.** `backend/chain/test/deployments.test.ts` confirms every address has code and every pool reports the mode listed.

```bash
cd backend && node --test chain/test/deployments.test.ts
```

Human-readable notes on each address are in [docs/deployment-arc-testnet.md](../docs/deployment-arc-testnet.md).
