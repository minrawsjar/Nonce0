# Testing the wallet

The wallet at `frontend/app.html` is wired to the real protocol and settles
real private payments on Arc testnet. This is how to run it.

## What is real, and what is standing in

| | In this build |
|---|---|
| Pool | **Real.** `PrivatePool` + `AttestedRingVerifier` on Arc, RING_8 |
| Ring proof | **Real.** 219-rep ZKBoo, built in your browser; the note secret never leaves the page |
| Attestation | **Real.** FORS+C, verified on chain by `PQKeyRegistry` |
| Mesh | **Real onions, one operator.** Six relays on one machine collude by construction. The directory's trust root is compiled into the wallet |
| CRE | **Simulated.** An ordinary process holds `INTENT_KEY`; nothing it opens is confidential |
| Credential authority | **Test.** Issues for any recipient |
| PQ account | **Real.** FORS keys in IndexedDB, an ERC-4337 account from `PQAccountFactory`. Its deposits and withdrawals are UserOperations only its FORS key signs, sent to the bundler through the mesh |
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

## What the page never sends directly

Every read that names your account or a note, and every UserOperation, goes
through the mesh as a `WALLET_RPC` query. The exit answers it against a strict
allowlist (`backend/chain/wallet-rpc.ts`). Neither the RPC nor the bundler
learns which wallet asked, and nobody learns which nullifier is yours before
it is spent. What still goes direct:

- **Pool-wide reads** that name nothing of yours, such as `capabilities()`.
- **Funding-wallet transactions**: deploy, rotate, and deposits from the
  funding wallet. They name that wallet on chain whatever route they take.

## Your account's controls

Under *Account details* and *Signing key*:

- **Rotate key.** Promotes the pre-committed next key, which starts with a
  fresh budget of 32, and commits another. The funding wallet pays for the
  transaction. Two signatures are held back so a key can always rotate.
- **Withdraw.** Sends everything the account holds, less the gas for the
  withdrawal itself, to your funding wallet or any address you type. A few
  cents of prepaid gas stay with the EntryPoint and pay for the account's
  next operation.
- **Backup / Restore.** One file holds the account's keys, with their signing
  logs, and your private notes, encrypted under a passphrase (PBKDF2, then
  AES-GCM). Restore writes into a fresh key store and never overwrites one.
  - A backup older than the account's chain state restores, but the wallet
    then refuses to sign with it: its signing log is behind, and signing
    could reuse an index.
  - Use a backup on one device at a time.

## Known gaps in this build

- Notes live in `localStorage`. Any script on the origin can read them, and
  clearing site data destroys them unless you took a backup.
  See `frontend/src/lib/note-storage.ts`.
- CRE is simulated: an ordinary process on the Railway box holds the key that
  opens sealed payments. It moves into a Chainlink enclave once deploy access
  is granted.
