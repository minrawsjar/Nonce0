# Mesh wire protocol — V1

Three hops, onion-encrypted, post-quantum. This document is the contract a
relay implements; `transport.ts` is the reference implementation and its tests
are the acceptance criteria.

Scope: this hides the association between a client IP and a payload from a
*limited relay-observation* adversary. It does not defend against a global
passive observer, all-hop collusion, or a compromised browser.

## Cryptography

| Layer | Primitive |
|---|---|
| Per-hop key agreement | ML-KEM-768 (encapsulate to the hop's directory key) |
| Key derivation | HKDF-SHA-256, salt = that hop's `hopLocalId`, info = `projectx/v1/mesh/hop-key` |
| Layer encryption | AES-256-GCM, 12-byte nonce, header as AAD |

No X25519, no ECDH, no elliptic curve anywhere in this path — a V1 hard
constraint. ML-KEM is not available in Node 22's `crypto` (verified:
`generateKeyPairSync('ml-kem768')` throws `ERR_INVALID_ARG_VALUE` even against
OpenSSL 3.6.3) and browsers have none at all, so both ends use
`@noble/post-quantum`. The client builds its own onion, so if the two sides
used different implementations they would disagree on bytes.

## Frame

Fixed-layout binary, big-endian. An earlier draft nested JSON carrying
hex-encoded inner layers; hex doubles and JSON adds more, so three hops turned
a 64 KiB payload into roughly 500 KiB.

```
offset  size  field
     0     1  frame version (currently 1)
     1    16  hopLocalId          — unique to THIS hop
    17    32  hopId               — utf8, zero-padded
    49     8  keyEpoch            — u64
    57     8  expiresAt           — u64, unix seconds
    65     4  ciphertextLength    — u32
    69  1088  ML-KEM-768 ciphertext
  1157    12  AEAD nonce
  1169     n  AES-256-GCM ciphertext ‖ 16-byte tag
```

Bytes 0–68 are the AAD. Every routing field is therefore authenticated: a relay
that rewrites the expiry to resurrect a dead message, or the `hopId` to
redirect one, invalidates the tag.

`LAYER_OVERHEAD` = 69 + 1088 + 12 + 16 = **1185 bytes**.

## Four properties, and how each is enforced

**1. No end-to-end identifier.** Every layer carries its own random 16-byte
`hopLocalId`. Three relays comparing logs find no common key, so they cannot
join their observations into a path. This is the linkage three hops exist to
prevent, and a single message id threaded through all of them would hand it
over for free.

**2. The message kind is invisible until the last hop.** `PAYMENT` / `QUERY`
lives in the innermost plaintext only. Putting it in the outer header — as the
first draft did — lets any relay or on-path observer separate payments from
queries with one field read, and the argument that query traffic covers payment
traffic collapses. Hops 1 and 2 see an opaque frame and a next-hop id.

**3. Padding classes.** Only the innermost plaintext is padded, to 4 KiB, 16
KiB or 64 KiB. Because every layer is fixed-width, the size at each depth is
then a constant: hop 3 receives `class + 1×OVERHEAD`, hop 2 `class + 2×`, hop 1
`class + 3×`. A payment and a query at the same class are byte-identical at
every hop. The default is the largest class, because using a smaller one for
queries would re-separate them by size.

> **Disclosed limitation.** Sizes differ *between* depths, so an observer
> watching one relay can tell a first hop from a third. Removing that needs a
> constant-size construction (Sphinx-style header shifting with hop-side
> re-padding), which V1 does not attempt — a packet cannot nest inside itself
> at constant size. Bounded delay is not a traffic-analysis proof either.
> Timing correlation remains a disclosed limitation.

**4. Validate before queueing.** Version, intended hop, key epoch, expiry and
replay are all checked before a message occupies a batch slot, so a malformed
or replayed packet cannot consume queue capacity.

## Directory and key epochs

Relay identity, operator identity, endpoint, ML-KEM public key, key epoch and
validity window come from a versioned directory pinned in application
configuration. Updates authenticate against the pinned trust root — **an
untrusted Graph response can never replace a key**, which is also why the mesh
must bootstrap before the first Graph query rather than after it.

A layer sealed to a superseded epoch is rejected with `UNTRUSTED_DIRECTORY`
rather than attempted, so a stale client fails loudly instead of leaking a
retry pattern.

## Replay

Each hop keeps a bounded, expiry-aware set of `hopLocalId`s whose lifetime
survives a restart. Under pressure it evicts only entries that have already
expired; if none have, it returns a retryable `MESH_UNAVAILABLE` rather than
forgetting a live id. Dropping live entries to make room would silently reopen
the replay window exactly when the mesh is busiest.

## Egress

The final hop resolves a *named operation* through an allowlist map. It never
accepts a URL from the payload and never follows a redirect — an allowlist that
a redirect can walk out of is not an allowlist.

`POST /v1/relay` returns only a hop-local acknowledgement.
`GET /v1/status/:id` is internal, requires a private capability, and is reachable
by users only through an encrypted `QUERY`; there is no public
intent-to-transaction lookup.

Transport `SUBMITTED` means a broadcast was attempted. It does not mean settled.

## Logging

| Allowed | Forbidden |
|---|---|
| hop-local id, hop id, coarse queue timestamp, status | plaintext, source-IP↔payload association, note secret, proof witness, recipient policy data, AEAD key |

Retention is bounded, and infrastructure and proxy logs obey the same rule —
a reverse proxy writing `X-Forwarded-For` next to a request id undoes property
1 without touching this code.

## What the mesh is not

It does not verify proofs, hold funds, or authorise anything. A compromised
relay cannot forge or approve a spend; at worst it can decline to forward, or
contribute to deanonymising a network origin if enough hops collude.
