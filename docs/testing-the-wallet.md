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
2. **Deposit.** Set *Deposit amount* in whole USDC and press *Deposit*. It
   becomes the fewest notes of 1, 2, 5, 10, 20, 50 and 100 USDC: 123 is
   100 + 20 + 2 + 1.
   Each size has its own pool, because a ring is formed only among notes of
   one size (spec §6.6), and a pool fills from anyone's deposits. A note can
   be sent once its pool holds 8; the field says when part of a deposit will
   wait for that, and the balance shows how much is waiting.

   Deposits come from your **PQ account**, as one UserOperation its FORS key
   signs however many notes and pools it covers; a public bundler submits it.
   The first one also deploys the account. It is paid from USDC at the
   account's address: anything sent to the *Receive* address counts, and a
   funding wallet, if the browser has one, tops it up in one confirmation.
   Each deposit keeps 0.2 USDC in the account for gas, and what gas does not
   use pays for the next one. Each deposit uses one of the key's 32
   signatures, shown under *Signing key*. The keys live in this browser only,
   so clearing site data loses the account, unless you have a backup.

   The deposit is public by design — it is the *spend* that is private. A
   note shows as spendable once the chain confirms it, never before.
3. **Send.** Set the amount in whole USDC, enter a recipient, and press
   *Review private transfer*. It is paid with the fewest of your notes that
   make it exactly, one payment each, so 100 USDC is one payment and 123 is
   four. A note is spent whole, with no change: holding one 100-USDC note, you
   can send 100 but not 30. Each payment's proof is built in a worker (a few
   seconds), sealed, and sent across the mesh as ~35 chunks. Several to one
   address are easier to link to each other than one. Amounts like 2.37 are
   not possible: hiding them needs elliptic-curve range proofs, which this
   design rules out.
4. **Watch Activity.** A payment usually settles within seconds. It goes as
   soon as the privacy score (the lower of pool coverage and relay health)
   reaches 70/100, and waits only while the relays look unhealthy or their
   health is unknown — for an hour at most, then it goes anyway. The wallet
   sets both; there is nothing to tune. A *view settlement* link appears when
   it lands.

The network tab shows a stream of `204`s from `/v1/status/…` while a payment is
in flight. Those are the wallet polling for an answer that has not arrived yet.
A relay gives the same empty `204` for "not yet", "no such drop" and "already
collected": answering them differently would tell anyone probing which drops
are live.

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

The page opens no connection to an RPC, a bundler, the subgraph or a font CDN. Every read
it makes, and every UserOperation, goes through the mesh as a `WALLET_RPC`
query. The exit answers it against a strict allowlist
(`backend/chain/wallet-rpc.ts`). Neither the RPC nor the bundler learns which
wallet asked, and nobody learns which nullifier is yours before it is spent.
The browser e2e fails if the page sends any such request itself.

The one exception is the **funding wallet**: deposits made before activation,
and a disable. Those transactions, and the reads they need, go through the
wallet's own provider (MetaMask's RPC). They name that wallet on chain
whatever route they take. A content blocker that blocks `rpc.testnet.arc.io`
in the page no longer breaks anything.

## Your account's controls

Under *Account details* and *Signing key*:

- **Key rotation.** Automatic, with nothing to press. Once a quarter of the
  budget is left the wallet signs a rotation with the current key and the mesh
  exit submits it and pays for it, promoting the pre-committed next key, which
  starts with a fresh budget of 32, and committing another. Two signatures are
  held back so a key can always afford to rotate. The account cannot pay for
  this itself: a UserOperation spends a signature while it validates, so a
  rotation carried inside one would be signed for the wrong use count.
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
