# Project X V1 interfaces

This file is the repository-native implementation contract. The full owner plan is in `../output/pdf/project-x-v1-team-handoff.pdf`.

## Payment scheduling

```text
fire = complianceApproved && (
  privacyScore >= minPrivacyScore || now >= deadline
)
```

Immediate execution uses `deadline = now`. This is the same path as privacy-timed execution, not a second payment flow.

## Ownership handoff

| Export | Producer | Consumers |
|---|---|---|
| `PqWallet` | Manan | Manya, Swarnim |
| `RingClient`, `PrivatePoolContract` | Aditya | Swarnim, Manya |
| `GraphSelectionClient` | Aditya | Swarnim, Manya |
| `PrivacyTransport`, `PrivacyTimedExecutor` | Swarnim | Manya |
| `createProtocolAdapters` | Manya + Swarnim | frontend pages |

## Sensitive data boundaries

- Browser only: wallet secret, note secret, proof witness.
- CRE TEE only at execution: encrypted complete spend, recipient, policy credential.
- Relay only: opaque encrypted envelope.
- Graph: public eligible commitments and aggregate metrics only.
- Pool: commitments, nullifiers, ring/proof, public recipient/denomination at settlement.
