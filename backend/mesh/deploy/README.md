# Relay Deploy: Running Your Own Relay

> **One relay per host, in Docker, behind a reverse proxy that keeps no logs.**

The mesh has six relays, and each payment draws three of them fresh, so no two payments share a route. Picking three out of three would leave the Graph's weights nothing to decide.

This directory runs one relay on a host you control. One operator running all six on separate hosts is covered in [docs/hosting.md](../../../docs/hosting.md). Six independent operators is the part no script can do: six containers on one host share a machine, a network and a log, so they collude by construction, whatever operator ids the directory gives them.

## What an Operator Needs

| File | Where it comes from | Secret? |
|---|---|---|
| `directory.json` | The signed relay directory, published by whoever holds the signing key | No |
| `trust-root.json` | The pinned root, shipped with clients | No |
| `<ID>.key` | Generated **on this machine**, never sent anywhere | **Yes** |

The relay checks `directory.json` against `trust-root.json` at startup and refuses to run if it does not verify. A tampered directory is a failure to boot, not a mesh quietly encrypted to someone else's keys.

## Folder Structure

```
backend/mesh/deploy/
├── Dockerfile        # The opaque-relay image; contains no keys
├── compose.yaml      # One relay, with its config mounted read-only
└── make-config.ts    # Generates a directory, a trust root and relay keys
```

## Generate This Relay's Key

```bash
node -e "import('./backend/mesh/transport.ts').then(m => {
  const k = m.generateRelayKeypair(1n);
  process.stderr.write(k.secretKey + '\n');   // -> R1.key, 0600, never leaves
  process.stdout.write(k.publicKey + '\n');   // -> send this to the directory signer
})" 2> /config/R1.key
chmod 600 /config/R1.key
```

The public half goes to whoever signs the directory. The secret half stays on this box. If it is ever emailed, pasted or committed, that relay is a wiretap with a hostname, and it must be rotated out with a new directory version.

## Run

```bash
docker build -f backend/mesh/deploy/Dockerfile -t opaque-relay .
docker run -d --name opaque-relay \
  -p 8080:8080 \
  -v "$PWD/config:/config:ro" \
  opaque-relay \
  --id R1 --secret-key-file /config/R1.key \
  --egress-query https://your-graph-endpoint/query
```

`--egress-payment` and `--egress-query` are an allowlist, one entry per message kind. Leave a kind out and this relay refuses to carry it, which is a legitimate operator policy. A client can never name a destination.

## Before You Expose It

**A reverse proxy in front of the relay can undo the mesh without touching its code.** The relay logs nothing: not a peer, not an id, not on the error path. An nginx access log that writes `X-Forwarded-For` next to a request id rebuilds exactly the client-to-payload link that three hops exist to prevent.

```nginx
access_log off;
error_log /dev/null crit;
```

If you must keep logs, drop the address and the request id and keep them for hours, not days. The same goes for any cloud load balancer: most record both by default.

## Health

`GET /v1/status/<32 hex chars>` returns 404 for an unknown drop. That is a usable liveness probe and reveals nothing. There is deliberately no `/health` carrying queue depth or uptime, because queue depth is a readout of the traffic the batching exists to hide.

```yaml
healthcheck:
  test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/v1/status/00000000000000000000000000000000"]
```

## What Still Needs People

Six hosts under six different operators, and the directory signed once all six public keys exist. Everything above is reproducible; that part is coordination, not code.
