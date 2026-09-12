# Frontend: Landing Page and Wallet

> **Vite and vanilla TypeScript. Deployed on Vercel at [opaque.credit](https://www.opaque.credit).**

Two pages from one build. The landing page explains the protocol. The wallet is the product: it holds a post-quantum account key and private notes in this browser, builds ring proofs in a Web Worker, seals payments to the Chainlink CRE enclave and talks to Arc only through the relay mesh. The same `app.html` ships as the Chrome extension's side panel.

## Pages

| File | URL | Purpose |
|---|---|---|
| `index.html` | [opaque.credit](https://www.opaque.credit) | Landing page: the problem, how it works, the threat model, the extension download |
| `app.html` | [opaque.credit/app.html](https://www.opaque.credit/app.html) | The wallet: deposit, send, privacy view, activity, backup |
| `public/privacy.html` | [opaque.credit/privacy.html](https://www.opaque.credit/privacy.html) | The extension's privacy policy |
| `public/opaque-extension.zip` | [opaque.credit/opaque-extension.zip](https://www.opaque.credit/opaque-extension.zip) | The extension for Developer-mode install, written by `extension/build.mjs` |

## Where the Wallet Gets Everything

Nothing in the wallet is simulated. [`src/lib/runtime.ts`](src/lib/runtime.ts) builds every piece from the stack's config:

| Piece | Source |
|---|---|
| **Relay keys** | The signed directory, walked from a trust root compiled into this build (`deployments/arc-testnet.json`), never a root from the network |
| **Ring** | A mesh query: members from the pool's own events, weights from The Graph |
| **Relay health** | A mesh query, clamped before use |
| **Proof** | Built here, in [`src/lib/prover.worker.ts`](src/lib/prover.worker.ts). The note secret never leaves the page |
| **Account and note reads** | WALLET_RPC through the mesh. No RPC or bundler learns which wallet asked |
| **Account** | FORS+C keys in IndexedDB; the account is deployed by `PQAccountFactory` on the first deposit |
| **Payment** | Sealed here to the CRE key, then chunked across the mesh |
| **Pools** | One per denomination, compiled in from `deployments/`. A server that could name the pools could take the deposits |

## Folder Structure

```
frontend/
├── index.html                  # Landing page
├── app.html                    # Wallet, and the extension's side panel
├── landing.css, app.css        # Page styles
├── styles.css, fonts.css       # Design tokens, and fonts served from this origin
├── src/
│   ├── landing.ts              # Scroll-driven intro and reveals (GSAP)
│   ├── app.ts                  # The wallet UI, every handler via addEventListener
│   └── lib/
│       ├── runtime.ts          #   Composition root: mesh, sealer, pools, account
│       ├── prover.ts           #   Runs the ring prover off the main thread
│       ├── prover.worker.ts    #   The Web Worker
│       ├── note-storage.ts     #   Notes in localStorage; no recovery without a backup
│       ├── backup.ts           #   Passphrase-encrypted backup and restore
│       ├── payment-lanes.ts    #   Several notes paid independently
│       ├── payment-deadline.ts #   "Wait for stronger privacy" deadlines
│       └── protocol/           #   Amount splitting into notes
├── public/                     # privacy.html, the extension zip, stack.json in dev
├── media/, fonts/              # Landing page imagery and type
├── vite.config.ts              # Two entries: index.html and app.html
└── vercel.json                 # Installs the sibling packages the wallet imports
```

`opaque/` and `src/opaque/` are the first static prototype and its adapter stub, kept for the record. The wallet does not use them.

## Two Rules the Wallet Keeps

The same bytes run as a hosted page and as a Manifest V3 extension, so:

- **No inline scripts or handlers.** Every handler is attached in `src/app.ts`. Breaking this gives a blank side panel, and `extension/build.mjs` refuses to build if it finds one.
- **Nothing is evaluated from a string.**

## Setup

From the repository root:

```bash
for d in packages/protocol-types packages/pq-wallet packages/ring-client graph backend frontend; do npm ci --prefix "$d"; done
cd frontend
```

### Against the hosted backend

```bash
VITE_STACK_URL=https://opaque-stack-production.up.railway.app/stack.json npm run dev
```

### Against a local stack

```bash
# terminal 1: writes frontend/public/stack.json
cd backend && set -a && . ./.env && set +a && node stack.ts

# terminal 2
cd frontend && npm run dev
```

Opens at [http://localhost:5173](http://localhost:5173). The landing page is `/`, the wallet `/app.html`.

### Build, test, extension

```bash
npm run build       # dist/, both pages
npm test            # 9 tests
npm run typecheck
npm run ext         # the extension, see ../extension/README.md
```

## Deployment

Vercel builds `frontend/` with `VITE_STACK_URL` set for production and preview. [`vercel.json`](vercel.json) installs `packages/*`, `graph` and `backend` first, because the wallet imports the mesh, the sealer and the ring client from their own packages rather than copying them.

## Tech Stack

| Technology | Purpose |
|---|---|
| **Vite** | Dev server and build, two entries |
| **TypeScript** | Strict, no framework |
| **GSAP** | Landing page scroll animation |
| **Web Workers** | The ring prover |
| **IndexedDB, localStorage** | Account keys, and notes |
| **Vercel** | Hosting |
