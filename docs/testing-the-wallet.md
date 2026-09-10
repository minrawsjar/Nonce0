# Testing the wallet

The wallet at `frontend/app.html` is wired to the real protocol and settles
real private payments on Arc testnet. This is how to run it.

## What is real, and what is standing in

| | In this build |
|---|---|
| Pool | **Real.** `PrivatePool` + `AttestedRingVerifier` on Arc, RING_8 |
| Ring proof | **Real.** 219-rep ZKBoo, built in your browser; the note secret never leaves the page |
| Attestation | **Real.** FORS+C, verified on chain by `PQKeyRegistry` |
| Mesh | **Real onions, one operator.** Six relays on one machine collude by construction |
| CRE | **Simulated.** An ordinary process holds `INTENT_KEY`; nothing it opens is confidential |
| Credential authority | **Test.** Issues for any recipient |
| PQ account | **Real.** FORS keys in IndexedDB, an ERC-4337 account from `PQAccountFactory`; its deposits are UserOperations only its FORS key signs |
| Ring source | **Real deposits** from the pool's events, weighed by the subgraph's use counts and funding buckets |
| Relay health | **Real, one operator.** Reported on chain to `RelayDirectory`, indexed by the subgraph, clamped before it weighs a path |

The wallet shows this line at the bottom of the page, read from the pool and
the stack rather than hardcoded.

## Run it

Three terminals.

```bash
# 1 — the backend: six relays, the exit, the CRE stand-in, the egress
cd backend && set -a && . ./.env && set +a && node stack.ts

# 2 — the wallet
cd frontend && npx vite

# 3 — open it
open http://127.0.0.1:5173/app.html
```

`stack.ts` writes `frontend/public/stack.json` each time it starts. Reload the
wallet after restarting the stack.

## Pay someone

1. **A wallet on Arc testnet.** MetaMask: add network — chain id `5042002`,
   RPC `https://rpc.testnet.arc.io`, currency `USDC`. Get USDC from
   [faucet.circle.com](https://faucet.circle.com). It pays gas too, so nothing
   else needs funding.
2. **Deposit 1 USDC.** Approve exactly 1 USDC, then confirm the deposit. The
   deposit is public by design — it is the *spend* that is private. The note
   shows as spendable once the chain confirms it, never before.

   Or deposit from the **PQ account**. In *Account details*, press *Activate
   account*: the funding wallet pays to deploy it and gets no power over it.
   Then send the account a little over 1 USDC; *Receive* shows its address.
   From then on *Deposit* is a UserOperation the account's FORS key signs, a
   public bundler submits it, and no wallet popup appears. Each one uses one of
   the key's 32 signatures, shown under *Signing key*. The keys live in this
   browser only, so clearing site data loses the account.
3. **Send.** Enter a recipient and press *Send 1 USDC privately*. The page
   builds the proof (a few seconds, and the tab is busy while it does), seals
   it, and sends it across the mesh as ~35 chunks.
4. **Watch Activity.** It settles when the privacy score clears your threshold,
   or at the deadline. A *view settlement* link appears when it lands.

The console shows a stream of `404`s from `/v1/status/…` while a payment is in
flight. Those are the wallet polling for an answer that has not arrived yet.
They are deliberate: a relay that answered "exists, not ready" differently from
"no such drop" would tell anyone probing which drops are live.

## Run it without clicking

```bash
cd backend && set -a && . ./.env && set +a
node scripts/e2e-wallet-browser.ts      # drives the real page in headless Chrome
node chain/e2e-ring-payment.ts          # the same payment path, from Node
node chain/e2e-pq-account.ts            # a PQ account: deploy, fund, deposit by UserOperation
```

The first two spend a real seeded note and burn one attester index; the third
costs about 1.2 USDC. They are scripts you run on purpose, not tests that run
themselves. `E2E_PQ=1` (with `E2E_WALLET_KEY`) makes the browser run deposit
from the page's PQ account.

## Two budgets to watch

- **The attester's FORS key has 32 signatures.** Each settled payment uses one.
  The stack rotates to the next key when 4 are left, and an exhausted key
  hands over to its pre-committed successor. The registry refuses a 33rd
  signature rather than letting forgery odds climb.
- **Your account's FORS key has 32 too,** two of them held back for rotation
  and disable.
- **Seeded notes.** `backend/chain/seed-ring.ts` put 8 in the pool; the two
  e2e runs spent two of them. Deposit more, or seed more, to keep a full ring.

## Known gaps in this build

- `isNullifierSpent` is read directly from the RPC, which tells it which spend
  is yours. It should cross the mesh.
- The proof is built on the main thread, so the page freezes for a few seconds.
  It belongs in a Web Worker.
- Notes live in `localStorage`. Any script on the origin can read them, and
  clearing site data destroys them. See `frontend/src/lib/note-storage.ts`.
- The trust root comes from `stack.json` for local development. A real build
  must compile it in.
