# Arc: Private USDC Payments

> **Track:** Best DeFi/Onchain Finance Application, Arc

Opaque is a private payment system for USDC on Arc. Accounts are ERC-4337 smart accounts controlled by a post-quantum key. Deposits become fixed-size USDC notes in pools. A payment is released from a pool to its recipient only when the payer's conditions are met: a privacy score, a deadline and a recipient credential. Everything settles in USDC on Arc, and USDC pays the gas.

## What We Built

A conditional, multi-step payment flow for USDC that hides who paid.

```
Wallet: "Send 20 USDC to 0xabc…", wait for stronger privacy
  → Use a 20 USDC note the account deposited earlier (an attributable deposit)
  → Build a proof that the note is one of eight in the 20 USDC pool
  → Seal the payment and its conditions to a Chainlink CRE enclave
  → Condition check, every 30 s, in the enclave:
      pool privacy score ≥ the payer's minimum, or the deadline has come,
      and the recipient's credential verifies
  → Proof verified off chain, attester signs with a post-quantum key
  → Arc: the 20 USDC pool pays the recipient; the nullifier is spent
  → No sender is named at any step
```

## Circle Tools Used

### 1. Arc testnet

Every contract lives on Arc testnet, chain id 5042002: accounts, the key registry, seven pools, their verifiers and the relay directory. Arc's USDC gas means an account needs only one asset, so a new user funds the account with USDC and nothing else.

### 2. USDC

USDC is the only asset. Pools hold the ERC-20 interface at `0x3600000000000000000000000000000000000000` (6 decimals) in fixed notes of 1, 2, 5, 10, 20, 50 and 100 USDC. The fixed sizes are what make a note indistinguishable from the other seven in its ring. Gas is paid in native USDC (18 decimals), the same asset through its other interface.

### 3. CCTP V2

