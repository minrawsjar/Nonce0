# Aditya - Graph data products

`schema.graphql` is the public data boundary. Index eligible note commitments and aggregate pool/relay metrics only. Never index a real signer position or payment-to-decoy mapping.

Publish three frontend-facing queries:

- `selectRing(realCommitment, denomination)` returns an eight-member canonical ring and safe reasons.
- `selectPath()` returns three distinct eligible relays drawn from the Markov policy.
- `getPrivacyConditions()` returns the live privacy score used by CRE's threshold/deadline trigger.
