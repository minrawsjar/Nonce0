# The CRE recipient key — checked, not assumed

The V1 spec warns: *"do not invent unsupported provider key APIs. Verify the
chosen CRE input encryption path respects the V1 application-crypto constraint
before claiming it shipped."* This is that check.

## What the design assumed

`sealIntent` in the adapter barrel seals a complete spend — recipient, amount,
deadline, policy credential — to a CRE public key, **once per payment**. That is
*per-request payload encryption* to a provider-held key.

## What Chainlink CRE actually documents

| | |
|---|---|
| Confidential Workflows | **Private beta, enrolment required.** No public cryptographic specification: no named scheme, curve or algorithm |
| Vault DON secrets | Threshold encryption via Chainlink DKG, encrypted to a "Vault master public key" — scheme not documented publicly |
| Secrets CLI | `cre secrets create / update / delete / list`, from a YAML file of **static** secrets |
| Per-request payload encryption | **Not documented anywhere.** The secrets system is static configuration, not dynamic request sealing |
| Attestation | "DON consensus verifies attestations from the enclave" — TEE type and third-party verifiability unstated |

**So the assumption was wrong.** There is no supported API for a browser to
encrypt a fresh payload to a CRE enclave key per payment. Building against one
would have meant inventing it, which is exactly what the spec warned against.

## The path that does work, using only documented features

`runtime.getSecret({ id })` returns a secret's value to workflow code at
runtime, in both the Go and TypeScript SDKs. That is the whole hinge: a secret
can be *arbitrary bytes we choose*, not just an API key.

```
1. Generate an ML-KEM-768 keypair off-chain.
2. Store the SECRET key in the Vault DON as a static secret.
3. Publish the PUBLIC key in the versioned relay directory, signed by the same
   FORS+C chain that authenticates relay keys.
4. Clients seal each intent to that public key with ML-KEM-768 + HKDF-SHA-256 +
   AES-256-GCM — the primitives backend/mesh already uses.
5. The workflow calls getSecret() and decrypts inside the enclave.
```

Chainlink holds *a* key; it does not define our cryptography. Three consequences
worth stating plainly:

- **The application crypto stays post-quantum.** The intent is sealed with
  ML-KEM-768, so a harvested ciphertext is not a future decryption. If we had
  encrypted to the Vault master key directly, confidentiality would rest on an
  undocumented scheme that is very likely elliptic-curve — and a durable
  ciphertext that must stay secret forever is the exact risk shape this project
  exists to move away from.
- **The key gets an authenticated, versioned origin for free**, because it rides
  the directory the mesh already needs. Rotating it is a directory version bump.
- **It degrades honestly.** If the Vault DON is compromised, the intent payload
  is exposed — recipient and timing. It does *not* let anyone forge a spend:
  that path is the ring proof and the nullifier, and no enclave sits in it.

## The binding to declare

`ProtocolCapabilities.confidentialExecution` must read **`SIMULATED`** unless we
are actually enrolled in the Confidential Workflows beta and verifying
attestations. It is already a field in the frozen §2 contract; the requirement
is to populate it truthfully rather than aspirationally.

The README says the same thing in the same words, and it should keep saying it
until an attestation is actually being checked.

## Sources

- [Confidential Workflows in CRE](https://docs.chain.link/cre/concepts/confidential-workflows)
- [Secrets Management Commands](https://docs.chain.link/cre/reference/cli/secrets)
- [Using Secrets with Deployed Workflows](https://docs.chain.link/cre/guides/workflow/secrets/using-secrets-deployed)
- [SDK Reference: Core](https://docs.chain.link/cre/reference/sdk/core-ts)
- [Confidential API Interactions](https://docs.chain.link/cre/guides/workflow/using-confidential-http-client)