[`backend/chain/bridge-sepolia.ts`](../backend/chain/bridge-sepolia.ts) moves USDC from Ethereum Sepolia to Arc with a fast transfer. We used it to bring 2,000 USDC across for testing; 1,999.796 USDC arrived, a fee of about 1 basis point ([mint on Arc](https://testnet.arcscan.app/tx/0x915f269212309846818fd0cacc505a42e427fa5a7afc0776f14a417454f66dfd)).

```
approve + depositForBurn on Sepolia (domain 0 → Arc, domain 26)
  → maxFee: twice Circle's current quote; minFinalityThreshold: 1000
  → poll Circle's attestation API until the message is complete
  → receiveMessage on Arc: USDC minted to the same address
```

| Contract | Address |
|---|---|
| TokenMessengerV2 (Sepolia) | `0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa` |
| MessageTransmitterV2 (Arc) | `0xe737e5cebeeba77efe34d4aa090756590b1ce275` |
| USDC (Sepolia) | `0x1c7d4b196cb0c7b01d743fbc6116a902379c7238` |

### Not used, and why

- **Gateway** was in the design for sourcing a deposit from a unified cross-chain balance. It stays on the roadmap; the build uses CCTP instead.
- **Circle Wallets** hold keys that sign with elliptic curves. Opaque's whole point is an account no such key can move, so the account signs with its own FORS+C key.
- **App Kits** and **StableFX** were not needed for a single-asset payment flow.

## How We Meet the Criteria

### Meaningful use of Arc and USDC

The product is USDC payments on Arc, end to end. The account, the deposits, the pools, the payment and the gas are all USDC on Arc.

### Advanced programmable money flows

- **Conditional payments.** A payment waits until its pool's privacy score reaches the payer's minimum, or until the payer's deadline, and only if the recipient's credential verifies. The conditions are sealed so no server can change them.
- **Onchain automation.** The Chainlink CRE workflow evaluates every waiting payment every 30 seconds. The attester rotates its own post-quantum key on Arc when four signatures are left. The relays report their health to `RelayDirectory` every ten minutes.
- **Multi-step settlement.** Deposit, sealed intent, enclave decision, proof verification, post-quantum attestation, then the pool's release. Each step is checked by the next, and the pool checks all eight ring members are real deposits before it pays.

### Stablecoin-native design

Fixed USDC denominations are what the privacy rests on: a 20 USDC note is interchangeable with every other 20 USDC note. USDC gas lets the account pay for its own UserOperations, so the wallet needs no MetaMask and no second token.

## Architecture on Arc

```
┌──────────────────────────┐  UserOperation   ┌──────────────────────────────┐
│ PQ ACCOUNT (ERC-4337)    │ ───────────────▶ │ ENTRYPOINT v0.7              │
│ FORS+C key, 32 uses      │                  │ PQValidator checks FORS+C    │
└──────────────────────────┘                  │ against PQKeyRegistry        │
                                              └──────────────┬───────────────┘
                                                             │ deposit(commitment)
┌──────────────────────────┐                  ┌──────────────▼───────────────┐
│ EGRESS (executor)        │     spend()      │ PRIVATE POOL                 │
│ after a CRE release and  │ ───────────────▶ │ one per size, 1 to 100 USDC  │
│ an attester signature    │                  │ 8 real deposits, fresh       │
└──────────────────────────┘                  │ nullifier, pays recipient    │
                                              └──────────────┬───────────────┘
                                                             │ verify
                                              ┌──────────────▼───────────────┐
                                              │ ATTESTED RING VERIFIER       │
                                              │ attester's FORS+C signature, │
                                              │ live key, within its budget  │
                                              └──────────────────────────────┘
```

## Contract Addresses

All on Arc testnet. The full list, with deployment blocks, is [`deployments/arc-testnet.json`](../deployments/arc-testnet.json).

| Contract | Address |
|---|---|
| **PQKeyRegistry** | [`0x6eb5b42373191121d31dfc4b5c8571c4eaf58e8f`](https://testnet.arcscan.app/address/0x6eb5b42373191121d31dfc4b5c8571c4eaf58e8f) |
| **PQAccountFactory** | [`0x13beaec42922e3f63fa0dbe5bba270edf46ab214`](https://testnet.arcscan.app/address/0x13beaec42922e3f63fa0dbe5bba270edf46ab214) |
| **PQAccount** (implementation) | [`0xeccec6b1e6a2e5367902675c49e577633f705012`](https://testnet.arcscan.app/address/0xeccec6b1e6a2e5367902675c49e577633f705012) |
| **PQValidator** | [`0xfad5b4149489eaf9bbe402eca4b26f9284046ea2`](https://testnet.arcscan.app/address/0xfad5b4149489eaf9bbe402eca4b26f9284046ea2) |
| **RelayDirectory** | [`0xcf588b5b8ab2fa11ccf28a5c0631da4269a36653`](https://testnet.arcscan.app/address/0xcf588b5b8ab2fa11ccf28a5c0631da4269a36653) |
| **EntryPoint v0.7** | `0x0000000071727de22e5e9d8baf0edac6f37da032` |

## What We Learned Building on Arc

- **Two decimals for one asset.** Native USDC has 18 decimals and pays gas; the ERC-20 has 6 and is what the pools hold. Mixing them is a factor of 10¹², so every amount in the code carries its unit.
- **Log ranges.** The public RPC serves `eth_getLogs` over 20,000 blocks and refuses 50,000. The ring scanner pages in 10,000-block windows and only re-reads what is new.
- **Rate limits.** A burst of reads at boot hit the public RPC's limit and crash-looped the backend once. [`backend/chain/pool.ts`](../backend/chain/pool.ts) now falls back from Circle's RPC to QuickNode's and Blockdaemon's public endpoints.
- **Bundler.** The public RPC is not a bundler, so UserOperations go to Pimlico's keyless endpoint, which serves EntryPoint v0.7 on Arc.
- **Cost.** A dry run of the first deployment (registry, verifier, pool) came to about 0.17 USDC of gas. A relay health report costs about 0.0018 USDC.

## Source Code

| File | Purpose |
|---|---|
| [`contracts/src/opaque/pool/PrivatePool.sol`](../contracts/src/opaque/pool/PrivatePool.sol) | Note custody, one fixed denomination per pool |
| [`contracts/src/opaque/pool/AttestedRingVerifier.sol`](../contracts/src/opaque/pool/AttestedRingVerifier.sol) | Checks the ring, the nullifier and the attester's post-quantum signature |
| [`contracts/src/opaque/wallet/PQKeyRegistry.sol`](../contracts/src/opaque/wallet/PQKeyRegistry.sol) | Each account's FORS+C key and signature budget |
| [`contracts/src/opaque/wallet/PQAccount.sol`](../contracts/src/opaque/wallet/PQAccount.sol) | The ERC-4337 account |
| [`backend/chain/pq-wallet-chain.ts`](../backend/chain/pq-wallet-chain.ts) | Account deployment and UserOperations on Arc |
| [`backend/chain/pool.ts`](../backend/chain/pool.ts) | Pool client and the RPC fallback |
| [`backend/chain/bridge-sepolia.ts`](../backend/chain/bridge-sepolia.ts) | CCTP V2 from Sepolia |

## Product Feedback for Circle

### What worked well

- **USDC as gas** removed a whole onboarding step. The account is funded and paid for with the asset it exists to move.
- **CCTP V2 fast transfer** brought 2,000 USDC across for about 1 basis point, with one script and no bridge UI.
- **The three EntryPoints are already deployed** on Arc testnet, so we deployed no ERC-4337 infrastructure of our own.

### Suggestions

- **Publish the RPC limits.** We found the `eth_getLogs` range and the burst limit by hitting them. A documented limit, or a clearer error than `Request exceeds defined limit`, would save a crash loop.
- **A bundler on the public RPC**, or a documented recommended one for Arc testnet.
- **One page on the two USDC interfaces**, with the decimals side by side.

## Future Plans with Arc

1. **Arc mainnet**, once the attester's trust is reduced and the relays run under separate operators.
2. **Gateway at deposit time**, so a user can fund a note from a USDC balance on any chain.
3. **Recipient-side Gateway draws**, so a recipient on another chain gets USDC there after a private settlement.

## Why Opaque on Arc

Private payments need a stable unit, or the amount itself identifies the payment. They need cheap settlement, because every note is a transaction. And a post-quantum account needs gas it can pay for itself. USDC on Arc is all three.
