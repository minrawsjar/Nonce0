# Hosting it: six relays, one operator

## Quickest: Railway, one service

The whole stack runs as one Railway service: six relays, the exit, the CRE
stand-in, the egress and the credential authority. `railway.json` builds
`backend/deploy/stack.Dockerfile`, and every public route is served on
Railway's one port.

1. **New project.** Railway → New Project → Deploy from GitHub repo → this
   repo.
2. **Variables.** Add `EGRESS_PRIVATE_KEY` and `ATTESTER_FORS_SEED`, copied
   from `backend/.env`, in the service's Variables → Raw Editor. Nothing else
   is needed.
3. **Domain.** Settings → Networking → Generate Domain, then redeploy.
   `PUBLIC_URL` is taken from `RAILWAY_PUBLIC_DOMAIN` automatically.
4. **The wallet.** On Vercel, set
   `VITE_STACK_URL=https://<that domain>/stack.json` and redeploy.

Check it: `https://<domain>/stack.json` returns the config.

Things to know:

- **Each redeploy is a new mesh.** You get new relay keys, a new CRE key and a
  new directory. Payments still in flight are lost; a wallet picks up the new
  config on reload.
- **The directory lasts 7 days**, so redeploy at least weekly.
- **Keep `numReplicas` at 1.** There is one attester key, and two copies of
  the stack could sign with it at the same index.
- **Railway logs requests at its own edge,** so on Railway it sees what you
  see.

Six relays across six Railway services buy nothing over one: a single
provider still sees every hop. Six hosts only help on six different
providers, as below.

## Six hosts

Seven machines, all yours: six relays and one backend. The wallet stays on
Vercel.

| Machine | Runs | Holds |
|---|---|---|
| `r1` … `r6` | the `opaque-relay` image, behind Caddy | one relay key each |
| `api` | `backend/stack.ts`, behind Caddy | the egress key, the attester seed, the CRE intent key |
| Vercel | `frontend/` | nothing |

## What one operator costs

What still holds:

- Recipients and amounts are sealed to the CRE key, so no relay can read them.
- The ring hides which of the eight deposits paid.
- An outsider watching any one host or provider still can't tell who sent what.

What goes: **you** can. You run every hop and the egress, so you could link a
wallet's IP address to its settlement. The wallet says so, in its footer:
`mesh: six relays, one operator`.

Put the six on different providers or regions. Then no single provider, and no
single seized machine, sees a whole path. One box (`PUBLIC_URL` alone, no
`MESH_CONFIG`) also works, for a demo.

## 1. Names

You need seven HTTPS names, e.g. `api.example.com` and `r1.example.com` …
`r6.example.com`. With no domain, `203-0-113-7.sslip.io` resolves to
`203.0.113.7` and Caddy can still get a certificate for it. Open ports 80 and
443 only.

## 2. The relay config, generated once on your laptop

```bash
cd backend
RELAY_URLS=https://r1.example.com,https://r2.example.com,https://r3.example.com,https://r4.example.com,https://r5.example.com,https://r6.example.com \
  node mesh/deploy/make-config.ts
```

This writes `mesh/deploy/config/`: `directory.json`, `trust-root.json` and
`R1.key` … `R6.key`.

- **Host `rN`** gets `directory.json`, `trust-root.json` and **only `RN.key`**.
- **`api`** gets `directory.json` and `trust-root.json`, no keys.

Delete the `.key` files locally once they're copied. A relay key that leaks
means that relay's layer can be decrypted.

**The directory expires 7 days after you generate it.** Relays and the wallet
refuse an expired one. Re-run this step, re-copy the files, and restart
everything.

## 3. Each relay host (`rN`)

Docker and Caddy, then:

```bash
git clone <this repo> opaque && cd opaque
docker build -f backend/mesh/deploy/Dockerfile -t opaque-relay .

# ~/opaque-config holds directory.json, trust-root.json and RN.key.
# The container runs as uid 100, not root, and the key is 0600.
sudo chown 100 ~/opaque-config/RN.key && chmod 600 ~/opaque-config/RN.key

docker run -d --restart unless-stopped --name opaque-relay \
  -p 127.0.0.1:8080:8080 -v ~/opaque-config:/config:ro opaque-relay \
  --id RN --secret-key-file /config/RN.key \
  --egress-payment https://api.example.com/v1/mesh/payment \
  --egress-query   https://api.example.com/v1/mesh/query
```

Replace `RN` with this host's id. Then `/etc/caddy/Caddyfile`:

```
rN.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

`sudo systemctl reload caddy`. **Do not add a `log` directive.** An access log
of client address beside request is the one record the relays exist not to
keep. The image contains no keys (`.dockerignore`); the key is mounted.

Check it: `curl https://rN.example.com/v1/status/00000000000000000000000000000000`
answers 404. That is the liveness probe; there is no `/health`.

## 4. The backend (`api`)

Node 22.18 or later, then:

```bash
git clone <this repo> opaque && cd opaque
for d in packages/protocol-types packages/pq-wallet packages/ring-client graph backend; do npm ci --omit=dev --prefix "$d"; done
```

Copy `backend/.env` over with `scp`; never paste it. Put `directory.json` and
`trust-root.json` into `backend/mesh/deploy/config/`. Then:

```bash
cd backend && set -a && . ./.env && set +a
PUBLIC_URL=https://api.example.com MESH_CONFIG=mesh/deploy/config node stack.ts
```

And Caddy, from the repo root:

```bash
MESH_DOMAIN=api.example.com caddy run --config backend/deploy/Caddyfile
```

This exposes the exit (`/v1/mesh/*`, which the relays post to), the credential
authority and `/stack.json`. Everything binds to loopback, and the egress, the
one piece that signs, is never routed. Run both under systemd, `tmux` or
similar, so they survive a logout.

Before a public box holds it: `EGRESS_PRIVATE_KEY` is still the deployer key.
Give the egress its own key, funded with a little USDC for gas.

## 5. The wallet (Vercel)

Set `VITE_STACK_URL=https://api.example.com/stack.json` in the project's
environment variables and redeploy. `frontend/vercel.json` installs the
directories the wallet imports from.

`stack.json` carries the directory's trust root. Fetching it over TLS from a
box you run is fine for testnet. A production build compiles the root in, so
that whoever controls the server cannot choose it.

## Budgets

- **Attester signatures: 32 in all.** `PQKeyRegistry` refuses the 33rd. Rotate
  before then.
- **Seeded test notes.** Each test payment spends one.
