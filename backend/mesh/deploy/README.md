# Running a relay

Six relays, six operators, six networks — and three hops per payment. The pool
and the path are different numbers on purpose: a payment travels three hops,
but it draws those three fresh from six, so no two payments share a route. Pick
three out of three and the graph feed's ranking decides nothing.

One operator on six hosts is set up in [docs/hosting.md](../../../docs/hosting.md).

Six operators is the part this directory cannot do for you. Six containers on
one host share a machine, a network and a log, so they collude by construction
no matter what the directory says about their operator ids — and six colluding
relays learn exactly what three would.

## What an operator needs

| File | Where it comes from | Secret? |
|---|---|---|
| `directory.json` | The signed relay directory, published by whoever holds the signing key | no |
| `trust-root.json` | The pinned root, shipped with clients | no |
| `<ID>.key` | Generated **on this machine**, never sent anywhere | **yes** |

The relay verifies `directory.json` against `trust-root.json` at startup and
refuses to run if it does not check out, so a tampered directory is a failure
to boot rather than a mesh quietly encrypted to someone else's keys.

## Generating this relay's key

```bash
node -e "import('./backend/mesh/transport.ts').then(m => {
  const k = m.generateRelayKeypair(1n);
  process.stderr.write(k.secretKey + '\n');   // -> R1.key, 0600, never leaves
  process.stdout.write(k.publicKey + '\n');   // -> send this to the directory signer
})" 2> /config/R1.key
chmod 600 /config/R1.key
```

The public half goes to whoever signs the directory. The secret half stays on
this box. If it is ever emailed, pasted, or committed, that relay is a wiretap
with a hostname and must be rotated out with a new directory version.

## Running

```bash
docker build -f backend/mesh/deploy/Dockerfile -t opaque-relay .
docker run -d --name opaque-relay \
  -p 8080:8080 \
  -v "$PWD/config:/config:ro" \
  opaque-relay \
  --id R1 --secret-key-file /config/R1.key \
  --egress-query https://your-graph-endpoint/query
```

`--egress-payment` and `--egress-query` are an allowlist, one entry per message
kind. Omit a kind and this relay refuses to carry it, which is a legitimate
operator policy. A client can never name a destination.

## Before you expose it

**A reverse proxy in front of this can undo the mesh without touching its
code.** The relay logs nothing — not a peer, not an id, not on the error path.
An nginx access log writing `X-Forwarded-For` beside a request id rebuilds
exactly the client-to-payload association three hops exist to prevent.

```nginx
access_log off;
error_log /dev/null crit;
```

If you must keep logs, drop the address and the request id, and bound retention
to hours. Same for any cloud load balancer: check what it records by default,
because most record both.

## Health

`GET /v1/status/<32 hex chars>` returns 404 for an unknown drop, which is a
usable liveness probe and reveals nothing. There is deliberately no `/health`
endpoint carrying queue depth or uptime: queue depth is a readout of the
traffic the batching exists to hide.

```yaml
healthcheck:
  test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/v1/status/00000000000000000000000000000000"]
```

## What still needs a human

Three hosts under three different operators, and the directory signed once all
three public keys exist. Everything above is reproducible; that part is a
coordination problem, not a build problem.
