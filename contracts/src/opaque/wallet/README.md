# Wallet Contracts

> **The post-quantum account layer: a key registry, a validator, an ERC-4337 account and its factory.**

| Contract | Purpose |
|---|---|
| `ForsVerifier.sol` | Verifies FORS+C signatures with keccak only |
| `PQKeyRegistry.sol` | Each account's key commitment, next key, use count and rotation. Only the current PQ key can change it |
| `PQValidator.sol` | ERC-7579 validator: checks a UserOperation's signature against the registry |
| `PQAccount.sol` | The ERC-4337 v0.7 account users get on Arc |
| `PQAccountFactory.sol` | Deploys accounts at predictable addresses, so USDC can arrive before the account exists |
| `account/` | An account-bound variant used by `packages/pq-wallet`'s own demo; tested, not deployed |

Every signature digest keeps the same six fields as the TypeScript signer: domain, chain id, wallet address, scheme id, use counter and payload hash. No ECDSA key, owner or admin can rotate a registered key. The full write-up, with gas numbers, is [contracts/README.md](../../../README.md).
